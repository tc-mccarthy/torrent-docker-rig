FROM node:18-bullseye-slim

RUN apt-get -y update
RUN apt-get -y install ffmpeg

WORKDIR /usr/app

COPY package.json .
COPY yarn.lock .
RUN yarn install --only=prod

COPY . .
USER node
CMD ["bash", "./start-service"]