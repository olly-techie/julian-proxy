#!/usr/bin/env node
/**
 * julian-proxy — foreground entrypoint.
 * Run detached for background use: `julian-proxy start`.
 */

import { createServer } from "./server.mjs";
import { config } from "./config.mjs";

const server = createServer();

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[julian-proxy] port ${config.port} is already in use.\n` +
        `             Another instance is probably running: julian-proxy --status\n` +
        `             Or pick another port:            JULIAN_PROXY_PORT=8789 npm start`,
    );
    process.exit(1);
  }
  console.error("[julian-proxy]", err);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[julian-proxy] listening on http://${config.host}:${config.port}`);
  console.log(`[julian-proxy] upstream: ${config.upstreamBase}`);
  console.log(
    config.fallbackApiKey
      ? "[julian-proxy] fallback key: OKEYMETA_API_KEY is set"
      : "[julian-proxy] no fallback key set; pass Authorization: Bearer <key> per request",
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Do not let a lingering keep-alive connection block shutdown.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
