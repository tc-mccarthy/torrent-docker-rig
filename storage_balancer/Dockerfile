
# -------------------------------------------------------------
# Dockerfile for Media Migration Utility
# -------------------------------------------------------------

# Use an official Python base image (slim for smaller footprint)
FROM python:3.11-slim

# Set the working directory inside the container
WORKDIR /usr/app

# Install system dependencies required for migration and logging
# - rsync: for robust file transfer
# - curl, ca-certificates: for API connectivity
# - build-essential, git: for compatibility and debugging
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        rsync \
        curl \
        ca-certificates \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

# Install required Python packages for the migration script
# - requests: for API calls
# - tqdm: for progress bars
RUN pip install requests tqdm

# Copy the migration script into the container image
COPY migrate_media.py ./

# Create a directory for migration logs
RUN mkdir -p /usr/app/storage

# Make the migration script executable
RUN chmod +x /usr/app/migrate_media.py

# Set the default command to run the migration utility
CMD ["python", "migrate_media.py"]