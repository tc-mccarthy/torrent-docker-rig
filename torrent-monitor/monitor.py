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
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)

def get_cache_key(torrent_hash):
    return f"{KEY_VERSION}:{torrent_hash}"

def format_ts(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")

def login():
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        torrents = r.json()
        log(f"Fetched {len(torrents)} torrents.")
        return torrents
    else:
        log("Failed to fetch torrents.")
        return []

def is_top_of_hour():
    return datetime.now().minute == 0

def score_torrent(t):
    score = 0
    reason = []

    tags = t.get("tags", "")
    taglist = tags.split(",") if tags else []

    if "vip" in taglist:
        score += 10000
        reason.append("vip=+10000")

    if t.get("private"):
        score += 1000
        reason.append("private=+1000")

    if t["state"] == "downloading":
        score += 100
        reason.append("downloading=+100")
    elif t["state"] == "metaDL":
        score += 50
        reason.append("metaDL=+50")

    key = get_cache_key(t["hash"])
    raw = rdb.get(key)
    avg_kbps = 0

    if raw:
        try:
            cache = json.loads(raw)
            dlspeed_list = cache.get("dlspeed", [])
            if t.get("dlspeed") is not None:
                dlspeed_list.append(t["dlspeed"])
                if len(dlspeed_list) > 10:
                    dlspeed_list = dlspeed_list[-10:]
                avg_kbps = int(sum(dlspeed_list) / len(dlspeed_list) / 1000)
                cache["dlspeed"] = dlspeed_list
                rdb.setex(key, REDIS_EXPIRY_BUFFER, json.dumps(cache))
        except Exception as e:
            log(f"Error updating download speed cache for {t['hash'][:6]}...: {e}")

    if avg_kbps > 0:
        score += avg_kbps
        reason.append(f"avg_dlspeed={avg_kbps} KB/s")

    log(f"Scoring: {t['name']} ({t['hash'][:6]}...): {score} | {'; '.join(reason)}")
    return score

def reprioritize_queue(torrents, force=False):
    if not torrents or (not force and not is_top_of_hour()):
        return

    sorted_torrents = sorted(torrents, key=lambda t: (-score_torrent(t), t.get("added_on", 0)))

    hashes_ordered = [t["hash"] for t in sorted_torrents]
    current_order = [t["hash"] for t in torrents]

    if hashes_ordered == current_order:
        log("Torrent queue is already in desired order; skipping reprioritization.")
        return

    for t in sorted_torrents:
        r = session.post(f"{QB_URL}/api/v2/torrents/topPrio", data={"hashes": t["hash"]})
        if r.ok:
            log(f"Promoted {t['name']} ({t['hash'][:6]}...) to top of queue")
        else:
            log(f"Failed to move {t['name']} to top. Status code: {r.status_code}. Response: {r.text}")

def should_delete(torrent_hash, status, downloaded_bytes):
    """Determine if a torrent should be deleted based on state, progress, and TTL.

    Args:
        torrent_hash (str): Torrent hash.
        status (str): Torrent state.
        downloaded_bytes (int): Number of bytes downloaded.

    Returns:
        bool: True if the torrent should be deleted, False otherwise.
    """
    now = int(time.time())
    tracking_info = TRACKED_STATE_LOOKUP.get(status)

    if not tracking_info:
        # Torrent is no longer in a tracked state; remove any cache and skip deletion
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
        # First time seeing this torrent in this state; start tracking
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Started tracking {torrent_hash} in cached_state '{cached_state}' ({status}); expires at {format_ts(new_expiry)}")
        return False

    try:
        # Load cached state for this torrent
        cache = json.loads(raw)
        cached_status = cache.get("state")
        cached_expiry = int(cache.get("expires_at", 0))
        cached_bytes = int(cache.get("bytes", 0))
        cached_speeds = cache.get("dlspeed", [])
    except Exception:
        # If cache is corrupt, reset it
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"Corrupt cache for {torrent_hash}. Reset tracking. New expiry {format_ts(new_expiry)}")
        return False

    if downloaded_bytes != cached_bytes:
        # Download has progressed; reset TTL and update cache
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": []}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} made progress ({cached_bytes} → {downloaded_bytes} bytes); reset expiry to {format_ts(new_expiry)}")
        return False

    if cached_status != status:
        # Torrent state changed; reset TTL and update cache
        payload = {"expires_at": new_expiry, "state": status, "bytes": downloaded_bytes, "dlspeed": cached_speeds}
        rdb.setex(key, ttl + REDIS_EXPIRY_BUFFER, json.dumps(payload))
        log(f"{torrent_hash} changed state from '{cached_status}' → '{status}'; reset expiry to {format_ts(new_expiry)}")
        return False

    if now >= cached_expiry:
        # Torrent has been stuck in this state too long; mark for deletion
        rdb.delete(key)
        log(f"{torrent_hash} stuck in cached_state '{cached_state}' since {format_ts(cached_expiry)}. Marked for deletion.")
        return True

    # Torrent is still within TTL window; keep monitoring
    log(f"{torrent_hash} in '{status}' (cached_state '{cached_state}'); expires at {format_ts(cached_expiry)}")
    return False

def delete_torrent(torrent_hash):
    """Delete a torrent and its files from qBittorrent.

    Args:
        torrent_hash (str): Torrent hash.

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
    """Run one monitoring pass: login, reprioritize, and check for deletions.

    Returns:
        None
    """
    log("=== Running monitor pass ===")
    if not login():
        return
    torrents = get_torrents()
    if not torrents:
        return

    reprioritize_queue(torrents, force=True)

    for t in torrents:
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        downloaded = t.get("downloaded", 0)
        tags = t.get("tags", "")
        taglist = tags.split(",") if tags else []

        if "full-series" in taglist:
            log(f"Skipping monitoring for '{name}' ({torrent_hash}) due to 'full-series' tag.")
            continue

        if should_delete(torrent_hash, status, downloaded):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

def schedule_monitor():
    """Schedule the monitor to run immediately and then on a cron schedule.

    Returns:
        None
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

    run()

    try:
        while True:
            time.sleep(CHECK_INTERVAL)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
        log("Scheduler shutdown cleanly.")

if __name__ == "__main__":
    schedule_monitor()
