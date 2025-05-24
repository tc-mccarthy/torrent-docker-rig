# Newsday ExpressJS/Docker template

Microservices are becoming the name of the game. Much what we are building are API-only microservices. Here's a template to get started quickly!

## Getting started

Search and replace `express-docker-template` with the name of your service (slugified). Then run `bash ./rebuild` to start up. Then begin development!

## File descriptions

**build-image** | This script will bake a fresh docker image with all of your code and push it to docker hub using the current timestamp as a tag. Modify this file to reflect the username/repo_name of your image's repo and it will do the rest

**rebuild** | Helpful for rebuilding your docker container locally to rule out issues with missing packages or scrambled mounts due to branch changes.

## To access your microservice

One of two ways to do this is to add an `nginx` rule to the `local.tools.newsday.com.conf` (assuming the microservice lives in `devsign/tools` file in the nginx `sites-available` directory).

1. Go to the `sites-available` directory located in `<your virtual_machines directory->/proxy/nginx-config/`
2. Open the file `local.tools.newsday.com.conf` in your preferred text editor.

   To open the file in `nano` for example use the command `nano local.tools.newsday.conf`

3. Inside the file you will find various rules for different microservices that follow a similar format. Use the format below to add an additional rule for your microservice, note the braces mark the rule blocks so ensure your rule isn't placed inside another rule block.

```nginx
location ~ /<preferred URL for microservice>(.*) {
    proxy_set_header HTTP_X_FORWARDED_PROTO https;
    set $upstream http://<hostname>:3000$1$is_args$args;
    proxy_pass  $upstream;
}
```

where `hostname` is the `hostname` for your microservice as defined in its `docker-compose.yaml` file. 4. Save, exit and then restart Docker (one is to click the docker icon in the menu bar on the tip and click "Restart").

Ensure your microservice is running (execute the `bash rebuild` command) then navigate to `local.tools.newsday.com/<your microservice endpoint>` and you should be able to see some message indicating the microservice is online.
