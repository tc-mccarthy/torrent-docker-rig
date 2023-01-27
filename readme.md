<a name="readme-top"></a>

<h1 align="center">TC's docker-based media rig</h1>

<!-- ABOUT THE PROJECT -->

## About The Project

This docker stack has all of the pieces for setting up and maintaining a home grown media rig for acquiring, organizing and playing your favorite movies and TV shows.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

- [![NordVPN][nordvpn]][nordvpn-url]
- [![Docker][docker]][docker-url]
- [![ffmpeg][ffmpeg]][ffmpeg-url]
- [![portainer][portainer]][portainer-url]
- [![nodejs][nodejs]][nodejs-url]
- [![nginx][nginx]][nginx-url]
- [![cloudflare][cloudflare]][cloudflare-url]
- [![qbittorrent][qbittorrent]][qbittorrent-url]
- [![Sonarr][sonarr]][sonarr-url]
- [![Radarr][radarr]][radarr-url]
- [![Prowlarr][prowlarr]][prowlarr-url]
- [![tinyMediaManager][tinymediamanager]][tinymediamanager-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->

## Getting Started

- Duplicate `.env.sample` to `.env` and then update it with any values you can provide
- Audit the docker-compose file and review the inline docs.

### Prerequisites

- Have docker and docker compose installed
- Have your storage set up

### Generating a NordVPN private key

```
bash ./get_nordvpn_private_key NORDVPN_USER NORDVPN_PASS
```

Copy the key into the .env file

### Installation

1. Once you've got `.env` set up, run `bash ./build_stack`
2. [Configure Prowlarr](https://quickbox.io/knowledge-base/v2/applications/prowlarr/connect-prowlarr-to-sonarr/) to talk to Sonarr and Radarr. In the process of doing this, jot down Sonarr and Radarr's API keys and copy them into the `.env` file. The addresses for sonarr, radarr and qbittorrent are `localhost` and then their respective port numbers. Once you have this set up, configure the indexes you want Prowlarr to use. It will sync these with Sonarr and Radarr as you go.
3. Configure Sonarr and Radarr to use qbittorrent as your download client. Import any library you already have so that you configure monitoring
4. Configure your backups
5. Provide a cloudflare API key and subdomain in the `.env` so that the rig handles DDNS for you

<p align="right">(<a href="#readme-top">back to top</a>)</p>

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

<!-- USAGE EXAMPLES -->

## Usage

Each service is accessible via http://<ip|localhost>:<service-port>. There is also an nginx reverse proxy available at https://<ip|localhost|domain>:8080 with subdirectory access to services.

- https://<ip|localhost|domain>:8080/qbt - qBittorrent
- https://<ip|localhost|domain>:8080/backup/login.html - backup
- https://<ip|localhost|domain>:8080/sonarr - sonarr
- https://<ip|localhost|domain>:8080/radarr - radarr
- https://<ip|localhost|domain>:8080/prowlarr - prowlarr
- https://<ip|localhost|domain>:8080/portainer - portainer

I set this up this way so that, at your own risk, you can map some external DNS to your external IP and map a single external port back to your rig's port 8080.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->

## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->

<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->

[nordvpn]: https://img.shields.io/badge/nordvpn-000000?style=for-the-badge&logo=nordvpn&logoColor=white
[nordvpn-url]: https://nordvpn.com/
[sonarr]: https://img.shields.io/badge/sonarr-000000?style=for-the-badge&logo=sonarr&logoColor=white
[sonarr-url]: https://sonarr.tv/
[radarr]: https://img.shields.io/badge/radarr-000000?style=for-the-badge&logo=radarr&logoColor=white
[radarr-url]: https://radarr.video/
[prowlarr]: https://img.shields.io/badge/prowlarr-000000?style=for-the-badge&logo=prowlarr&logoColor=white
[prowlarr-url]: https://prowlarr.com/
[qbittorrent]: https://img.shields.io/badge/qbittorrent-000000?style=for-the-badge&logo=qbittorrent&logoColor=white
[qbittorrent-url]: https://www.qbittorrent.org/
[tinymediamanager]: https://img.shields.io/badge/tinymediamanager-000000?style=for-the-badge&logo=tinymediamanager&logoColor=white
[tinymediamanager-url]: https://www.tinymediamanager.org/
[docker]: https://img.shields.io/badge/docker-000000?style=for-the-badge&logo=docker&logoColor=white
[docker-url]: https://www.docker.com/
[ffmpeg]: https://img.shields.io/badge/ffmpeg-000000?style=for-the-badge&logo=ffmpeg&logoColor=white
[ffmpeg-url]: https://ffmpeg.org/
[portainer]: https://img.shields.io/badge/portainer-000000?style=for-the-badge&logo=portainer&logoColor=white
[portainer-url]: https://www.portainer.io/
[nodejs]: https://img.shields.io/badge/node.js-000000?style=for-the-badge&logo=nodedotjs&logoColor=white
[nodejs-url]: https://nodejs.org/en/
[nginx]: https://img.shields.io/badge/nginx-000000?style=for-the-badge&logo=nginx&logoColor=white
[nginx-url]: https://www.nginx.com/
[cloudflare]: https://img.shields.io/badge/cloudflare-000000?style=for-the-badge&logo=cloudflare&logoColor=white
[cloudflare-url]: https://www.cloudflare.com/
