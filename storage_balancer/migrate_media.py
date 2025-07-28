#!/usr/bin/env python3

import os
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from tqdm import tqdm

# ------------------------------------------------------------------
# Configuration from environment variables (set via Docker or shell)
# ------------------------------------------------------------------

SOURCE = Path(os.getenv("SOURCE_PATH", "/source_media/Drax/Movies"))
DEST = Path(os.getenv("DEST_PATH", "/source_media/Rogers/Movies"))
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
LOG_DIR = Path("/usr/app/storage")

# Create log directory and prepare timestamped log file
LOG_DIR.mkdir(parents=True, exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_file = LOG_DIR / f"migrated_dirs_{timestamp}.txt"

# ------------------------------------------------------------------
# Utility Functions
# ------------------------------------------------------------------

def get_df_usage(path: str):
    """
    Returns accurate disk usage statistics by parsing `df`.

    Args:
        path (str): The mount point path (e.g. "/source_media/Drax").

    Returns:
        tuple: (total_bytes, used_bytes, available_bytes, percent_used_int)
    """
    result = subprocess.run(
        ["df", "--output=size,used,avail,pcent", "-B1", path],
        capture_output=True, text=True
    )

    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        raise RuntimeError(f"Failed to parse df output for {path}")

    size, used, avail, percent = lines[1].split()
    return int(size), int(used), int(avail), int(percent.strip('%'))

def get_dir_sizes(path: Path):
    """
    Calculate the total size of each immediate subdirectory under a path.

    Args:
        path (Path): Parent directory containing media directories.

    Returns:
        dict: Mapping of Path → total size in bytes.
    """
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            total = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = total
    return dirs

def format_size(bytes_size):
    """
    Convert a size in bytes to a human-readable string.

    Args:
        bytes_size (int): File size in bytes.

    Returns:
        str: Human-readable formatted size (e.g. "1.23 GB").
    """
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """
    Greedily select directories to move until required bytes are met.

    Args:
        dir_sizes (dict): Mapping of Path → size in bytes.
        bytes_needed (int): Total space to free.

    Returns:
        list: List of (Path, size) tuples selected for migration.
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

def rsync_with_progress(src: Path, dest: Path):
    """
    Run rsync with progress output. Skips newer destination files and preserves timestamps.

    Args:
        src (Path): Source directory path.
        dest (Path): Destination directory path.

    Returns:
        bool: True if rsync was successful, False otherwise.
    """
    rsync_cmd = [
        "rsync", "-a", "-u", "--info=progress2", "--progress",
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

# ------------------------------------------------------------------
# Migration Logic
# ------------------------------------------------------------------

def migrate_dirs(dirs_to_move):
    """
    Perform the migration: rsync each directory and delete source after success.

    Args:
        dirs_to_move (list): List of (Path, size) tuples selected for migration.
    """
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

# ------------------------------------------------------------------
# Main Control Flow
# ------------------------------------------------------------------

def main():
    """
    Orchestrates the full migration process:
    - Validates source volume usage
    - Estimates space to free
    - Selects directories
    - Confirms space on destination
    - Executes migration
    """
    print(f"📁 Source path: {SOURCE}")
    print(f"📁 Destination path: {DEST}")

    # Extract mount points based on known structure
    # e.g., /source_media/Drax is its own mounted volume
    src_root = "/" + SOURCE.parts[1] + "/" + SOURCE.parts[2]
    dst_root = "/" + DEST.parts[1] + "/" + DEST.parts[2]

    print(f"ℹ️ Checking disk usage for:")
    print(f"   - Source volume: {src_root}")
    print(f"   - Destination volume: {dst_root}")

    src_total, src_used, src_free, src_percent = get_df_usage(src_root)
    dst_total, dst_used, dst_free, dst_percent = get_df_usage(dst_root)

    print(f"📊 Source usage: {src_percent:.2f}% of {format_size(src_total)}")
    print(f"📦 Destination free space: {format_size(dst_free)}")

    if src_percent <= TARGET_UTILIZATION:
        print("✅ Source volume is already under target utilization.")
        return

    target_used = src_total * (TARGET_UTILIZATION / 100)
    bytes_to_free = src_used - target_used
    print(f"🚚 Need to free: {format_size(bytes_to_free)}")

    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)
    total_size_to_move = sum(size for _, size in dirs_to_move)

    if total_size_to_move > dst_free:
        print(f"❌ Not enough space on destination volume.")
        print(f"   Required: {format_size(total_size_to_move)}")
        print(f"   Available: {format_size(dst_free)}")
        return

    print("\n📦 Directories to migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Log will be saved to: {log_file}")

    proceed = input("\nProceed with migration? [y/N]: ").lower().strip()
    if proceed == 'y':
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {log_file}")
    else:
        print("🚫 Migration cancelled.")

# ------------------------------------------------------------------
# Entry Point
# ------------------------------------------------------------------

if __name__ == "__main__":
    main()
