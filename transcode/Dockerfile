# FROM lscr.io/linuxserver/ffmpeg:latest
FROM linuxserver/ffmpeg:latest

# Install NodeJS Dependencies and set up DEB repo
ENV NODE_MAJOR=22
RUN apt-get -y update
RUN apt-get -y install sqlite3 ca-certificates curl gnupg iputils-ping
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list

# Install NodeJS
RUN apt-get -y update
RUN apt-get -y install nodejs
RUN npm i -g yarn


# Set up directories in advance so we can control the permissions
RUN mkdir -p /usr/app/bin && mkdir -p /usr/app/node_modules

# Set the work directory
WORKDIR /usr/app


## Dependencies are handled in their own layer so that we can leverage layer cache and save time on rebuild

# Copy over the dependencies
COPY package.json .
COPY yarn.lock .

# Install the dependencies
RUN yarn install

# Copy over application files
COPY . .
RUN chmod +x /usr/app/start-service

# Set ARGs and ENV vars
ARG BUILD_VERSION
ARG ENV

ENV ENV=${ENV}
ENV BUILD_VERSION=${BUILD_VERSION}
ENV NODE_ENV=${ENV}

# If this is a prod environment, package the code
RUN if [ "$ENV" != "local" ]; then yarn build; fi

# Start the service
ENTRYPOINT [ "/bin/bash", "/usr/app/start-service" ]