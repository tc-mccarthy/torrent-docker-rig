# Use an official Python base image with pip and virtualenv support
FROM python:3.11-slim

# Set working directory in the container
WORKDIR /usr/app

# Install system dependencies required for rsync and tqdm
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        rsync \
        curl \
        ca-certificates \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

# Install required Python packages
RUN pip install requests tqdm

# Copy the migration script into the container
COPY migrate_media.py ./

# Create the storage directory for logs
RUN mkdir -p /usr/app/storage

# Make the script executable
RUN chmod +x /usr/app/migrate_media.py

# Default command to run the script
CMD ["python", "migrate_media.py"]