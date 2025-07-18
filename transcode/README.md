# Transcode Service

The `transcode` directory provides a modular, resource-aware video transcoding service designed for automated media workflows. It manages job scheduling, system resource monitoring, and integration with external tools (like ffmpeg), making it suitable for use in media server stacks or automated pipelines.

## Features

- **Job Queue Management:** Schedules and executes transcoding jobs based on system resource availability and job priority.
- **Resource Monitoring:** Dynamically adjusts job concurrency based on real-time system memory usage to prevent overload.
- **Extensible Architecture:** Easily integrates with custom job generators, logging, and external processing logic.
- **Web Interface (Optional):** Includes a simple web UI for monitoring and control (see `output/`).

## Running in Docker

A `Dockerfile` is provided for containerized deployments. Ensure your media files are accessible to the container via a volume mount.

```sh
docker build -t transcode-service .
docker run -v /path/to/media:/media transcode-service
```

---

# File Reference

Below is a detailed description of the key files and directories in the `transcode` project:

## bin/
- **server.js**: Entry point for starting the transcode service. Sets up the job queue and any required listeners or web interfaces.

## lib/
- **transcodeQueue.js**: Implements the main job queue and scheduler. Monitors system resources, applies compute penalties, and schedules jobs based on priority and available compute. Handles job execution and cleanup.
- **transcode.js**: Contains the core transcoding logic, typically invoking ffmpeg or similar tools to process media files. Receives jobs from the queue and manages the transcoding process.
- **generate_filelist.js**: Scans for files needing transcoding and generates a list of jobs. Can be customized to define job discovery logic.
- **generate_transcode_instructions.js**: Generates detailed instructions or command-line arguments for transcoding jobs, ensuring the correct parameters are passed to the transcoder based on job requirements and media metadata.
- **logger.mjs**: Provides logging utilities for info, debug, and error messages throughout the service.
- **update_active.js**: Updates the status of active jobs in the system, ensuring the queue and job list remain in sync.
- **dayjs.js**: Utility for date and time manipulation, used for timestamping and scheduling.
- **db_cleanup.js**: Handles cleanup of database records related to completed or failed jobs.
- **deleteDeletedByTMM.js**: Removes files or records that have been deleted by the TinyMediaManager (TMM) integration.
- **exec_promise.js**: Utility for executing shell commands as promises, used for running external tools like ffmpeg.
- **ffprobe.js**: Integrates with ffprobe to extract media metadata for job analysis and validation.
- **fs_monitor.js**: Monitors filesystem changes to trigger job generation or updates.
- **fs.js**: Filesystem utility functions used throughout the service.
- **generate_integrity_filelist.js**: Generates file lists for integrity checking.
- **integrityCheck.js**: Performs integrity checks on media files to ensure successful processing.
- **integrityQueue.js**: Manages a queue for integrity check jobs, similar to the transcode queue.
- **lang.js**: Handles language and localization utilities.
- **memcached.js**: Integrates with Memcached for caching job or file metadata.
- **metrics.js**: Collects and reports service metrics (e.g., job throughput, errors).
- **mongo_connection.js**: Manages MongoDB connections for job and file metadata storage.
- **moveFile.js**: Handles moving files as part of the transcoding or post-processing workflow.
- **pre_sanitize.js**: Pre-processes and sanitizes job inputs before transcoding.
- **probe_and_upsert.js**: Probes files for metadata and upserts records into the database.
- **rabbitmq.js**: Integrates with RabbitMQ for distributed job queueing (if used).
- **redis.js**: Integrates with Redis for caching or queue management.
- **round-compute-score.js**: Utility for rounding compute scores for job scheduling.
- **sqs_poller.js.sample**: Sample integration for polling AWS SQS for jobs.
- **tmdb_api.js**: Integrates with The Movie Database (TMDb) API for metadata enrichment.
- **update_queue.js**: Updates the job queue state.
- **update_status.js**: Updates the status of individual jobs.
- **upsert_video.js**: Inserts or updates video records in the database.
- **wait.js**: Utility for introducing delays in async workflows.

## models/
- **cleanup.js**: Handles cleanup logic for job and file models.
- **error.js**: Defines error models for job processing.
- **files.js**: Models for file metadata and job tracking.
- **integrityError.js**: Models for integrity check errors.

## output/
- **index.html**: Main entry point for the web UI.
- **src/**: Contains React components and styles for the web interface.

## Dockerfile
Defines the build steps for containerizing the transcode service.

## package.json
Lists Node.js dependencies and scripts for building and running the service.

## webpack.config.js
Configuration for building the web UI with Webpack.

---

# Detailed File Sections

## lib/transcode.js
This file contains the core transcoding logic for the service. It is responsible for:
- Invoking ffmpeg (or similar tools) to process media files according to job specifications.
- Handling input and output file paths, transcoding parameters, and error management.
- Integrating with the job queue to receive jobs and report completion or failure.
- Supporting extensibility for custom transcoding workflows or additional processing steps.

## lib/transcodeQueue.js
This file implements the main job queue and scheduler. Its responsibilities include:
- Managing a pool of active transcoding jobs and tracking their compute usage.
- Monitoring system resources (especially memory) and applying penalties to reduce concurrency under high load.
- Scheduling jobs based on priority, available compute, and job requirements.
- Preventing duplicate jobs and ensuring high-priority jobs are not starved.
- Handling job execution, cleanup, and file list regeneration after job completion.

## lib/generate_transcode_instructions.js
This file generates detailed instructions or command-line arguments for each transcoding job. It is responsible for:
- Translating job requirements and media metadata into the correct ffmpeg (or other transcoder) command-line options.
- Ensuring that the transcoding process receives all necessary parameters for codecs, bitrates, resolutions, and other settings.
- Supporting customization for different media types, target formats, or workflow needs.

---

# License

MIT License
