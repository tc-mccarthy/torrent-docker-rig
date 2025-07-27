FROM python:3.11-slim

# Install dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends rsync && \
    pip install tqdm && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /usr/app

# Copy script into container
COPY migrate_media.py .

# Create storage path for logs
RUN mkdir -p /usr/app/storage

# Entrypoint is the migration script
ENTRYPOINT ["python3", "migrate_media.py"]
