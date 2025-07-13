import os
import time
import json
import requests
import redis
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

# === Configuration ===

QB_URL = os.getenv("QB_API_URL")
QB_USER = os.getenv("QB_USERNAME")
QB_PASS = os.getenv("QB_PASSWORD")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/30 * * * *")  # Every 30 minutes

# Redis key version — change if tracking logic is updated to avoid cache conflicts
KEY_VERSION = "torrent_monitor_20250712d"

# Additional buffer to Redis key expiration (in seconds)
REDIS_EXPIRY_BUFFER = 7200  # 2 hours

# Sleep interval for scheduler loop
CHECK_INTERVAL = 60

# Tracked torrent states with human-readable comments and TTLs in seconds
TRACKED_STATES = [
    {"state": "completed", "ttl_seconds": 86400},   # Torrent fully downloaded
    {"state": "uploading", "ttl_seconds": 86400},   # Seeding after download
    {"state": "stalledUP", "ttl_seconds": 86400},   # Upload stalled (no peers?)
    {"state": "stalledDL", "ttl_seconds": 86400},   # Download stalled (no peers?)
    {"state": "pausedUP", "ttl_seconds": 86400},    # Upload paused manually
    {"state": "queuedUP", "ttl_seconds": 86400},    # Queued for upload (not active)
    {"state": "metaDL", "ttl_seconds": 86400},      # Fetching metadata from magnet link
]

# Build a lookup table for fast TTL access
TRACKED_STATE_LOOKUP = {s["state"]: s["ttl_seconds"] for s in TRACKED_STATES}

# === Service Clients ===

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

# === Utilities ===

def log(message):
    """Log with local time."""
    local_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{local_time}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Build a versioned Redis key for this torrent."""
    return f"{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    """Format a UNIX timestamp as local time string."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

# === Monitoring Core ===

def login():
    """Authenticate with the qBittorrent Web API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Fetch all torrents from qBittorrent."""
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        torrents = r.json()
        log(f"Fetched {len(torrents)} torrents.")
        return torrents
    else:
        log("Failed to fetch torrents.")
        return []

def should_delete(torrent_hash, status, downloaded_bytes):
    """
    Determine if a torrent should be deleted:
    - Tracks by state and downloaded byte count
    - Resets TTL on progress or state change
    """
    now = int(time.time())
    key = get_cache_key(torrent_hash)

    if status not in TRACKED_STATE_LOOKUP:
        # Torrent left a tracked state — remove Redis key if it exists
        raw = rdb.get(key)
        if raw:
            rdb.delete(key)
            log(f"{torrent_hash} left tracked state '{status}'. Removed from tracking.")
        return False

    current_ttl = TRACKED_STATE_LOOKUP[status]
    new_expiry = now + current_ttl
    raw = rdb.get(key)

    if not raw:
        # First time seeing this torrent — initialize tracking
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in '{status}' with {downloaded_bytes} bytes; expires at {format_ts(new_expiry)}")
        return False

    try:
        cache = json.loads(raw)
        cached_state = cache.get("state")
        cached_expiry = int(cache.get("expires_at", 0))
        cached_bytes = int(cache.get("bytes", 0))
    except Exception:
        # Corrupted Redis data — reset tracking
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupted cache for {torrent_hash}. Reset to '{status}' with {downloaded_bytes} bytes; expires at {format_ts(new_expiry)}")
        return False

    if downloaded_bytes != cached_bytes:
        # Torrent made progress — reset expiration
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    if cached_state != status:
        # State changed — reset expiration
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, current_ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} state changed from '{cached_state}' to '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # Torrent expired with no progress or state change
        rdb.delete(key)
        log(f"{torrent_hash} stuck in '{status}' with no progress since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # Still within TTL window
    log(f"{torrent_hash} in '{status}' with no progress; expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Delete torrent and its data from qBittorrent."""
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
    """Run one monitoring pass."""
    log("=== Running monitor pass ===")
    if not login():
        return

    torrents = get_torrents()
    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)

        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

# === Scheduler ===

def schedule_monitor():
    """Configure and start cron scheduler."""
    log(f"Scheduling monitor with cron: '{MONITOR_CRON}'")
    scheduler = BackgroundScheduler()
    try:
        trigger = CronTrigger.from_crontab(MONITOR_CRON)
        scheduler.add_job(run, trigger)
        scheduler.start()
    except Exception as e:
        log(f"Failed to schedule monitor: {e}")
        exit(1)

    # Immediate run at startup
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
