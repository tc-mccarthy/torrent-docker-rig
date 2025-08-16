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

# Load environment variables
MEDIA_MOUNT_PREFIX = os.getenv("MEDIA_MOUNT_PREFIX", "/media/tc")
raw_source = os.getenv("SOURCE_PATH")
raw_dest = os.getenv("DEST_PATH")
if MEDIA_MOUNT_PREFIX in raw_source:
    raw_source = raw_source.replace(MEDIA_MOUNT_PREFIX, "/source_media")
if MEDIA_MOUNT_PREFIX in raw_dest:
    raw_dest = raw_dest.replace(MEDIA_MOUNT_PREFIX, "/source_media")
SOURCE = Path(raw_source)
DEST = Path(raw_dest)
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
RADARR_URL = os.getenv("RADARR_URL")
RADARR_API_KEY = os.getenv("RADARR_API_KEY")
SONARR_URL = os.getenv("SONARR_URL")
SONARR_API_KEY = os.getenv("SONARR_API_KEY")
LOG_DIR = Path("/usr/app/storage")
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / f"migrated_dirs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"

def verify_api_connection():
    """
    Check Radarr and Sonarr connectivity before beginning.

    Raises:
        SystemExit: If either Radarr or Sonarr API connection fails.
    """
    # Verify Radarr connection if configured
    if RADARR_URL and RADARR_API_KEY:
        try:
            print(f"🔍 Verifying Radarr: {RADARR_URL}")
            res = requests.get(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}, timeout=120)
            res.raise_for_status()
            print("✅ Connected to Radarr")
        except Exception as e:
            print(f"❌ Radarr Error (URL: {RADARR_URL}, Key: {RADARR_API_KEY}): {e}")
            exit(1)
    # Verify Sonarr connection if configured
    if SONARR_URL and SONARR_API_KEY:
        try:
            print(f"🔍 Verifying Sonarr: {SONARR_URL}")
            res = requests.get(f"{SONARR_URL}/api/v3/series", headers={"X-Api-Key": SONARR_API_KEY}, timeout=120)
            res.raise_for_status()
            print("✅ Connected to Sonarr")
        except Exception as e:
            print(f"❌ Sonarr Error (URL: {SONARR_URL}, Key: {SONARR_API_KEY}): {e}")
            exit(1)

def get_df_usage(path: str):
    """
    Use the 'df' command to get accurate disk usage statistics for a given path.

    Args:
        path (str): Filesystem path to check.

    Returns:
        tuple: (size, used, avail, percent) in bytes and percent used.

    Raises:
        RuntimeError: If df output cannot be parsed.
    """
    result = subprocess.run(["df", "--output=size,used,avail,pcent", "-B1", path], capture_output=True, text=True)
    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        raise RuntimeError(f"Failed to parse df output for {path}")
    size, used, avail, percent = lines[1].split()
    return int(size), int(used), int(avail), int(percent.strip('%'))

def get_dir_sizes(path: Path):
    """
    Calculate the size of each subdirectory within a given path.

    Args:
        path (Path): Directory to scan.

    Returns:
        dict: Mapping of Path objects to their total size in bytes.
    """
    return {p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) for p in path.iterdir() if p.is_dir()}

def format_size(bytes_size):
    """
    Convert a byte value to a human-readable string (e.g., GB, TB).

    Args:
        bytes_size (int): Size in bytes.

    Returns:
        str: Human-readable size string.
    """
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed, offset=0):
    """
    Select enough directories to move based on their size, skipping the first N largest.

    Args:
        dir_sizes (dict): Mapping of Path to size in bytes.
        bytes_needed (int): Total bytes to move.
        offset (int): Number of largest directories to skip.

    Returns:
        list: List of (Path, size) tuples to move.
    """
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: x[1], reverse=True)
    selected, total = [], 0

    # Apply offset
    sorted_dirs = sorted_dirs[offset:]

    for d, size in sorted_dirs:
        if total >= bytes_needed:
            break
        selected.append((d, size))
        total += size
    return selected

def rsync_until_stable(src: Path, dest: Path) -> bool:
    """
    Repeat rsync with dry-run until no changes detected, then perform actual rsync.

    Args:
        src (Path): Source directory path.
        dest (Path): Destination directory path.

    Returns:
        bool: True if sync is stable and successful, False otherwise.
    """
    # Try up to max_attempts to reach a stable rsync state
    max_attempts = 250
    for attempt in range(max_attempts):
        print(f"🧪 Dry-run rsync check #{attempt + 1}...")
        dry_run_cmd = ["rsync", "-auvn", "--delete", f"{src}/", f"{dest}/"]
        dry_result = subprocess.run(dry_run_cmd, capture_output=True, text=True)
        changes = [
            line for line in dry_result.stdout.strip().splitlines()
            if line
            and not line.startswith("sending")
            and not line.startswith("sent ")
            and not line.startswith("total size is")
            and not line.endswith("/")  # filter out dir-only updates
        ]

        if not changes:
            print(f"✅ Sync stable for {src.name}")
            return True
        print(f"🔁 {len(changes)} changes detected:")
        for c in changes:
            print(f"   🔸 {c}")

        print(f"▶️ Running real rsync for pass #{attempt + 1}...")
        rsync_cmd = ["rsync", "-au", "--delete", "--info=progress2", "--progress", f"{src}/", f"{dest}/"]
        with subprocess.Popen(rsync_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True) as proc:
            with tqdm(total=100, desc=f"{src.name} Sync", unit="%") as pbar:
                for line in proc.stdout:
                    print(line, end='')
                    if "%" in line:
                        for part in line.strip().split():
                            if "%" in part:
                                try:
                                    pbar.n = int(part.strip('%'))
                                    pbar.refresh()
                                except ValueError:
                                    continue
        if proc.returncode != 0:
            print(f"❌ Rsync failed for {src}")
            return False
    print(f"❌ Max rsync attempts reached for {src}")
    return False

