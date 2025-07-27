#!/usr/bin/env python3

import os
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from tqdm import tqdm

# --------------------------------------
# Configuration from environment vars
# --------------------------------------

SOURCE = Path(os.getenv("SOURCE_PATH", "/source_media/Drax/Movies"))
DEST = Path(os.getenv("DEST_PATH", "/source_media/Rogers/Movies"))
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
LOG_DIR = Path("/usr/app/storage")

LOG_DIR.mkdir(parents=True, exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_file = LOG_DIR / f"migrated_dirs_{timestamp}.txt"

# --------------------------------------
# Utility Functions
# --------------------------------------

def get_disk_usage(path: Path):
    """Returns total, used, free bytes for the filesystem where path is mounted."""
    return shutil.disk_usage(str(path))

def get_dir_sizes(path: Path):
    """Returns dictionary of directory sizes in bytes."""
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            size = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = size
    return dirs

def format_size(bytes_size):
    """Human-readable byte formatter."""
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """Greedy algorithm to pick enough directories to move."""
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: x[1], reverse=True)
    selected = []
    total = 0
    for d, size in sorted_dirs:
        if total >= bytes_needed:
            break
        selected.append((d, size))
        total += size
    return selected

def rsync_with_progress(src, dest):
    """Run rsync and capture file-level and job-level progress."""
    rsync_cmd = [
        "rsync", "-a", "--info=progress2", "--progress",
        str(src) + "/", str(dest) + "/"
    ]

    process = subprocess.Popen(
        rsync_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        universal_newlines=True
    )

    with tqdm(total=100, desc="Total Progress", unit="%") as pbar:
        for line in process.stdout:
            print(line, end='')

            if "%" in line:
                parts = line.strip().split()
                for part in parts:
                    if "%" in part:
                        try:
                            percent = int(part.strip('%'))
                            pbar.n = percent
                            pbar.refresh()
                        except ValueError:
                            continue

    return process.wait() == 0

# --------------------------------------
# Migration Logic
# --------------------------------------

def migrate_dirs(dirs_to_move):
    """Rsync and auto-delete source directories after successful transfer."""
    with open(log_file, "w") as log:
        for src_dir, size in dirs_to_move:
            rel_path = src_dir.relative_to(SOURCE)
            dest_dir = DEST / rel_path

            print(f"\n🔁 Migrating: {src_dir} → {dest_dir} ({format_size(size)})")
            dest_dir.parent.mkdir(parents=True, exist_ok=True)

            success = rsync_with_progress(src_dir, dest_dir)

            if success:
                print(f"✅ Migration done: {src_dir}")
                log.write(f"{src_dir}\n")
                shutil.rmtree(src_dir)
                print(f"🗑️ Deleted original: {src_dir}")
            else:
                print(f"❌ Rsync failed for {src_dir}. Skipping delete.")

# --------------------------------------
# Main Control Flow
# --------------------------------------

def main():
    print(f"📁 Source path: {SOURCE}")
    print(f"📁 Destination path: {DEST}")

    # Disk usage should be checked at the mount point (e.g., /source_media)
    src_root = Path("/".join(SOURCE.parts[:3]))  # /source_media
    dst_root = Path("/".join(DEST.parts[:3]))    # /source_media

    print(f"ℹ️ Checking disk usage for source mount: {src_root}")
    print(f"ℹ️ Checking disk usage for destination mount: {dst_root}")

    src_total, src_used, _ = get_disk_usage(src_root)
    dst_total, dst_used, dst_free = get_disk_usage(dst_root)

    current_util = (src_used / src_total) * 100
    print(f"📊 Source usage: {current_util:.2f}% of {format_size(src_total)}")
    print(f"📦 Destination free space: {format_size(dst_free)}")

    if current_util <= TARGET_UTILIZATION:
        print("✅ Usage already below target.")
        return

    target_used = src_total * (TARGET_UTILIZATION / 100)
    bytes_to_free = src_used - target_used
    print(f"🚚 Need to free approximately: {format_size(bytes_to_free)}")

    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)
    total_size_to_move = sum(size for _, size in dirs_to_move)

    # Double-check space on destination
    if total_size_to_move > dst_free:
        print(f"❌ ERROR: Not enough space on destination volume.")
        print(f"   Required: {format_size(total_size_to_move)}")
        print(f"   Available: {format_size(dst_free)}")
        return

    # Migration plan summary
    print("\n📦 Recommended directories to migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Migration log will be saved to: {log_file}")

    # Final user confirmation
    proceed = input("\nProceed with migration? [y/N]: ").lower().strip()
    if proceed == 'y':
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {l
