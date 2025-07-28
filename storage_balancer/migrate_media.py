#!/usr/bin/env python3

"""
Media Migration Utility

This script analyzes disk utilization between two volumes and migrates media directories
from a source to a destination until the source falls below a specified utilization target.

It uses `rsync` to ensure accurate and resumable copying, deletes originals once verified,
and updates Radarr and Sonarr with new paths if configured.

Environment variables expected:
- SOURCE_PATH: full path to the source directory (e.g., /source_media/Drax/Movies)
- DEST_PATH: full path to the destination directory (e.g., /source_media/Rogers/Movies)
- TARGET_UTILIZATION: target % utilization threshold to reach
- RADARR_URL / RADARR_API_KEY: optional Radarr integration
- SONARR_URL / SONARR_API_KEY: optional Sonarr integration
- MEDIA_MOUNT_PREFIX: how the host paths appear to Radarr/Sonarr (e.g., /media/tc)
"""

import os
import shutil
import subprocess
import requests
from pathlib import Path
from datetime import datetime
from tqdm import tqdm

# ----------------------------------------------------------
# Configuration loaded via environment variables
# ----------------------------------------------------------

SOURCE = Path(os.getenv("SOURCE_PATH", "/source_media/Drax/Movies"))
DEST = Path(os.getenv("DEST_PATH", "/source_media/Rogers/Movies"))
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
MEDIA_MOUNT_PREFIX = os.getenv("MEDIA_MOUNT_PREFIX", "/media/tc")
LOG_DIR = Path("/usr/app/storage")

RADARR_URL = os.getenv("RADARR_URL")
RADARR_API_KEY = os.getenv("RADARR_API_KEY")
SONARR_URL = os.getenv("SONARR_URL")
SONARR_API_KEY = os.getenv("SONARR_API_KEY")

