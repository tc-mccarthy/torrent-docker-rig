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

# Source and destination media directories (set in Docker or shell script)
SOURCE = Path(os.getenv("SOURCE_PATH", "/source_media/Drax/Movies"))
DEST = Path(os.getenv("DEST_PATH", "/source_media/Rogers/Movies"))

# Target usage (%) of the source volume after migration
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))

# Where to write migration logs (mounted on host via Docker)
LOG_DIR = Path("/usr/app/storage")

# Ensure log directory exists
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Timestamped log file path
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_file = LOG_DIR / f"migrated_dirs_{timestamp}.txt"

# --------------------------------------
# Utility Functions
# --------------------------------------

def get_disk_usage(path):
    """
    Return total, used, and free disk space for the filesystem containing `path`.
    """
    return shutil.disk_usage(path)

def get_dir_sizes(path):
    """
    Return a dictionary of subdirectory paths and their total size in bytes.
    """
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            total = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = total
    return dirs

def format_size(bytes_size):
    """
    Convert a size in bytes into a human-readable string.
    """
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """
    Greedily select a set of directories whose combined size
    is at least as large as `bytes_needed`.
    """
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
    """
    Run rsync to transfer contents of `src` to `dest`, displaying both
    per-file and total progress using TQDM.
    """
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
            print(line, end='')  # Print rsync output line-by-line

            # Attempt to extract percentage from lines like: "  45%   123MB   ..."
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

    return process.wait() == 0  # Return True if rsync exited successfully

# --------------------------------------
# Migration Logic
# --------------------------------------

def migrate_dirs(dirs_to_move):
    """
    For each selected directory:
    - Migrate using rsync
    - Automatically delete original after success
    - Log the migration
    """
    with open(log_file, "w") as log:
        for src_dir, size in dirs_to_move:
            rel_path = src_dir.relative_to(SOURCE)
            dest_dir = DEST / rel_path

            print(f"\n🔁 Migrating: {src_dir} → {dest_dir} ({format_size(size)})")

            # Ensure destination path exists
            dest_dir.parent.mkdir(parents=True, exist_ok=True)

            # Perform rsync
            success = rsync_with_progress(src_dir, dest_dir)

            if success:
                print(f"✅ Migration complete for: {src_dir}")
                log.write(f"{src_dir}\n")

                # Automatically delete source directory
                shutil.rmtree(src_dir)
                print(f"🗑️ Deleted original: {src_dir}")
            else:
                print(f"❌ Rsync failed for {src_dir}. Skipping delete.")

# --------------------------------------
# Main Control Flow
# --------------------------------------

def main():
    print(f"📁 Source: {SOURCE}")
    print(f"📁 Destination: {DEST}")

    # Get disk usage stats
    src_total, src_used, _ = get_disk_usage(SOURCE)
    dst_total, dst_used, dst_free = get_disk_usage(DEST)

    current_util = (src_used / src_total) * 100
    print(f"📊 Source usage: {current_util:.2f}% of {format_size(src_total)}")
    print(f"📦 Destination free space: {format_size(dst_free)}")

    # Exit early if we're already under the target utilization
    if current_util <= TARGET_UTILIZATION:
        print("✅ Usage is already below the target. No migration needed.")
        return

    # Determine how much space we need to free on the source
    target_bytes = src_total * (TARGET_UTILIZATION / 100)
    bytes_to_free = src_used - target_bytes
    print(f"🚚 Need to free approximately: {format_size(bytes_to_free)}")

    # Identify candidate directories to move
    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)
    total_size_to_move = sum(size for _, size in dirs_to_move)

    # Ensure destination has enough space
    if total_size_to_move > dst_free:
        print(f"❌ ERROR: Destination does not have enough space.")
        print(f"   Required: {format_size(total_size_to_move)}")
        print(f"   Available: {format_size(dst_free)}")
        return

    # Display the plan
    print("\n📦 Recommended directories to migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Log will be saved to: {log_file}")

    # Ask for final confirmation
    proceed = input("\nProceed with migration? [y/N]: ").lower().strip()
    if proceed == 'y':
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {log_file}")
    else:
        print("🚫 Migration cancelled.")

# Run main logic
if __name__ == "__main__":
    main()
