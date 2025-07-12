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

def login():
    """Log into the qBittorrent Web API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    return r.ok

def get_torrents():
    """Fetch the list of all torrents from qBittorrent."""
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
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
                # Key exists but has no TTL, so set one now
                rdb.expire(key, TTL_HOURS * 3600)
            elif ttl <= 0:
                # Key has expired, meaning torrent has been in state > TTL
                return True
        else:
            # First time seeing this torrent in a stale state
            rdb.setex(key, TTL_HOURS * 3600, datetime.utcnow().isoformat())
    else:
        # Torrent is active or downloading; reset any stored state
        rdb.delete(key)
    return False

def delete_torrent(torrent_hash):
    """Delete the torrent and its files from qBittorrent."""
    print(f"Deleting torrent {torrent_hash} and its files")
    r = session.post(
        f"{QB_URL}/api/v2/torrents/delete",
        data={"hashes": torrent_hash, "deleteFiles": "true"},
    )
    return r.ok

def run():
    """Main routine that checks torrents and deletes stale ones."""
    if not login():
        print("Login failed")
        return

    torrents = get_torrents()
    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        if should_delete(torrent_hash, status):
            print(f"[{datetime.now()}] Removing {name} ({status})")
            delete_torrent(torrent_hash)

# Loop the process every CHECK_INTERVAL seconds
if __name__ == "__main__":
    while True:
        try:
            run()
        except Exception as e:
            print("Error:", e)
        time.sleep(CHECK_INTERVAL)
