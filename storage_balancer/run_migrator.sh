#!/bin/bash

# Exit immediately on error
set -e

# User-configurable values
SOURCE_PATH="/source_media/Drax/Movies"
DEST_PATH="/source_media/Rogers/Movies"
TARGET_UTILIZATION="80"

# Image and container names
IMAGE_NAME="media-migrator"
SCRIPT_NAME="migrate_media.py"

# Build Docker image
echo "🔧 Building Docker image..."
docker build -t "$IMAGE_NAME" .

# Run migration container with config as environment variables
echo "🚀 Running migration..."
docker run --rm -it \
  -v /media/tc:/source_media \
  -v "$(pwd)":/usr/app \
  -e SOURCE_PATH="$SOURCE_PATH" \
  -e DEST_PATH="$DEST_PATH" \
  -e TARGET_UTILIZATION="$TARGET_UTILIZATION" \
  "$IMAGE_NAME"
