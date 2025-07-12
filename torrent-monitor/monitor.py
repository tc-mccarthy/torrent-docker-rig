import os
import time
import requests
import redis
from datetime import datetime, timedelta

# Load environment variables
QB_URL = os.getenv("QB_API_URL")                 # qBittorrent Web API base URL
QB_USER = os.getenv("QB_USERNAME")               # Username for qBittorrent
QB_PASS = os.getenv("QB_PASSWORD")               # Password for qBittorrent
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
TTL_HOURS = 24                                   # Time to live for inactivity tracking
CHECK_INTERVAL = 60 * 30                         # Run every 30 minutes

# Create session for qBittorrent and Redis client
session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

def log(message):
    """Print log message with timestamp."""
    print(f"[{datetime.utcnow().isoformat()}] {message}", flush=True)

def login():
    """Log into the qBittorrent Web API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login to qBittorrent successful.")
    else:
        log("Login to qBittorrent failed.")
    return r.ok

def get_torrents():
    """Fetch the list of all torrents from qBittorrent."""
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        log(f"Fetched {len(r.json())} torrents.")
    else:
        log("Failed to fetch torrents.")
    return r.json() if r.ok else []

def should_delete(torrent_hash, status):
    """
    Determine whether the torrent should be deleted.
    If a torrent has been in a non-active state for 24 hours, it should be removed.
    Redis stores the first time the torrent was seen in an undesirable state.
    """
    key = f"torrent:{torrent_hash}"
    track_states = ["uploading", "stalledUP", "stalledDL", "pausedUP", "queuedUP", "completed"]

    if status in track_states:
        if rdb.exists(key):
            ttl = rdb.ttl(key)
            if ttl == -1:
                rdb.expire(key, TTL_HOURS * 3600)
                log(f"Set TTL for {torrent_hash} ({status})")
            elif ttl <= 0:
                log(f"{torrent_hash} ({status}) has exceeded TTL. Marked for deletion.")
                return True
        else:
            rdb.setex(key, TTL_HOURS * 3600, datetime.utcnow().isoformat())
            log(f"Tracking {torrent_hash} ({status}) for inactivity.")
    else:
        if rdb.exists(key):
            rdb.delete(key)
            log(f"Removed {torrent_hash} from Redis tracking (status: {status})")
    return False

def delete_torrent(torrent_hash):
    """Delete the torrent and its files from qBittorrent."""
    log(f"Deleting torrent {torrent_hash} and its files")
    r = session.post(
        f"{QB_URL}/api/v2/torrents/delete",
        data={"hashes": torrent_hash, "deleteFiles": "true"},
    )
    if r.ok:
        log(f"Successfully deleted {torrent_hash}")
    else:
        log(f"Failed to delete {torrent_hash}")
    return r.ok

def run():
    """Main routine that checks torrents and deletes stale ones."""
    log("Starting torrent monitor run...")
    if not login():
        return

    torrents = get_torrents()
    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        if should_delete(torrent_hash, status):
            log(f"Removing {name} ({torrent_hash}) due to stale status: {status}")
            delete_torrent(torrent_hash)
    log("Torrent monitor run complete.")

# Loop the process every CHECK_INTERVAL seconds
if __name__ == "__main__":
    while True:
        try:
            run()
        except Exception as e:
            log(f"Unexpected error: {e}")
        time.sleep(CHECK_INTERVAL)
