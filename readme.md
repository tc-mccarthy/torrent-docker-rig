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

## Configuration Recommendations

### Setting filesystem permissions

After your initial startup you may need to adjust your host FS permissions to be able to see certs and the qbittorrent config. As such, I recommend running the following after your initial start from within the parent directory

```
sudo chown -R $(whoami):$(whoami) .
```

This will take possession of all of the directories created by your containers. Run the build script again after doing this to ensure nginx can grab your cert

### Locking down qBittorrent to only use nordlynx

This stack has health checks on both the nordlynx and qbittorrent containers to ensure you're connected to nordvpn and that qbittorrent is actively using that connection. Containers will be restarted by autoheal if either of those things fails. However, I would also bind qbittorrent to the wg0 interface, ensuring that traffic only goes out over wireguard (nordlynx). You can do this by modifying the qbittorrent config

`config/qBittorrent/qBittorrent.conf` (You'll need to have started the stack once and possibly corrected permissions before you can see this)

Changing

```
Session\Interface=
```

to say

```
Session\Interface=wg0
```

### Use vuetorrent

I say this simply because my use case has me monitoring and adding torrents from my phone, and vuetorrent is awesome for that. I included a /vuetorrent directory within the torrent container and it points to `./vuetorrent` -- it's not my project so I am not going to distribute it, but I dropped a readme file in there to tell you how to get it!
