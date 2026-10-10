# The website's script, minified for the browser (about a fifth smaller). If the minifier can't be fetched (no
# network during a deploy or a standby takeover), the readable file is used as it is.
FROM node:24-alpine AS assets
WORKDIR /build
COPY public/app.js .
RUN (npx --yes esbuild@0.24.0 app.js --minify --target=es2020 --outfile=app.min.js --log-level=warning && node --check app.min.js) || cp app.js app.min.js

FROM node:24-alpine
WORKDIR /app
COPY . .
COPY --from=assets /build/app.min.js /app/public/app.js
RUN mkdir -p /data && chown -R node:node /app /data
ENV PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node","server.js"]
