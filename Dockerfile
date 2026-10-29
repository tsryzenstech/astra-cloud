FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json server.js ./
COPY lib lib
COPY public public
COPY seed seed
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
# ./data is created by Docker as root: hand it to the node user, then run
# the server as that user.
CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec su-exec node node server.js"]
