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
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/15 * * * *")  # Every 15 minutes

# Redis key version — updated to reflect logic change
KEY_VERSION = "torrent_monitor_20250712f"

# Additional buffer to Redis key expiration (in seconds)
REDIS_EXPIRY_BUFFER = 7200  # 2 hours

# Sleep interval for scheduler loop
CHECK_INTERVAL = 60

# Tracked torrent states and TTLs (in seconds)
# cached_state allows grouping states under a shared lifecycle window
TRACKED_STATES = [
    {"state": "completed",  "cached_state": "completed",  "ttl_seconds": 86400},   # Torrent fully downloaded
    {"state": "uploading",  "cached_state": "completed",  "ttl_seconds": 86400},   # Seeding after download
    {"state": "stalledUP",  "cached_state": "completed",  "ttl_seconds": 86400},   # Upload stalled
    {"state": "pausedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Upload paused manually
    {"state": "queuedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Queued for upload
    {"state": "stalledDL",  "cached_state": "stalledDL",  "ttl_seconds": 43200},   # Download stalled (12 hours)
    {"state": "metaDL",     "cached_state": "metaDL",     "ttl_seconds": 21600},   # Fetching metadata (6 hours)
]

# Create a lookup table for state → {ttl, cached_state}
TRACKED_STATE_LOOKUP = {
    s["state"]: {"ttl": s["ttl_seconds"], "cached_state": s["cached_state"]}
    for s in TRACKED_STATES
}

# === Services ===

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

# === Utility Functions ===

def log(message):
    """Log with local time."""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Build the Redis key using the hash and current version."""
    return f"{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    """Format a UNIX timestamp as local time string."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

# === qBittorrent Integration ===

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

# === Core Monitoring Logic ===

def should_delete(torrent_hash, status, downloaded_bytes):
    """
    Determine if a torrent should be deleted based on:
    - cached_state (unified logic for post-completion states)
    - byte progress (downloaded_bytes)
    - time since first tracked event
    """
    now = int(time.time())

    tracking_info = TRACKED_STATE_LOOKUP.get(status)
    if not tracking_info:
        # Torrent left all tracked states → remove cache
        key = get_cache_key(torrent_hash)
        if rdb.exists(key):
            rdb.delete(key)
            log(f"{torrent_hash} left tracked state '{status}'. Removed tracking key.")
        return False

    cached_state = tracking_info["cached_state"]
    ttl = tracking_info["ttl"]
    new_expiry = now + ttl
    key = get_cache_key(torrent_hash)
    raw = rdb.get(key)

    if not raw:
        # First time seeing this torrent
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in cached_state '{cached_state}' ({status}); expires at {format_ts(new_expiry)}")
        return False

    try:
        cache = json.loads(raw)
        cached_status = cache.get("state")
        cached_expiry = int(cache.get("expires_at", 0))
        cached_bytes = int(cache.get("bytes", 0))
    except Exception:
        # Malformed Redis object → reset it
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupt cache for {torrent_hash}. Reset tracking. New expiry {format_ts(new_expiry)}")
        return False

    if downloaded_bytes != cached_bytes:
        # Download progressed → reset TTL
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    if cached_status != status:
        # Torrent state changed → reset TTL
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} changed state from '{cached_status}' → '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # Time expired with no progress
        rdb.delete(key)
        log(f"{torrent_hash} stuck in cached_state '{cached_state}' since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # Still within TTL
    log(f"{torrent_hash} in '{status}' (cached_state '{cached_state}'); expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Delete torrent and its files."""
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
    """
    Executes a single monitoring pass:
    - Authenticates with qBittorrent
    - Fetches all torrents
    - Skips torrents tagged as 'full-series' (these are considered complete collections and are not monitored)
    - For all other torrents, determines if they should be deleted based on state, progress, and time
    """
    log("=== Running monitor pass ===")
    if not login():
        # If authentication fails, abort this monitoring pass
        return

    torrents = get_torrents()
    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)
        tags = t.get("tags", [])
        # --- Expressive comment: skip monitoring for full-series torrents ---
        # Torrents tagged with 'full-series' are typically entire TV series or large collections.
        # These are intentionally excluded from monitoring and deletion logic to preserve them.
        if "full-series" in tags:
            log(f"Skipping monitoring for '{name}' ({torrent_hash}) due to 'full-series' tag.")
            continue
        # --- End expressive comment ---

        # Evaluate if this torrent should be deleted based on its state and progress
        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

# === Scheduler ===

def schedule_monitor():
    """Run monitor immediately and then on cron schedule."""
    log(f"Scheduling monitor with cron: '{MONITOR_CRON}'")
    scheduler = BackgroundScheduler()
    try:
        trigger = CronTrigger.from_crontab(MONITOR_CRON)
        scheduler.add_job(run, trigger)
        scheduler.start()
    except Exception as e:
        log(f"Failed to schedule monitor: {e}")
        exit(1)

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