# 🎞️ Media Migrator (Dockerized)

This tool helps you reduce disk usage on your source media volume by migrating movie or TV directories to a destination volume using `rsync`, inside a Docker container. It supports Radarr/Sonarr integration and logs all migrations.

---

## 🚀 Features

- Automatically identifies which directories to move to meet a target disk utilization (configurable via `TARGET_UTILIZATION`).
- Uses `rsync` with progress output and repeated dry-run checks for safe migration.
- Verifies Radarr and Sonarr API connectivity before starting (if configured).
- Skips the first N largest directories with the `SKIP_FIRST_N_DIRS` environment variable (offset).
- Prompts for confirmation before deleting originals.
- Updates Radarr/Sonarr paths after migration (if enabled).
- Writes a log file of all moved directories to `/usr/app/storage`.

---

## 📦 Requirements

- Docker installed on your system.
- Host paths like `/media/tc/Drax/Movies` and `/media/tc/Rogers/Movies`.
- Radarr/Sonarr API keys and URLs (optional, for indexer updates).

---

## 🧪 How to Use

### 1. Configure environment variables

Edit `run_migrator.sh` to set:

- `SOURCE_PATH` and `DEST_PATH` (source and destination directories)
- `TARGET_UTILIZATION` (e.g. `80`)
- `MEDIA_MOUNT_PREFIX` (how indexers see your media)
- `RADARR_URL`, `RADARR_API_KEY`, `SONARR_URL`, `SONARR_API_KEY` (optional)
- `SKIP_FIRST_N_DIRS` (optional, skip N largest directories)

### 2. Run the migrator

```bash
./run_migrator.sh
```

---

## 📝 Logging & Safety

- All migrations are logged to `/usr/app/storage/migrated_dirs_<timestamp>.txt`.
- The script will prompt for confirmation before deleting any source directories.
- If Radarr/Sonarr API verification fails, migration will not proceed.

---

## 📚 Code Style

- All functions use Google-style docstrings and expressive comments for maintainability.

---

## 🛠️ Troubleshooting

- Ensure Docker has access to the media volumes.
- Check API keys and URLs for Radarr/Sonarr if using indexer updates.
- Review logs in `/usr/app/storage` for migration history.
