# 🎞️ Media Migrator (Dockerized)

This tool helps you reduce disk usage on your source media volume by migrating movie (or TV) directories to a destination volume using `rsync`, inside a Docker container.

---

## 🚀 Features

- Automatically identifies which directories to move to meet a target disk utilization.
- Uses `rsync` with progress output.
- Prompts you before deleting originals.
- Writes a log file of all moved directories to `/usr/app/storage`.

---

## 📦 Requirements

- Docker installed on your system.
- Host paths like `/media/tc/Drax/Movies` and `/media/tc/Rogers/Movies`.

---

## 🧪 How to Use

### 1. Configure and run:

```bash
./run_migrator.sh
    