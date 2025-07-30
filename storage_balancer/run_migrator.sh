#!/bin/bash
set -e

# --------------------------------------------
# Change directory to where this script lives
# This ensures it works from anywhere
# --------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --------------------------------------------
# Configurable environment values
# --------------------------------------------

# Define the source and destination paths within the mounted volume
export SOURCE_PATH="/source_media/Danvers/TV Shows"
export DEST_PATH="/source_media/Romanoff/TV Shows"

# Set your target utilization percentage (float)
export TARGET_UTILIZATION="80"

# Radarr configuration
export RADARR_URL="https://$TORRENT_SSL_HOST/radarr"

# Sonarr configuration
export SONARR_URL="https://$TORRENT_SSL_HOST/sonarr"

# How Radarr and Sonarr see /source_media
export MEDIA_MOUNT_PREFIX="/media/tc"


# --------------------------------------------
# Docker image details
# --------------------------------------------

IMAGE_NAME="media-migrator"

echo "🛠️ Building Docker image: $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

echo "🚀 Launching media migrator container..."
docker run --rm -it \
  -v $MEDIA_MOUNT_PREFIX:/source_media \
  -v "$SCRIPT_DIR":/usr/app \
  -w /usr/app \
  -e SOURCE_PATH \
  -e DEST_PATH \
  -e MEDIA_MOUNT_PREFIX \
  -e TARGET_UTILIZATION \
  -e RADARR_URL \
  -e RADARR_API_KEY \
  -e SONARR_URL \
  -e SONARR_API_KEY \
  "$IMAGE_NAME"

