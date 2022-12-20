# TC's Docker-based torrent rig

This docker set up allows you to deploy a protected torrenting stack in an OS-agnostic way.

I'm always refining and brainstorming (and open to suggestions).

This stack currently includes:

- A NordLynx container serving as the gateway to the web. It's server selection is configurable via docker-compose
- A qBittorrent container with a built-in health check that ensures the container has a protected path to the internet (is actually going out over nordlynx) and that qBittorrent is "connected" not firewalled or disconnected (which can sometimes happen as a result of a race condition between the connection to Nord and the startup of the qbittorrent service)
- Autoheal which monitors "unhealthy" container and restarts them until the become healthy. This, combined with the in-built IPTables config in nordlynx prevents connection issues and IP Leaks

## Starting up

Audit the docker-compose file and review the inline docs. If you need to generate a private key, you can do so by running the get_nordvpn_private_key script

```
bash ./get_nordvpn_private_key NORDVPN_USER NORDVPN_PASS
```

Copy the resulting key into the docker-compose file and then run

```
bash ./build_stack
```
