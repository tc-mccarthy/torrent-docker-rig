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
# Ensures relative paths work regardless of invocation location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -------------------------------------------------------------
# Configurable environment values
# -------------------------------------------------------------

# Set the source and destination media paths inside the container
export SOURCE_PATH="/source_media/Danvers/TV Shows"   # Source directory to migrate from
export DEST_PATH="/source_media/Romanoff/TV Shows"    # Destination directory to migrate to

# Set the target disk utilization percentage (float, e.g. 80)
export TARGET_UTILIZATION="80"

# Radarr API configuration (URL and API key)
export RADARR_URL="https://$TORRENT_SSL_HOST/radarr"
# export RADARR_API_KEY="your_radarr_api_key"   # Set externally or in environment

# Sonarr API configuration (URL and API key)
export SONARR_URL="https://$TORRENT_SSL_HOST/sonarr"
# export SONARR_API_KEY="your_sonarr_api_key"   # Set externally or in environment

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
# Build the Docker image from the current directory
docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"

echo "🚀 Launching media migrator container..."
# Run the container with all required environment variables and mounts
docker run --rm -it \
  -v $MEDIA_MOUNT_PREFIX:/source_media \  # Mount media volume for migration
  -v "$SCRIPT_DIR":/usr/app \              # Mount app directory for logs/scripts
  -w /usr/app \                            # Set working directory inside container
  -e SOURCE_PATH \                         # Pass source path to container
  -e DEST_PATH \                           # Pass destination path to container
  -e MEDIA_MOUNT_PREFIX \                  # Pass mount prefix for indexers
  -e TARGET_UTILIZATION \                  # Pass utilization target
  -e RADARR_URL \                          # Pass Radarr URL
  -e RADARR_API_KEY \                      # Pass Radarr API key
  -e SONARR_URL \                          # Pass Sonarr URL
  -e SONARR_API_KEY \                      # Pass Sonarr API key
  -e OFFSET=${STORAGE_MIGRATION_OFFSET} \  # Pass offset for migration (optional)
  "$IMAGE_NAME"

