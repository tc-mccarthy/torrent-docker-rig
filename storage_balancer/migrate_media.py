#!/usr/bin/env python3

import os
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from tqdm import tqdm

# --------------------------------------
# Configuration from environment
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

def get_df_usage(path: str):
    """
    Uses `df` to retrieve accurate disk usage stats.
    Returns: (total_bytes, used_bytes, free_bytes, percent_used_int)
    """
    result = subprocess.run(
        ["df", "--output=size,used,avail,pcent", "-B1", path],
        capture_output=True, text=True
    )

    lines = result.stdout.strip().split("\n")
    if len(lines) < 2:
        raise RuntimeError("Failed to parse df output")

    size, used, avail, percent = lines[1].split()
    return int(size), int(used), int(avail), int(percent.strip('%'))

def get_dir_sizes(path: Path):
    """Returns dictionary of {directory: total size in bytes}."""
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            size = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = size
    return dirs

def format_size(bytes_size):
    """Convert bytes to human-readable string."""
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """Greedy algorithm to choose enough dirs to free space."""
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
    Uses rsync to migrate with progress display.
    - -a: archive mode (preserve permissions, timestamps)
    - -u: skip destination files that are newer
    - --progress + --info=progress2: show file + total progress
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

# --------------------------------------
# Migration Logic
# --------------------------------------

def migrate_dirs(dirs_to_move):
    """Migrate directories using rsync, delete source after success, and log actions.

    Args:
        dirs_to_move (list): List of (Path, int) tuples, where Path is the directory to move and int is its size in bytes.

    This function iterates over the directories to move, performs the migration using rsync (with progress),
    deletes the source directory if migration is successful, and logs the operation to a file.
    """
    with open(log_file, "w") as log:
        for src_dir, size in dirs_to_move:
            # Compute the destination path relative to the source root.
            rel_path = src_dir.relative_to(SOURCE)
            dest_dir = DEST / rel_path

            print(f"\n🔁 Migrating: {src_dir} → {dest_dir} ({format_size(size)})")
            # Ensure the destination parent directory exists.
            dest_dir.parent.mkdir(parents=True, exist_ok=True)

            # Use rsync to copy the directory, showing progress.
            success = rsync_with_progress(src_dir, dest_dir)

            if success:
                print(f"✅ Migration done: {src_dir}")
                log.write(f"{src_dir}\n")
                # Remove the original directory after successful migration.
                shutil.rmtree(src_dir)
                print(f"🗑️ Deleted original: {src_dir}")
            else:
                print(f"❌ Rsync failed for {src_dir}. Skipping delete.")

# --------------------------------------
# Main Program Logic
# --------------------------------------

def main():
    """Main program logic for storage migration.

    This function checks disk usage, determines if migration is needed, selects directories to move,
    confirms available space on the destination, and prompts the user to proceed with migration.
    """
    print(f"📁 Source: {SOURCE}")
    print(f"📁 Destination: {DEST}")

    # Use `df` to get disk stats for the source and destination root mount points.
    src_root = "/".join(SOURCE.parts[:2])  # e.g., "/source_media"
    dst_root = "/".join(DEST.parts[:2])    # e.g., "/source_media"

    print(f"ℹ️ Checking usage via df for: {src_root} and {dst_root}")

    src_total, src_used, src_free, src_percent = get_df_usage(src_root)
    dst_total, dst_used, dst_free, dst_percent = get_df_usage(dst_root)

    print(f"📊 Source usage: {src_percent:.2f}% of {format_size(src_total)}")
    print(f"📦 Destination free space: {format_size(dst_free)}")

    # If the source is already under the target utilization, no migration is needed.
    if src_percent <= TARGET_UTILIZATION:
        print("✅ Source already under target utilization.")
        return

    # Calculate how many bytes need to be freed to reach the target utilization.
    target_used = src_total * (TARGET_UTILIZATION / 100)
    bytes_to_free = src_used - target_used
    print(f"🚚 Need to free: {format_size(bytes_to_free)}")

    # Get the size of each subdirectory in the source directory.
    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)
    total_size_to_move = sum(size for _, size in dirs_to_move)

    # Confirm that the destination has enough free space for the migration.
    if total_size_to_move > dst_free:
        print(f"❌ Not enough space on destination.")
        print(f"   Required: {format_size(total_size_to_move)}")
        print(f"   Available: {format_size(dst_free)}")
        return

    print("\n📦 Directories to migrate:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Log will be saved to: {log_file}")

    # Prompt the user for confirmation before proceeding.
    proceed = input("\nProceed with migration? [y/N]: ").lower().strip()
    if proceed == 'y':
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {log_file}")
    else:
        print("🚫 Migration cancelled.")

# --------------------------------------
# Entry Point
# --------------------------------------

if __name__ == "__main__":
    # Run the main migration logic if this script is executed directly.
    main()
