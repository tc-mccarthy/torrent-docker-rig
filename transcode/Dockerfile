# FROM lscr.io/linuxserver/ffmpeg:latest
FROM ghcr.io/linuxserver/lspipepr-ffmpeg:6.1-cli-pkg-a5095ae8-dev-154a0501da71e45167217542b011bafec25f4c5b-pr-52

# Install NodeJS Dependencies and set up DEB repo
ENV NODE_MAJOR=20
RUN apt-get -y update
RUN apt-get -y install sqlite3 ca-certificates curl gnupg
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

# Install NodeJS
RUN apt-get -y update
RUN apt-get -y install nodejs
RUN npm i -g yarn

# Create a non-root user
RUN adduser --disabled-password --gecos "" node

# Set up directories in advance so we can control the permissions
RUN mkdir -p /usr/app && chown -R node:node /usr/app

# Set the work directory
WORKDIR /usr/app

# Copy over the dependencies
COPY --chown=node:node package.json .
COPY --chown=node:node yarn.lock .

# Install the dependencies
RUN yarn install

# Copy over application files
COPY --chown=node:node . .
RUN chmod +x /usr/app/start-service

# Start the service
ENTRYPOINT [ "/bin/bash", "/usr/app/start-service" ]