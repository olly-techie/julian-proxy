# julian-proxy — OkeyMeta/Julian as an OpenAI Responses API endpoint.
#
#   docker build -t julian-proxy .
#   docker run --rm -p 8788:8788 -e OKEYMETA_API_KEY=okeymeta-... julian-proxy
#
# The container runs in the foreground. For a long-running background proxy,
# add `-d` and use `docker logs -f`.

FROM node:22-alpine

# dumb-init gives PID 1 correct signal handling, so SIGTERM shuts the server
# down cleanly instead of waiting out the kill timeout.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    JULIAN_PROXY_HOST=0.0.0.0 \
    JULIAN_PROXY_PORT=8788

WORKDIR /app

# No runtime dependencies, so a plain copy is enough; keep it that way.
COPY package.json ./
COPY src ./src
COPY bin ./bin

# Run unprivileged. node:alpine already ships a `node` user (uid 1000).
USER node

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.JULIAN_PROXY_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.mjs"]
