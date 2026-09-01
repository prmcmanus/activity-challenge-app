FROM node:24-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node","server.js"]
