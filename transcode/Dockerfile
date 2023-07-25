FROM node:18-bullseye-slim

# Install FFMPEG
RUN apt-get -y update
RUN apt-get -y install ffmpeg sqlite3

# Set up directories in advance so we can control the permissions
RUN mkdir -p /usr/app && chown -R node:node /usr/app

# Set the work directory
WORKDIR /usr/app

# Set the user
USER node

## Dependencies are handled in their own layer so that we can leverage layer cache and save time on rebuild

# Copy over the dependencies
COPY --chown=node:node package.json .
COPY --chown=node:node yarn.lock .

# Install the dependencies
RUN yarn install

# Copy over application files
COPY --chown=node:node . .

# Start the service
CMD ["bash", "./start-service"]