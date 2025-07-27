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
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/5 * * * *")  # Every 5 minutes

# Redis key version — updated when logic changes
KEY_VERSION = "torrent_monitor_20250712h"

# Additional buffer to Redis key expiration (in seconds)
REDIS_EXPIRY_BUFFER = 7200  # 2 hours

# Sleep interval for scheduler loop
CHECK_INTERVAL = 60

# Tracked torrent states and TTLs (in seconds)
# Each entry also specifies a `cached_state` to normalize behavior post-completion
TRACKED_STATES = [
    {"state": "completed",  "cached_state": "completed",  "ttl_seconds": 86400},   # Fully downloaded
    {"state": "uploading",  "cached_state": "completed",  "ttl_seconds": 86400},   # Seeding
    {"state": "stalledUP",  "cached_state": "completed",  "ttl_seconds": 86400},   # Upload stalled
    {"state": "pausedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Paused manually
    {"state": "queuedUP",   "cached_state": "completed",  "ttl_seconds": 86400},   # Awaiting upload
    {"state": "stalledDL",  "cached_state": "stalledDL",  "ttl_seconds": 43200},   # Download stalled (12hr)
    {"state": "metaDL",     "cached_state": "metaDL",     "ttl_seconds": 21600},   # Metadata fetch (6hr)
]

# Create a lookup for fast TTL and cache group resolution
TRACKED_STATE_LOOKUP = {
    s["state"]: {"ttl": s["ttl_seconds"], "cached_state": s["cached_state"]}
    for s in TRACKED_STATES
}

# === Service Setup ===

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

def log(message):
    """Log with local time."""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Generate the Redis key used for tracking a torrent."""
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

# === Torrent Scoring and Reprioritization ===

def score_torrent(t):
    """
    Assign a score to the torrent for reprioritization.
    - Private torrents are most valuable (score +1000)
    - Active download states get a boost (score +100 or +50)
    - Current download speed contributes directly to score
    This function logs its reasoning for traceability.
    """
    score = 0
    reason = []

    if t.get("private"):
        score += 1000
        reason.append("private=+1000")

    if t["state"] == "downloading":
        score += 100
        reason.append("downloading=+100")
    elif t["state"] == "metaDL":
        score += 50
        reason.append("metaDL=+50")

    if t.get("dlspeed", 0) > 0:
        kb_speed = int(t["dlspeed"] / 1000)
        score += kb_speed
        reason.append(f"dlspeed={kb_speed} KB/s")

    log(f"Scoring: {t['name']} ({t['hash'][:6]}...): {score} | {'; '.join(reason)}")
    return score

def reprioritize_queue(torrents):
    """
    Reprioritize torrents based on score.
    - Highest scoring torrents go to the top of the queue
    - Only the top N (e.g. 10) are promoted per pass to limit churn
    """
    if not torrents:
        return

    sorted_torrents = sorted(torrents, key=score_torrent, reverse=True)
    for index, t in enumerate(sorted_torrents):
        if index < 10:  # Top 10 are promoted
            r = session.post(f"{QB_URL}/api/v2/torrents/moveTop", data={"hashes": t["hash"]})
            if r.ok:
                log(f"Promoted {t['name']} ({t['hash'][:6]}...) to top of queue")
            else:
                log(f"Failed to move {t['name']} to top")
def should_delete(torrent_hash, status, downloaded_bytes):
    # Capture the current time as a UNIX timestamp
    now = int(time.time())

    # Look up the TTL and cache group associated with the current torrent status.
    # This helps normalize different states into a common lifecycle bucket (e.g., all post-download states as 'completed').
    tracking_info = TRACKED_STATE_LOOKUP.get(status)

    if not tracking_info:
        # If the current status is not part of our tracked states, remove any existing cache entry for it.
        # This prevents stale keys lingering in Redis and ensures memory is reclaimed for untracked items.
        key = get_cache_key(torrent_hash)
        if rdb.exists(key):
            rdb.delete(key)
            log(f"{torrent_hash} left tracked state '{status}'. Removed tracking key.")
        return False

    # Extract the normalized 'cached_state' and the TTL from our config.
    # cached_state allows multiple actual qBittorrent states to share a common expiration rule.
    cached_state = tracking_info["cached_state"]
    ttl = tracking_info["ttl"]
    new_expiry = now + ttl
    key = get_cache_key(torrent_hash)
    raw = rdb.get(key)

    if not raw:
        # This is the first time we've seen this torrent in a tracked state.
        # We cache its state, bytes downloaded, and initialize speed tracking.
        payload = {
            "expires_at": new_expiry,        # When this torrent should expire unless progress is detected
            "state": status,                 # The current torrent state (e.g., completed, stalledDL, etc.)
            "bytes": downloaded_bytes,       # Downloaded bytes so far
            "dlspeed": []                    # Will hold a history of download speeds for scoring
        }
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in cached_state '{cached_state}' ({status}); expires at {format_ts(new_expiry)}")
        return False

    try:
        # Attempt to parse the existing cache entry from Redis
        cache = json.loads(raw)
        cached_status = cache.get("state")
        cached_expiry = int(cache.get("expires_at", 0))
        cached_bytes = int(cache.get("bytes", 0))
        cached_speeds = cache.get("dlspeed", [])
    except Exception:
        # If the cache is corrupted or invalid, reinitialize it safely
        payload = {
            "expires_at": new_expiry,
            "state": status,
            "bytes": downloaded_bytes,
            "dlspeed": []
        }
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupt cache for {torrent_hash}. Reset tracking. New expiry {format_ts(new_expiry)}")
        return False

    if downloaded_bytes != cached_bytes:
        # The torrent has made progress since the last check.
        # We update the downloaded byte count and reset the TTL timer.
        payload = {
            "expires_at": new_expiry,
            "state": status,
            "bytes": downloaded_bytes,
            "dlspeed": []
        }
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    if cached_status != status:
        # Torrent transitioned to a new state (e.g., downloading → stalled).
        # We reset the TTL window to give the new state time to resolve.
        payload = {
            "expires_at": new_expiry,
            "state": status,
            "bytes": downloaded_bytes,
            "dlspeed": cached_speeds
        }
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} changed state from '{cached_status}' → '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # No progress has been made and the torrent is still in the same state beyond the TTL threshold.
        # This torrent is considered idle or stuck and should be removed.
        rdb.delete(key)
        log(f"{torrent_hash} stuck in cached_state '{cached_state}' since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # The torrent is still within its active TTL window, no action needed yet.
    log(f"{torrent_hash} in '{status}' (cached_state '{cached_state}'); expires at {format_ts(cached_expiry)}")
    return False
def delete_torrent(torrent_hash):
    """Delete torrent and its files using the qBittorrent API."""
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
    - Reprioritizes queue for better bandwidth efficiency
    - Skips torrents tagged as 'full-series'
    - For other torrents, evaluates state and determines if deletion is warranted
    """
    log("=== Running monitor pass ===")
    if not login():
        # If authentication fails, abort this monitoring pass
        return

    torrents = get_torrents()
    if not torrents:
        return

    reprioritize_queue(torrents)

    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)
        tags = t.get("tags", "")
        taglist = tags.split(",") if tags else []

        # Expressive comment: Skip torrents intentionally preserved (e.g. full TV series)
        if "full-series" in taglist:
            log(f"Skipping monitoring for '{name}' ({torrent_hash}) due to 'full-series' tag.")
            continue

        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

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

    # Run immediately on start
    run()

    # Keep process alive so background scheduler remains active
    try:
        while True:
            time.sleep(CHECK_INTERVAL)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log("Scheduler shutdown cleanly.")

# === Entrypoint ===

if __name__ == "__main__":
    schedule_monitor()
