FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib lib
COPY public public
COPY seed seed
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