LOG_DIR.mkdir(parents=True, exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_file = LOG_DIR / f"migrated_dirs_{timestamp}.txt"

# ----------------------------------------------------------
# Connectivity Check for Radarr/Sonarr
# ----------------------------------------------------------

def verify_api_connection():
    """
    Verifies connectivity to Radarr and Sonarr using provided API credentials.
    Logs full URLs and partial API keys for transparency.
    Exits early if a connection fails.
    """
    if RADARR_URL and RADARR_API_KEY:
        try:
            test_url = f"{RADARR_URL}/api/v3/movie"
            headers = {"X-Api-Key": RADARR_API_KEY}
            print(f"🔍 Verifying Radarr: {test_url}")
            print(f"🔑 API Key: {RADARR_API_KEY[:6]}...")

            response = requests.get(test_url, headers=headers, timeout=120)
            response.raise_for_status()
            print("✅ Connected to Radarr.")
        except Exception as e:
            print(f"❌ Failed to connect to Radarr:\n   URL: {test_url}\n   API Key: {RADARR_API_KEY}")
            print(f"   Error: {e}")
            exit(1)

    if SONARR_URL and SONARR_API_KEY:
        try:
            test_url = f"{SONARR_URL}/api/v3/series"
            headers = {"X-Api-Key": SONARR_API_KEY}
            print(f"🔍 Verifying Sonarr: {test_url}")
            print(f"🔑 API Key: {SONARR_API_KEY[:6]}...")

            response = requests.get(test_url, headers=headers, timeout=120)
            response.raise_for_status()
            print("✅ Connected to Sonarr.")
        except Exception as e:
            print(f"❌ Failed to connect to Sonarr:\n   URL: {test_url}\n   API Key: {SONARR_API_KEY}")
            print(f"   Error: {e}")
            exit(1)

    if not (RADARR_URL and RADARR_API_KEY) and not (SONARR_URL and SONARR_API_KEY):
        print("⚠️ No Radarr or Sonarr configuration detected. Skipping indexer updates.")

# ----------------------------------------------------------
# Rsync Utility with Dry-Run Preview
# ----------------------------------------------------------

def rsync_until_stable(src: Path, dest: Path) -> bool:
    """
    Repeatedly run rsync until no changes are detected.
    Uses a dry-run before each pass to determine if sync is stable.

    Args:
        src (Path): Source directory
        dest (Path): Destination directory

    Returns:
        bool: True if sync stabilized, False if failed
    """
    print(f"🔄 Starting rsync loop for {src.name}")
    max_attempts = 20

    for attempt in range(max_attempts):
        print(f"🧪 Dry-run check for rsync pass {attempt + 1}...")
        dry_run_cmd = [
            "rsync", "-auvn", "--delete", str(src) + "/", str(dest) + "/"
        ]
        result = subprocess.run(dry_run_cmd, capture_output=True, text=True)
        changes = result.stdout.strip().splitlines()

        actual_changes = [
            line for line in changes
            if line and not line.startswith("sending") and not line.startswith("sent ")
        ]

        if not actual_changes:
            print(f"✅ Sync stable for {src.name}")
            return True

        print(f"🔁 {len(actual_changes)} change(s) detected:")
        for line in actual_changes:
            print(f"   🔸 {line}")

        print(f"▶️ Running rsync pass {attempt + 1}...")
        rsync_cmd = [
            "rsync", "-au", "--delete", "--info=progress2", "--progress",
            str(src) + "/", str(dest) + "/"
        ]

        process = subprocess.Popen(
            rsync_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
            universal_newlines=True
        )

        with tqdm(total=100, desc=f"{src.name} Sync Progress", unit="%") as pbar:
            for line in process.stdout:
                print(line, end='')
                if "%" in line:
                    for part in line.strip().split():
                        if "%" in part:
                            try:
                                pbar.n = int(part.strip('%'))
                                pbar.refresh()
                            except ValueError:
                                continue

        if process.wait() != 0:
            print(f"❌ Rsync failed for {src}")
            return False

    print(f"❌ Max rsync attempts reached for {src}")
    return False


# ----------------------------------------------------------
# Radarr / Sonarr API Integration
# ----------------------------------------------------------

def update_radarr_path(original_path: str, new_path: str):
    """Update Radarr with the new path for a migrated movie."""
    if not (RADARR_URL and RADARR_API_KEY): return
    headers = {"X-Api-Key": RADARR_API_KEY}
    movies = requests.get(f"{RADARR_URL}/api/v3/movie", headers=headers).json()
    for movie in movies:
        if movie['path'] == original_path:
            movie['path'] = new_path
            r = requests.put(f"{RADARR_URL}/api/v3/movie", headers=headers, json=movie)
            r.raise_for_status()
            print(f"🎬 Radarr updated: {original_path} → {new_path}")
            return
    print(f"⚠️ No Radarr match for: {original_path}")

def update_sonarr_path(original_path: str, new_path: str):
    """Update Sonarr with the new path for a migrated series."""
    if not (SONARR_URL and SONARR_API_KEY): return
    headers = {"X-Api-Key": SONARR_API_KEY}
    shows = requests.get(f"{SONARR_URL}/api/v3/series", headers=headers).json()
    for show in shows:
        if show['path'] == original_path:
            show['path'] = new_path
            r = requests.put(f"{SONARR_URL}/api/v3/series/{show['id']}", headers=headers, json=show)
            r.raise_for_status()
            print(f"📺 Sonarr updated: {original_path} → {new_path}")
            return
    print(f"⚠️ No Sonarr match for: {original_path}")

def update_indexers(original_path: str, new_path: str):
    """
    Route indexer updates based on path patterns, rewriting paths
    from container-visible (/source_media) to Radarr/Sonarr-visible (/media/tc).
    """
    media_prefix = os.getenv("MEDIA_MOUNT_PREFIX", "/media/tc")

    rewritten_original = original_path.replace("/source_media", media_prefix)
    rewritten_new = new_path.replace("/source_media", media_prefix)

    if "/Movies" in original_path:
        update_radarr_path(rewritten_original, rewritten_new)
    elif "/TV Shows" in original_path:
        update_sonarr_path(rewritten_original, rewritten_new)


# ----------------------------------------------------------
# Migration Execution
# ----------------------------------------------------------

def migrate_dirs(dirs_to_move):
    """
    Perform migration for selected directories:
    - Sync using rsync until stable
    - Delete source after sync
    - Update Radarr/Sonarr

    Args:
        dirs_to_move (list): List of (Path, size) tuples to migrate
    """
    with open(log_file, "w") as log:
        for src_dir, size in dirs_to_move:
            rel_path = src_dir.relative_to(SOURCE)
            dest_dir = DEST / rel_path
            dest_dir.parent.mkdir(parents=True, exist_ok=True)

            print(f"\n🔁 Preparing migration: {src_dir} → {dest_dir} ({format_size(size)})")

            if rsync_until_stable(src_dir, dest_dir):
                shutil.rmtree(src_dir)
                print(f"🗑️ Deleted: {src_dir}")
                update_indexers(str(src_dir), str(dest_dir))
                log.write(f"{src_dir} → {dest_dir}\n")
            else:
                print(f"❌ Migration failed or unstable for {src_dir}. Skipping deletion.")

# ----------------------------------------------------------
# Main Control Flow
# ----------------------------------------------------------

def main():
    """
    Main control flow for the media migration process.
    """
    verify_api_connection()

    print(f"📁 Source: {SOURCE}")
    print(f"📁 Destination: {DEST}")

    src_root = "/" + SOURCE.parts[1] + "/" + SOURCE.parts[2]
    dst_root = "/" + DEST.parts[1] + "/" + DEST.parts[2]
    src_total, src_used, src_free, src_percent = get_df_usage(src_root)
    dst_total, dst_used, dst_free, dst_percent = get_df_usage(dst_root)

    print(f"📊 Source usage: {src_percent:.2f}% of {format_size(src_total)}")
    print(f"📦 Destination free space: {format_size(dst_free)}")

    if src_percent <= TARGET_UTILIZATION:
        print("✅ Source already below target utilization.")
        return

    bytes_to_free = src_used - (src_total * (TARGET_UTILIZATION / 100))
    print(f"🚚 Need to free: {format_size(bytes_to_free)}")

    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)
    total_move_size = sum(size for _, size in dirs_to_move)

    if total_move_size > dst_free:
        print(f"❌ Not enough space. Required: {format_size(total_move_size)}, Available: {format_size(dst_free)}")
        return

    print("\n📦 Directories to migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Migration log will be saved to: {log_file}")

    proceed = input("\nProceed with migration? [y/N]: ").lower().strip()
    if proceed == 'y':
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {log_file}")
    else:
        print("🚫 Migration cancelled.")

if __name__ == "__main__":
    main()
