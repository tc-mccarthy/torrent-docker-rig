#!/bin/bash
set -e

# -------------------------------------------------------------
# Media Migrator Launcher Script
# -------------------------------------------------------------
# This script builds and runs the Docker container for the media
# migration utility, passing all required environment variables
# and mounting necessary volumes for operation.
# -------------------------------------------------------------

# Change to the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -------------------------------------------------------------
# Configurable environment values
# -------------------------------------------------------------

# Set the source and destination media paths inside the container
export SOURCE_PATH="/source_media/Danvers/TV Shows"
export DEST_PATH="/source_media/Romanoff/TV Shows"

# Set the target disk utilization percentage (float, e.g. 80)
export TARGET_UTILIZATION="80"

# Radarr API configuration (URL and API key)
export RADARR_URL="https://$TORRENT_SSL_HOST/radarr"
# export RADARR_API_KEY="your_radarr_api_key"

# Sonarr API configuration (URL and API key)
export SONARR_URL="https://$TORRENT_SSL_HOST/sonarr"
# export SONARR_API_KEY="your_sonarr_api_key"

# How Radarr/Sonarr see /source_media inside the container
export MEDIA_MOUNT_PREFIX="/media/tc"

# Optional: Offset for skipping N directories in migration
export STORAGE_MIGRATION_OFFSET=10

# -------------------------------------------------------------
# Docker image build and run
# -------------------------------------------------------------

# Name for the Docker image
IMAGE_NAME="media-migrator"

echo "🛠️ Building Docker image: $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

echo "🚀 Launching media migrator container..."
docker run --rm -it \
  -v "$MEDIA_MOUNT_PREFIX":/source_media \
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
  -e STORAGE_MIGRATION_OFFSET \
  "$IMAGE_NAME"
