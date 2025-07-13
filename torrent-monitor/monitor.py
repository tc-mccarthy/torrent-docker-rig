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

# Versioning for Redis keys to allow for future logic changes
KEY_VERSION = "torrent_monitor_20250712a"

# Deletion logic:
#   - Track torrents for 24 hours
#   - Redis key lives for 26 hours to allow margin for script downtime
DELETION_THRESHOLD_SECONDS = 24 * 3600
REDIS_KEY_EXPIRATION_SECONDS = 26 * 3600

# === Initialization ===

# qBittorrent HTTP session
session = requests.Session()

# Redis client
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

# === Utilities ===

def log(message):
    """Standard logging format with UTC timestamp."""
    print(f"[{datetime.utcnow().isoformat()}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Construct a namespaced and versioned Redis key for a torrent."""
    return f"torrent:{KEY_VERSION}:{torrent_hash}"

# === Core Logic ===

def login():
    """Log into the qBittorrent Web API and return True if successful."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Fetch torrent data from qBittorrent."""
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
    Evaluate whether the given torrent should be deleted.
    - If the torrent is in a tracked state and has no key, create one that expires in 24 hours.
    - If the torrent has a key and the time has passed, delete it.
    - If the torrent leaves a tracked state, remove any existing tracking key.
    """
    now = int(time.time())
    key = get_cache_key(torrent_hash)

    # States that we want to monitor for long-term inactivity
    tracked_states = {
        "uploading", "stalledUP", "stalledDL", "pausedUP", "queuedUP", "completed"
    }

    if status in tracked_states:
        expires_at_raw = rdb.get(key)

        if expires_at_raw is None:
            # First time seeing this torrent in a tracked state
            expires_at = now + DELETION_THRESHOLD_SECONDS
            rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(expires_at))
            log(f"Started tracking {torrent_hash} in {status}; expires at {datetime.utcfromtimestamp(expires_at)}")
            return False

        else:
            try:
                expires_at = int(expires_at_raw)
                if now >= expires_at:
                    rdb.delete(key)
                    log(f"{torrent_hash} has exceeded threshold in {status}. Marked for deletion.")
                    return True
                else:
                    log(f"{torrent_hash} is still within threshold in {status}.")
                    return False
            except ValueError:
                # Handle corrupted or non-integer Redis value
                log(f"Corrupted Redis value for {torrent_hash}. Resetting.")
                new_expires = now + DELETION_THRESHOLD_SECONDS
                rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(new_expires))
                return False

    else:
        # Torrent is no longer in a tracked state — clean up Redis key
        if rdb.get(key) is not None:
            rdb.delete(key)
            log(f"{torrent_hash} left tracked state ({status}). Stopped tracking.")
        return False

def delete_torrent(torrent_hash):
    """Send a delete request to qBittorrent for the given torrent and its files."""
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
    """Main loop that performs a single pass of the monitor check."""
    log("Starting monitor run...")
    if not login():
        return

    torrents = get_torrents()
    for torrent in torrents:
        status = torrent.get("state")
        torrent_hash = torrent.get("hash")
        name = torrent.get("name")
        if should_delete(torrent_hash, status):
            log(f"Removing {name} ({torrent_hash}) from qBittorrent.")
            delete_torrent(torrent_hash)

    log("Monitor run complete.")

# === Entrypoint ===

if __name__ == "__main__":
    while True:
        try:
            run()
        except Exception as e:
            log(f"Unexpected error: {e}")
        time.sleep(CHECK_INTERVAL)
