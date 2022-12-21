# TC's Docker-based torrent rig

This docker set up allows you to deploy a protected torrenting stack in an OS-agnostic way.

I'm always refining and brainstorming (and open to suggestions).

This stack currently includes:

- A NordLynx container serving as the gateway to the web. It's server selection is configurable via docker-compose
- A qBittorrent container with a built-in health check that ensures the container has a protected path to the internet (is actually going out over nordlynx) and that qBittorrent is "connected" not firewalled or disconnected (which can sometimes happen as a result of a race condition between the connection to Nord and the startup of the qbittorrent service)
- Autoheal which monitors "unhealthy" container and restarts them until the become healthy. This, combined with the in-built IPTables config in nordlynx prevents connection issues and IP Leaks
- NginX reverse proxy provides an SSL interface for when you access qbittorrent's web UI. This way, if you're managing your torrents remotely, you have an encrypted connection
- DDNS via cloudflare so that you can maintain an external record of your residential IP to have continual remote access to the stack (you'll still need to configure your router)

## Getting started

Audit the docker-compose file and review the inline docs.

### Generating a NordVPN private key

```
bash ./get_nordvpn_private_key NORDVPN_USER NORDVPN_PASS
```

### Configure variables

Copy `.env.sample` to `.env` and edit the file to populate it with your values

### Starting the stack

```
bash ./build_stack
```
