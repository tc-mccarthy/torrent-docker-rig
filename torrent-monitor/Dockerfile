FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Copy code into container
COPY . .

# Install required packages
RUN pip install --no-cache-dir requests redis apscheduler

# Run the monitor script
CMD ["python", "monitor.py"]
