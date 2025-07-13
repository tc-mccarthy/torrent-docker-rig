import os
import time
import requests
import redis
from datetime import datetime, timedelta

# === Configuration ===

# Environment variables for API access and Redis configuration
QB_URL = os.getenv("QB_API_URL")
QB_USER = os.getenv("QB_USERNAME")
QB_PASS = os.getenv("QB_PASSWORD")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))

# Interval to check qBittorrent (in seconds)
CHECK_INTERVAL = 60 * 30  # 30 minutes

# Redis key versioning to support future changes
KEY_VERSION = "torrent_monitor_20250712b"

# Deletion tracking windows
DELETION_THRESHOLD_SECONDS = 24 * 3600  # 24 hours
REDIS_KEY_EXPIRATION_SECONDS = 26 * 3600  # key expires after 26 hours

# Track these states
TRACKED_STATES = [
    "uploading", "stalledUP", "stalledDL", "pausedUP", "queuedUP", "completed"
]

# === Setup ===

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)


def log(message):
    """Print a timestamped log message using local time."""
    local_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{local_time}] {message}", flush=True)


def get_cache_key(torrent_hash):
    """Return a namespaced Redis key."""
    return f"torrent:{KEY_VERSION}:{torrent_hash}"


def login():
    """Log into qBittorrent Web API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok


def get_torrents():
    """Fetch the current list of torrents."""
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        torrents = r.json()
        log(f"Fetched {len(torrents)} torrents.")
        return torrents
    else:
        log("Failed to fetch torrents.")
        return []


def should_delete(torrent_hash, status):
    """
    Determine whether to delete the torrent.
    If the torrent enters a tracked state:
      - Create a Redis key with expiry timestamp (24h from now) if one doesn't exist.
      - If the timestamp is in the past, mark for deletion and delete the key.
    If the torrent leaves the tracked state:
      - Remove the key if it exists.
    """
    now = int(time.time())
    key = get_cache_key(torrent_hash)

    if status in TRACKED_STATES:
        expires_at_raw = rdb.get(key)

        if expires_at_raw is None:
            # Start tracking: set deletion time 24 hours from now
            expires_at = now + DELETION_THRESHOLD_SECONDS
            rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(expires_at))
            exp_local = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M:%S")
            log(f"Started tracking {torrent_hash} in state '{status}'; expires at {exp_local}")
            return False

        else:
            try:
                expires_at = int(expires_at_raw)
                exp_local = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M:%S")

                if now >= expires_at:
                    rdb.delete(key)
                    log(f"{torrent_hash} in state '{status}' expired at {exp_local}. Marked for deletion.")
                    return True
                else:
                    log(f"{torrent_hash} still in state '{status}'; expires at {exp_local}")
                    return False
            except ValueError:
                # Corrupted value in Redis
                expires_at = now + DELETION_THRESHOLD_SECONDS
                rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(expires_at))
                exp_local = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M:%S")
                log(f"Corrupt tracking data for {torrent_hash}. Reset expiry to {exp_local}")
                return False
    else:
        # Not a tracked state: remove any lingering tracking key
        expires_at_raw = rdb.get(key)
        if expires_at_raw is not None:
            rdb.delete(key)
            try:
                exp_local = datetime.fromtimestamp(int(expires_at_raw)).strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                exp_local = "unknown"
            log(f"{torrent_hash} left tracked state '{status}'. Stopped tracking (was set to expire at {exp_local})")
        return False


def delete_torrent(torrent_hash):
    """Send request to delete the torrent and its files."""
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
    """Run one full check of the torrent queue."""
    log("=== Starting monitor run ===")
    if not login():
        return

    torrents = get_torrents()
    for torrent in torrents:
        status = torrent.get("state")
        torrent_hash = torrent.get("hash")
        name = torrent.get("name")
        if should_delete(torrent_hash, status):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor run complete ===")


if __name__ == "__main__":
    while True:
        try:
            run()
        except Exception as e:
            log(f"Unexpected error: {e}")
        time.sleep(CHECK_INTERVAL)
