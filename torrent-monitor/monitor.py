import os
import time
import json
import requests
import redis
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

# === Configuration ===

# Required environment variables
QB_URL = os.getenv("QB_API_URL")
QB_USER = os.getenv("QB_USERNAME")
QB_PASS = os.getenv("QB_PASSWORD")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/30 * * * *")  # Default: every 30 minutes

# Redis key versioning
KEY_VERSION = "torrent_monitor_20250712c"

# Sleep time between scheduler ticks (doesn't affect cron)
CHECK_INTERVAL = 60

# States to track, with TTL (in seconds) for each
# You can assign different TTLs to each state if needed
TRACKED_STATES = [
    {"state": "completed", "ttl_seconds": 86400},
    {"state": "uploading", "ttl_seconds": 86400},
    {"state": "stalledUP", "ttl_seconds": 86400},
    {"state": "stalledDL", "ttl_seconds": 86400},
    {"state": "pausedUP", "ttl_seconds": 86400},
    {"state": "queuedUP", "ttl_seconds": 86400},
    {"state": "metaDL", "ttl_seconds": 86400}
]

# Internal lookup map for quick access to TTLs by state
TRACKED_STATE_LOOKUP = {s["state"]: s["ttl_seconds"] for s in TRACKED_STATES}

# Redis expiration buffer (seconds) to keep key around after TTL expires (for cleanup tolerance)
REDIS_EXPIRY_BUFFER = 7200  # 2 hours

# === Services and State ===

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

# === Logging ===

def log(message):
    """Print a timestamped log message using local time."""
    local_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{local_time}] {message}", flush=True)

# === Helpers ===

def get_cache_key(torrent_hash):
    """Construct a versioned Redis key for a torrent."""
    return f"torrent:{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    """Convert UNIX timestamp to local string for logging."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

# === Core Logic ===

def login():
    """Authenticate with the qBittorrent Web API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Retrieve the list of torrents from qBittorrent."""
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
    Evaluate whether the torrent should be deleted based on its state and tracked TTL.

    - If state is not tracked: remove tracking key (if any).
    - If state is tracked:
        - If key doesn't exist: create it with expiration.
        - If state changed: reset expiration and update state.
        - If expired: delete key and mark for deletion.
    """
    now = int(time.time())
    key = get_cache_key(torrent_hash)

    if status not in TRACKED_STATE_LOOKUP:
        # Torrent is not in a tracked state → remove Redis key if exists
        raw = rdb.get(key)
        if raw:
            rdb.delete(key)
            try:
                cached = json.loads(raw)
                exp_ts = int(cached.get("expires_at", 0))
                exp_str = format_ts(exp_ts)
            except Exception:
                exp_str = "unknown"
            log(f"{torrent_hash} left tracked state '{status}'. Removed key (was set to expire at {exp_str}).")
        return False

    current_ttl = TRACKED_STATE_LOOKUP[status]
    new_expiry = now + current_ttl
    raw = rdb.get(key)

    if not raw:
        # First time seeing torrent in this state
        payload = {"expires_at": new_expiry, "state": status}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in '{status}'; expires at {format_ts(new_expiry)}")
        return False

    try:
        data = json.loads(raw)
        cached_state = data.get("state")
        cached_expiry = int(data.get("expires_at", 0))
    except Exception:
        # Malformed data → reset
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps({"expires_at": new_expiry, "state": status}))
        log(f"Corrupt Redis value for {torrent_hash}. Reset expiry for state '{status}' to {format_ts(new_expiry)}")
        return False

    if cached_state != status:
        # Torrent changed to a new tracked state → reset expiry
        payload = {"expires_at": new_expiry, "state": status}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} state changed from '{cached_state}' to '{status}'. Reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # Torrent has been in this state too long → delete
        rdb.delete(key)
        log(f"{torrent_hash} in state '{status}' expired at {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # Still within TTL
    log(f"{torrent_hash} in state '{status}'; expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Request qBittorrent to delete the torrent and its files."""
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
    """Run a full monitoring cycle: check all torrents and delete expired ones."""
    log("=== Running monitor pass ===")
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

    log("=== Monitor pass complete ===")

# === Scheduler Setup ===

def schedule_monitor():
    """Configure the cron-based scheduler and trigger the initial run."""
    log(f"Scheduling monitor with cron: '{MONITOR_CRON}'")
    scheduler = BackgroundScheduler()
    try:
        trigger = CronTrigger.from_crontab(MONITOR_CRON)
        scheduler.add_job(run, trigger)
        scheduler.start()
    except Exception as e:
        log(f"Failed to schedule monitor: {e}")
        exit(1)

    # Immediate run on startup
    run()

    try:
        while True:
            time.sleep(CHECK_INTERVAL)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log("Scheduler shutdown cleanly.")

# === Entrypoint ===

if __name__ == "__main__":
    schedule_monitor()