def update_indexers(original_path: str, new_path: str):
    """
    Rewrite paths and update Radarr or Sonarr if the migrated directory matches their type.

    Args:
        original_path (str): Original directory path.
        new_path (str): New directory path after migration.
    """
    # Swap /source_media back to MEDIA_MOUNT_PREFIX for API updates
    o = original_path.replace("/source_media", MEDIA_MOUNT_PREFIX)
    n = new_path.replace("/source_media", MEDIA_MOUNT_PREFIX)
    if "/Movies" in original_path:
        # Update Radarr movie path if matched
        movies = requests.get(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}).json()
        for movie in movies:
            if movie['path'] == o:
                movie['path'] = n
                r = requests.put(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}, json=movie)
                r.raise_for_status()
                print(f"🎬 Radarr updated: {o} → {n}")
    elif "/TV Shows" in original_path:
        # Update Sonarr series path if matched
        shows = requests.get(f"{SONARR_URL}/api/v3/series", headers={"X-Api-Key": SONARR_API_KEY}).json()
        for show in shows:
            if show['path'] == o:
                show['path'] = n
                r = requests.put(f"{SONARR_URL}/api/v3/series/{show['id']}", headers={"X-Api-Key": SONARR_API_KEY}, json=show)
                r.raise_for_status()
                print(f"📺 Sonarr updated: {o} → {n}")

def migrate_dirs(dirs):
    """
    Perform migration of selected directories from source to destination.

    Args:
        dirs (list): List of (Path, size) tuples to migrate.
    """
    with open(LOG_FILE, "w") as log:
        for src, size in dirs:
            # Compute relative path and destination
            rel = src.relative_to(SOURCE)
            dest = DEST / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            print(f"\n🔁 Migrating {src} → {dest} ({format_size(size)})")
            # Use rsync to copy and verify stability
            if rsync_until_stable(src, dest):
                # Only delete after successful Radarr/Sonarr update
                api_update_success = True
                try:
                    update_indexers(str(src), str(dest))
                except Exception as e:
                    print(f"❌ API update failed for {src}: {e}")
                    api_update_success = False
                if api_update_success:
                    shutil.rmtree(src)
                    print(f"🗑️ Deleted: {src}")
                    log.write(f"{src} → {dest}\n")
                else:
                    print(f"❌ Skipped deletion due to failed API update: {src}")
            else:
                print(f"❌ Failed: {src}. Skipped deletion.")

def main():
    """
    Main entry point for the media migration utility.
    Orchestrates disk usage analysis, directory selection, and migration process.
    """
    # Step 1: Verify API connections
    verify_api_connection()

    # Step 2: Get root paths for df usage
    src_root = "/" + SOURCE.parts[1] + "/" + SOURCE.parts[2]
    dst_root = "/" + DEST.parts[1] + "/" + DEST.parts[2]
    src_total, src_used, _, src_pct = get_df_usage(src_root)
    _, _, dst_free, _ = get_df_usage(dst_root)

    print(f"📊 Source usage: {src_pct}% of {format_size(src_total)}")
    if src_pct <= TARGET_UTILIZATION:
        print("✅ Source already below target.")
        return

    # Step 3: Calculate bytes needed to move
    bytes_needed = src_used - (src_total * (TARGET_UTILIZATION / 100))
    print(f"🚚 Need to move: {format_size(bytes_needed)}")
    dir_sizes = get_dir_sizes(SOURCE)
    OFFSET = int(os.getenv("STORAGE_MIGRATION_OFFSET", "0"))
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_needed, offset=OFFSET)
    total_move = sum(size for _, size in dirs_to_move)

    # Step 4: Check destination free space
    if total_move > dst_free:
        print(f"❌ Not enough space: need {format_size(total_move)}, have {format_size(dst_free)}")
        return

    # Step 5: Print migration plan
    print("\n📦 Will migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name}: {format_size(size)}")

    print(f"\n📝 Log: {LOG_FILE}")
    # Step 6: Confirm and execute migration
    if input("Proceed? [y/N]: ").lower() == 'y':
        migrate_dirs(dirs_to_move)
        print("✅ Done")
    else:
        print("🚫 Cancelled")

if __name__ == "__main__":
    # Run the migration utility if executed as a script
    main()