import os
import time
import json
import requests
import redis
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

# === Configuration ===

# qBittorrent API credentials and environment-based scheduler settings
QB_URL = os.getenv("QB_API_URL")
QB_USER = os.getenv("QB_USERNAME")
QB_PASS = os.getenv("QB_PASSWORD")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/15 * * * *")  # Every 15 minutes

# Versioning the cache keys for future-proofing changes
KEY_VERSION = "torrent_monitor_20250712g"
REDIS_EXPIRY_BUFFER = 7200  # Buffer time added to TTL in Redis
CHECK_INTERVAL = 60  # Scheduler check frequency in seconds

# Tracked torrent states with associated behavior and TTLs
TRACKED_STATES = [
    {"state": "completed",  "cached_state": "completed",  "ttl_seconds": 86400},   # Torrent fully downloaded
    {"state": "uploading",  "cached_state": "completed",  "ttl_seconds": 86400},   # Seeding after download
    {"state": "stalledUP",  "cached_state": "completed",  "ttl_seconds": 86400},   # Upload stalled
    {"state": "pausedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Upload paused manually
    {"state": "queuedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Queued for upload
    {"state": "stalledDL",  "cached_state": "stalledDL",  "ttl_seconds": 43200},   # Download stalled (12 hours)
    {"state": "metaDL",     "cached_state": "metaDL",     "ttl_seconds": 21600},   # Fetching metadata (6 hours)
]

# Lookup table for quick access to tracking metadata
TRACKED_STATE_LOOKUP = {
    s["state"]: {"ttl": s["ttl_seconds"], "cached_state": s["cached_state"]}
    for s in TRACKED_STATES
}

# Session for authenticated API requests
session = requests.Session()
# Redis client instance
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

def log(message):
    """Standardized logging with timestamp."""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Compose a Redis key with the version prefix."""
    return f"{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    """Convert a UNIX timestamp to human-readable local time."""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

def login():
    """Log in to qBittorrent API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Fetch the current list of torrents from qBittorrent."""
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
    Evaluate whether a torrent should be deleted based on:
    - State tracking
    - Lack of progress (downloaded_bytes)
    - TTL expiration since first tracking event
    """
    now = int(time.time())
    tracking_info = TRACKED_STATE_LOOKUP.get(status)
    if not tracking_info:
        # Remove stale cache entry if torrent has exited all tracked states
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
        # First-time tracking for this torrent
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
        # If Redis value is corrupted or non-JSON
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupt cache for {torrent_hash}. Reset tracking. New expiry {format_ts(new_expiry)}")
        return False

    if downloaded_bytes != cached_bytes:
        # Torrent progressed since last check → reset TTL
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    if cached_status != status:
        # Torrent changed state → reset TTL and tracking
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} changed state from '{cached_status}' → '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # TTL expired with no progress or state change → delete
        rdb.delete(key)
        log(f"{torrent_hash} stuck in cached_state '{cached_state}' since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    log(f"{torrent_hash} in '{status}' (cached_state '{cached_state}'); expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Call qBittorrent API to delete torrent and files."""
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

def score_torrent(t):
    """Assign a dynamic score to prioritize private and active torrents."""
    score = 0
    if t.get("private"):
        score += 1000  # Heavily prefer private torrents
    if t["state"] in ["downloading", "metaDL"]:
        score += 100  # Prioritize active fetches
    if t["dlspeed"] > 0:
        score += int(t["dlspeed"] / 1000)  # Speed-based boost
    return score

def reprioritize_queue(torrents):
    """Reorder the torrent queue based on score, moving best torrents to top."""
    sorted_torrents = sorted(torrents, key=score_torrent, reverse=True)
    for idx, t in enumerate(sorted_torrents):
        t_hash = t["hash"]
        session.post(f"{QB_URL}/api/v2/torrents/moveToTop", data={"hashes": t_hash})
    log("Reprioritized queue based on scoring criteria.")

def run():
    """
    Monitoring pass that performs:
    - API authentication
    - Reprioritization based on private/active/speed scores
    - Lifecycle and cleanup logic on tracked torrents
    """
    log("=== Running monitor pass ===")
    if not login():
        return

    torrents = get_torrents()
    reprioritize_queue(torrents)

    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)
        tags = t.get("tags", [])

        if "full-series" in tags:
            log(f"Skipping monitoring for '{name}' ({torrent_hash}) due to 'full-series' tag.")
            continue

        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

def schedule_monitor():
    """Initialize scheduler with cron expression and run immediately."""
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

if __name__ == "__main__":
    schedule_monitor()
