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

# Redis key version — updated when logic changes
KEY_VERSION = "torrent_monitor_20250727a"

# Additional buffer to Redis key expiration (in seconds)
REDIS_EXPIRY_BUFFER = 7200  # 2 hours

# Sleep interval for scheduler loop
CHECK_INTERVAL = 60

# Tracked torrent states and TTLs (in seconds)
TRACKED_STATES = [
    {"state": "completed", "cached_state": "completed", "ttl_seconds": 86400},
    {"state": "uploading", "cached_state": "completed", "ttl_seconds": 86400},
    {"state": "stalledUP", "cached_state": "completed", "ttl_seconds": 86400},
    {"state": "pausedUP", "cached_state": "completed", "ttl_seconds": 86400},
    {"state": "queuedUP", "cached_state": "completed", "ttl_seconds": 86400},
    {"state": "stalledDL", "cached_state": "stalledDL", "ttl_seconds": 43200},
    {"state": "metaDL", "cached_state": "metaDL", "ttl_seconds": 21600},
]

TRACKED_STATE_LOOKUP = {
    s["state"]: {"ttl": s["ttl_seconds"], "cached_state": s["cached_state"]} for s in TRACKED_STATES
}

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

def log(message):
    """Print a timestamped log message to stdout.

    Args:
        message (str): The message to log.
    """
    # Print log messages with a timestamp for easier debugging and traceability.
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

def get_cache_key(torrent_hash):
    """Build the Redis key for a torrent using the hash and current version.

    Args:
        torrent_hash (str): The torrent's unique hash.

    Returns:
        str: The Redis key for this torrent.
    """
    # Use a versioned key to allow for cache invalidation when logic changes.
    return f"{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    """Format a UNIX timestamp as a local time string.

    Args:
        ts (int): UNIX timestamp.

    Returns:
        str: Formatted time string.
    """
    # Convert a UNIX timestamp to a human-readable string for logging.
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

def login():
    """Authenticate with the qBittorrent Web API.

    Returns:
        bool: True if login was successful, False otherwise.
    """
    # Attempt to log in to the qBittorrent Web API using credentials from environment variables.
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Fetch all torrents from qBittorrent.

    Returns:
        list: List of torrent dicts, or empty list on failure.
    """
    # Retrieve the list of all torrents from the qBittorrent API.
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        torrents = r.json()
        log(f"Fetched {len(torrents)} torrents.")
        return torrents
    else:
        log("Failed to fetch torrents.")
        return []

def score_torrent(t):
    """Assign a score to a torrent for reprioritization.

    Args:
        t (dict): Torrent info dict.

    Returns:
        int: The computed score for this torrent.
    """
    # The score determines the priority of a torrent in the queue.
    # Higher scores are promoted to the top. Factors include tags, privacy, state, and average download speed.
    score = 0
    reason = []

    tags = t.get("tags", "")
    taglist = tags.split(",") if tags else []

    # VIP torrents get the highest boost.
    if "vip" in taglist:
        score += 10000
        reason.append("vip=+10000")

    # Private torrents get a significant boost.
    if t.get("private"):
        score += 1000
        reason.append("private=+1000")

    # Downloading torrents are prioritized over metadata-only.
    if t["state"] == "downloading":
        score += 100
        reason.append("downloading=+100")
    elif t["state"] == "metaDL":
        score += 50
        reason.append("metaDL=+50")

    # Average download speed is no longer used for scoring or reprioritization.
    log(f"Scoring: {t['name']} ({t['hash'][:6]}...): {score} | {'; '.join(reason)}")
    return score

def reprioritize_queue(torrents):
    """Reprioritize the torrent queue in qBittorrent based on scoring criteria and age.

    This function sorts torrents by score and age, checks if the current order matches the desired order,
    logs any differences, and moves torrents to the top of the queue as needed.

    Args:
        torrents (list): List of torrent dicts.
    """
    # If there are no torrents, nothing to do.
    if not torrents:
        return

    # Sort torrents by score (ascending) and then by age (newest first).
    sorted_torrents = sorted(torrents, key=lambda t: (score_torrent(t), -t.get("added_on", 0)))
    hashes_ordered = [t["hash"] for t in sorted_torrents]
    current_order = [t["hash"] for t in torrents]

    # If the current queue order matches the desired order, skip reprioritization.
    if hashes_ordered[::-1] == current_order:
        log("Torrent queue is already in desired order; skipping reprioritization.")
        return

    log("Torrent queue order differs; changes will be applied.")
    # Log the differences in position for transparency.
    for i, (desired, current) in enumerate(zip(hashes_ordered[::-1], current_order)):
        if desired != current:
            log(f"Position {i}: Expected {desired[:6]}..., Found {current[:6]}...")

    # Move each torrent to the top of the queue in the desired order. The result of this will be that the highest-scoring torrents are prioritized.
    for t in sorted_torrents:
        r = session.post(f"{QB_URL}/api/v2/torrents/topPrio", data={"hashes": t["hash"]})
        if r.ok:
            log(f"Promoted {t['name']} ({t['hash'][:6]}...) to top of queue")
        else:
            log(f"Failed to move {t['name']} to top. Status code: {r.status_code}. Response: {r.text}")

