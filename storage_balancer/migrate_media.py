#!/usr/bin/env python3

import os
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from tqdm import tqdm

# Read configuration from environment variables
SOURCE = Path(os.getenv("SOURCE_PATH", "/source_media/Drax/Movies"))
DEST = Path(os.getenv("DEST_PATH", "/source_media/Rogers/Movies"))
TARGET_UTILIZATION = float(os.getenv("TARGET_UTILIZATION", "80"))
LOG_DIR = Path("/usr/app/storage")

# Create log directory if it doesn't exist
LOG_DIR.mkdir(parents=True, exist_ok=True)
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_file = LOG_DIR / f"migrated_dirs_{timestamp}.txt"

def get_disk_usage(path):
    total, used, _ = shutil.disk_usage(path)
    return total, used

def get_dir_sizes(path):
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            size = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = size
    return dirs

def format_size(bytes_size):
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: x[1], reverse=True)
    selected = []
    total = 0
    for d, size in sorted_dirs:
        if total >= bytes_needed:
            break
        selected.append((d, size))
        total += size
    return selected

def confirm(prompt):
    return input(f"{prompt} [y/N]: ").lower().strip() == 'y'

def rsync_with_progress(src, dest):
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

def migrate_dirs(dirs_to_move):
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
                if confirm(f"🗑️ Delete original folder {src_dir}?"):
                    shutil.rmtree(src_dir)
                    print(f"🗑️ Deleted: {src_dir}")
            else:
                print(f"❌ Rsync failed for {src_dir}")

def main():
    print(f"📁 Source: {SOURCE}")
    print(f"📁 Destination: {DEST}")

    total_bytes, used_bytes = get_disk_usage(SOURCE)
    current_util = (used_bytes / total_bytes) * 100
    print(f"📊 Source usage: {current_util:.2f}% of {format_size(total_bytes)}")

    if current_util <= TARGET_UTILIZATION:
        print("✅ Usage already below target.")
        return

    bytes_to_free = used_bytes - (total_bytes * (TARGET_UTILIZATION / 100))
    print(f"🚚 Need to free ~{format_size(bytes_to_free)}")

    dir_sizes = get_dir_sizes(SOURCE)
    dirs_to_move = pick_dirs_to_move(dir_sizes, bytes_to_free)

    print("\n📦 Recommended directories to move:")
    for d, size in dirs_to_move:
        print(f" - {d.name} ({format_size(size)})")

    print(f"\n📝 Log file will be saved to: {log_file}")

    if confirm("Proceed with migration?"):
        migrate_dirs(dirs_to_move)
        print(f"\n✅ Migration complete. Log saved to: {log_file}")
    else:
        print("🚫 Migration cancelled.")

if __name__ == "__main__":
    main()
