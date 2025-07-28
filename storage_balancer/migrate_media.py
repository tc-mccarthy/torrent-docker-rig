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
SOURCE = Path(os.getenv("SOURCE_PATH"))
DEST = Path(os.getenv("DEST_PATH"))
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
MEDIA_MOUNT_PREFIX = os.getenv("MEDIA_MOUNT_PREFIX", "/media/tc")
RADARR_URL = os.getenv("RADARR_URL")
RADARR_API_KEY = os.getenv("RADARR_API_KEY")
SONARR_URL = os.getenv("SONARR_URL")
SONARR_API_KEY = os.getenv("SONARR_API_KEY")
LOG_DIR = Path("/usr/app/storage")
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / f"migrated_dirs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"

def verify_api_connection():
    """Check Radarr and Sonarr connectivity before beginning."""
    if RADARR_URL and RADARR_API_KEY:
        try:
            print(f"🔍 Verifying Radarr: {RADARR_URL}")
            res = requests.get(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}, timeout=120)
            res.raise_for_status()
            print("✅ Connected to Radarr")
        except Exception as e:
            print(f"❌ Radarr Error (URL: {RADARR_URL}, Key: {RADARR_API_KEY}): {e}")
            exit(1)
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
    """Use df to get accurate disk usage."""
    result = subprocess.run(["df", "--output=size,used,avail,pcent", "-B1", path], capture_output=True, text=True)
    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        raise RuntimeError(f"Failed to parse df output for {path}")
    size, used, avail, percent = lines[1].split()
    return int(size), int(used), int(avail), int(percent.strip('%'))

def get_dir_sizes(path: Path):
    """Return dict of subdirectories and their sizes."""
    return {p: sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) for p in path.iterdir() if p.is_dir()}

def format_size(bytes_size):
    """Convert bytes to human-readable string."""
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """Select enough directories to move based on size."""
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: x[1], reverse=True)
    selected, total = [], 0
    for d, size in sorted_dirs:
        if total >= bytes_needed:
            break
        selected.append((d, size))
        total += size
    return selected

def rsync_until_stable(src: Path, dest: Path) -> bool:
    """
    Repeat rsync with dry-run until no changes detected.

    Args:
        src (Path): source path
        dest (Path): destination path

    Returns:
        bool: True if stable, False otherwise
    """
    max_attempts = 250
    for attempt in range(max_attempts):
        print(f"🧪 Dry-run rsync check #{attempt + 1}...")
        dry_run_cmd = ["rsync", "-auvn", "--delete", f"{src}/", f"{dest}/"]
        dry_result = subprocess.run(dry_run_cmd, capture_output=True, text=True)
        changes = [line for line in dry_result.stdout.strip().splitlines()
                   if line and not line.startswith("sending") and not line.startswith("sent ")]
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
    """Rewrite paths and update Radarr or Sonarr if matching type."""
    o = original_path.replace("/source_media", MEDIA_MOUNT_PREFIX)
    n = new_path.replace("/source_media", MEDIA_MOUNT_PREFIX)
    if "/Movies" in original_path:
        movies = requests.get(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}).json()
        for movie in movies:
            if movie['path'] == o:
                movie['path'] = n
                r = requests.put(f"{RADARR_URL}/api/v3/movie", headers={"X-Api-Key": RADARR_API_KEY}, json=movie)
                r.raise_for_status()
                print(f"🎬 Radarr updated: {o} → {n}")
    elif "/TV Shows" in original_path:
        shows = requests.get(f"{SONARR_URL}/api/v3/series", headers={"X-Api-Key": SONARR_API_KEY}).json()
        for show in shows:
            if show['path'] == o:
                show['path'] = n
                r = requests.put(f"{SONARR_URL}/api/v3/series/{show['id']}", headers={"X-Api-Key": SONARR_API_KEY}, json=show)
                r.raise_for_status()
                print(f"📺 Sonarr updated: {o} → {n}")

def migrate_dirs(dirs):
    """Perform migration of selected directories."""
    with open(LOG_FILE, "w") as log:
        for src, size in dirs:
            rel = src.relative_to(SOURCE)
            dest = DEST / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            print(f"\n🔁 Migrating {src} → {dest} ({format_size(size)})")
            if rsync_until_stable(src, dest):
                shutil.rmtree(src)
                print(f"🗑️ Deleted: {src}")
                update_indexers(str(src), str(dest))
                log.write(f"{src} → {dest}\n")
            else:
                print(f"❌ Failed: {src}. Skipped deletion.")

def main():
    verify_api_connection()
    src_root = "/" + SOURCE.parts[1] + "/" + SOURCE.parts[2]
    dst_root = "/" + DEST.parts[1] + "/" + DEST.parts[2]
    src_total, src_used, _, src_pct = get_df_usage(src_root)
    _, _, dst_free, _ = get_df_usage(dst_root)

    print(f"📊 Source usage: {src_pct}% of {format_size(src_total)}")
    if src_pct <= TARGET_UTILIZATION:
        print("✅ Source already below target.")
        return

    bytes_needed = src_used - (src_total * (TARGET_UTILIZATION / 100))
    print(f"🚚 Need to move: {format_size(bytes_needed)}")
    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_needed)
    total_move = sum(size for _, size in dirs_to_move)

    if total_move > dst_free:
        print(f"❌ Not enough space: need {format_size(total_move)}, have {format_size(dst_free)}")
        return

    print("\n📦 Will migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name}: {format_size(size)}")

    print(f"\n📝 Log: {LOG_FILE}")
    if input("Proceed? [y/N]: ").lower() == 'y':
        migrate_dirs(dirs_to_move)
        print("✅ Done")
    else:
        print("🚫 Cancelled")

if __name__ == "__main__":
    main()