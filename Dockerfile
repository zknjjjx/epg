FROM node:20-alpine

WORKDIR /app

COPY update.mjs server.mjs worker.js ./

ENV DATA_DIR=/data \
    PORT=8080 \
    ADMIN_PASSWORD=changeme \
    UPDATE_CRON=daily

EXPOSE 8080
VOLUME ["/data"]

CMD ["node", "server.mjs"]