def should_delete(torrent_hash, status, downloaded_bytes):
    """Determine if a torrent should be deleted based on its state and progress.

    Args:
        torrent_hash (str): The unique hash of the torrent.
        status (str): The current state of the torrent.
        downloaded_bytes (int): The number of bytes downloaded so far.

    Returns:
        bool: True if the torrent should be deleted, False otherwise.
    """
    now = int(time.time())
    tracking_info = TRACKED_STATE_LOOKUP.get(status)

    # If the torrent is no longer in a tracked state, remove its cache and do not delete.
    if not tracking_info:
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

    # If this is the first time seeing this torrent in this state, start tracking it.
    if not raw:
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in cached_state '{cached_state}' ({status}); expires at {format_ts(new_expiry)}")
        return False

    try:
        cache = json.loads(raw)
        cached_status = cache.get("state")
        cached_expiry = int(cache.get("expires_at", 0))
        cached_bytes = int(cache.get("bytes", 0))
        cached_speeds = cache.get("dlspeed", [])
    except Exception:
        # If the cache is corrupt, reset it.
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupt cache for {torrent_hash}. Reset tracking. New expiry {format_ts(new_expiry)}")
        return False

    # If the torrent has made progress, reset the expiry.
    if downloaded_bytes != cached_bytes:
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    # If the torrent changed state, reset the expiry but keep download speed history.
    if cached_status != status:
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": cached_speeds}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} changed state from '{cached_status}' → '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    # If the torrent has been stuck in this state past expiry, mark for deletion.
    if now >= cached_expiry:
        rdb.delete(key)
        log(f"{torrent_hash} stuck in cached_state '{cached_state}' since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # Otherwise, continue tracking.
    log(f"{torrent_hash} in '{status}' (cached_state '{cached_state}'); expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Delete a torrent and its files from qBittorrent.

    Args:
        torrent_hash (str): The unique hash of the torrent to delete.

    Returns:
        bool: True if deletion was successful, False otherwise.
    """
    log(f"Deleting torrent {torrent_hash} and its files")
    r = session.post(f"{QB_URL}/api/v2/torrents/delete", data={"hashes": torrent_hash, "deleteFiles": "true"})
    if r.ok:
        log(f"Successfully deleted {torrent_hash}")
    else:
        log(f"Failed to delete {torrent_hash}")
    return r.ok

def run():
    """Run one monitoring pass: login, optionally reprioritize, and check for deletions.

    Reprioritization only occurs on startup (first run) and once per hour.
    All other runs only perform monitoring and deletion logic.

    Returns:
        None
    """
    log("=== Running monitor pass ===")
    if not login():
        return
    torrents = get_torrents()
    if not torrents:
        return

    # Only reprioritize on startup (first run) or once per hour.
    now = datetime.now()
    last_reprio = getattr(run, "last_reprioritize", None)
    should_reprioritize = not hasattr(run, "has_run")
    if not should_reprioritize and last_reprio:
        # Reprioritize if an hour or more has passed since last reprioritization.
        should_reprioritize = (now - last_reprio).total_seconds() >= 3600
    if should_reprioritize:
        reprioritize_queue(torrents)
        run.has_run = True
        run.last_reprioritize = now
    else:
        log("Skipping reprioritization (not startup or 1 hour since last)")

    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)
        tags = t.get("tags", "")
        taglist = tags.split(",") if tags else []

        # --- Log and update download speed history for each torrent ---
        # This helps track performance and is used for reprioritization.
        dlspeed = t.get("dlspeed", 0)
        key = get_cache_key(torrent_hash)
        raw = rdb.get(key)
        dlspeed_list = []
        if raw:
            try:
                cache = json.loads(raw)
                dlspeed_list = cache.get("dlspeed", [])
            except Exception:
                pass
        dlspeed_list.append(dlspeed)
        if len(dlspeed_list) > 10:
            dlspeed_list = dlspeed_list[-10:]
        # Save updated dlspeed history back to Redis.
        if raw:
            try:
                cache = json.loads(raw)
            except Exception:
                cache = {}
        else:
            cache = {}
        cache["dlspeed"] = dlspeed_list
        rdb.setex(key, REDIS_EXPIRY_BUFFER, json.dumps(cache))
        log(f"Torrent '{name}' ({torrent_hash[:6]}...): dlspeed={dlspeed} B/s, avg(last10)={int(sum(dlspeed_list)/len(dlspeed_list)) if dlspeed_list else 0} B/s")

        # Skip monitoring for torrents tagged as 'full-series'.
        if "full-series" in taglist:
            log(f"Skipping monitoring for '{name}' ({torrent_hash}) due to 'full-series' tag.")
            continue

        # Check if the torrent should be deleted based on its state and progress.
        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

def schedule_monitor():
    """Schedule the monitor to run periodically using APScheduler and a cron expression.

    This function sets up the background scheduler, adds the monitor job, and starts the scheduler loop.
    """
    log(f"Scheduling monitor with cron: '{MONITOR_CRON}'")
    scheduler = BackgroundScheduler()
    try:
        trigger = CronTrigger.from_crontab(MONITOR_CRON)
        scheduler.add_job(run, trigger)
        scheduler.start()
    except Exception as e:
        log(f"Failed to schedule monitor: {e}")
        exit(1)

    # Run once immediately on startup.
    run()

    try:
        while True:
            time.sleep(CHECK_INTERVAL)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log("Scheduler shutdown cleanly.")


if __name__ == "__main__":
    schedule_monitor()
