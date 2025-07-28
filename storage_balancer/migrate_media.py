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
    """Get disk usage statistics for a given path using the `df` command.

    Args:
        path (str): The filesystem path to check.

    Returns:
        tuple: (total_bytes, used_bytes, free_bytes, percent_used_int)
            - total_bytes (int): Total size of the filesystem in bytes.
            - used_bytes (int): Used space in bytes.
            - free_bytes (int): Available space in bytes.
            - percent_used_int (int): Percentage of space used (integer).

    Raises:
        RuntimeError: If the output of `df` cannot be parsed.
    """
    # Use the system 'df' command to get accurate disk usage stats for the given path.
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
    """Calculate the total size of each subdirectory in a given path.

    Args:
        path (Path): The parent directory to scan.

    Returns:
        dict: Mapping of Path objects (subdirectories) to their total size in bytes.
    """
    # Walk through each subdirectory and sum the size of all files within.
    dirs = {}
    for item in path.iterdir():
        if item.is_dir():
            # Use rglob to recursively find all files and sum their sizes.
            size = sum(f.stat().st_size for f in item.rglob('*') if f.is_file())
            dirs[item] = size
    return dirs

def format_size(bytes_size):
    """Convert a size in bytes to a human-readable string with appropriate units.

    Args:
        bytes_size (int or float): The size in bytes.

    Returns:
        str: Human-readable string (e.g., '1.23 GB').
    """
    # Iterate through units, dividing by 1024 each time, until the value is small enough.
    for unit in ['B','KB','MB','GB','TB']:
        if bytes_size < 1024.0:
            return f"{bytes_size:.2f} {unit}"
        bytes_size /= 1024.0
    return f"{bytes_size:.2f} PB"

def pick_dirs_to_move(dir_sizes, bytes_needed):
    """Select a set of directories whose combined size meets or exceeds the required space.

    Uses a greedy algorithm, picking the largest directories first.

    Args:
        dir_sizes (dict): Mapping of Path objects to their size in bytes.
        bytes_needed (int): The minimum total size to select (in bytes).

    Returns:
        list: List of Path objects to move.
    """
    # Sort directories by size (largest first) and select until the total meets the requirement.
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: x[1], reverse=True)
    selected = []
    total = 0
