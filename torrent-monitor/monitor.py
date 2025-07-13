import os
import time
import requests
import redis
from datetime import datetime, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

# === Configuration ===

QB_URL = os.getenv("QB_API_URL")
QB_USER = os.getenv("QB_USERNAME")
QB_PASS = os.getenv("QB_PASSWORD")
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
MONITOR_CRON = os.getenv("MONITOR_CRON", "*/30 * * * *")  # Every 30 minutes by default

CHECK_INTERVAL = 60  # main loop sleep interval, not cron-related

KEY_VERSION = "torrent_monitor_20250712b"
DELETION_THRESHOLD_SECONDS = 24 * 3600
REDIS_KEY_EXPIRATION_SECONDS = 26 * 3600

TRACKED_STATES = [
    "uploading", "stalledUP", "stalledDL", "pausedUP", "queuedUP", "completed"
]

session = requests.Session()
rdb = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)

# === Logging ===

def log(message):
    """Log messages with local time."""
    local_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{local_time}] {message}", flush=True)

# === Helper ===

def get_cache_key(torrent_hash):
    return f"torrent:{KEY_VERSION}:{torrent_hash}"

# === Core ===

def login():
    """Authenticate with qBittorrent API."""
    r = session.post(f"{QB_URL}/api/v2/auth/login", data={"username": QB_USER, "password": QB_PASS})
    if r.ok:
        log("Login successful.")
    else:
        log("Login failed.")
    return r.ok

def get_torrents():
    """Retrieve list of all torrents."""
    r = session.get(f"{QB_URL}/api/v2/torrents/info")
    if r.ok:
        torrents = r.json()
        log(f"Fetched {len(torrents)} torrents.")
        return torrents
    else:
        log("Failed to fetch torrents.")
        return []

def should_delete(torrent_hash, status):
    """Determine whether a torrent should be deleted based on tracked state and Redis expiry."""
    now = int(time.time())
    key = get_cache_key(torrent_hash)

    if status in TRACKED_STATES:
        expires_at_raw = rdb.get(key)

        if expires_at_raw is None:
            expires_at = now + DELETION_THRESHOLD_SECONDS
            rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(expires_at))
            exp_local = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M:%S")
            log(f"Started tracking {torrent_hash} in state '{status}'; expires at {exp_local}")
            return False

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
            expires_at = now + DELETION_THRESHOLD_SECONDS
            rdb.setex(key, REDIS_KEY_EXPIRATION_SECONDS, str(expires_at))
            exp_local = datetime.fromtimestamp(expires_at).strftime("%Y-%m-%d %H:%M:%S")
            log(f"Corrupt Redis value for {torrent_hash}. Reset expiry to {exp_local}")
            return False

    else:
        expires_at_raw = rdb.get(key)
        if expires_at_raw is not None:
            rdb.delete(key)
            try:
                exp_local = datetime.fromtimestamp(int(expires_at_raw)).strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                exp_local = "unknown"
            log(f"{torrent_hash} left tracked state '{status}'. Stopped tracking (was to expire at {exp_local})")
        return False

def delete_torrent(torrent_hash):
    """Send delete request for torrent and its files."""
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
    """Perform a single monitoring pass."""
    log("=== Running monitor pass ===")
    if not login():
        return

    for t in get_torrents():
        status = t.get("state")
        torrent_hash = t.get("hash")
        name = t.get("name")
        if should_delete(torrent_hash, status):
            log(f"Removing torrent '{name}' ({torrent_hash})")
            delete_torrent(torrent_hash)

    log("=== Monitor pass complete ===")

# === Scheduler ===

def schedule_monitor():
    """Set up cron-based scheduler and initial run."""
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

if __name__ == "__main__":
    schedule_monitor()
