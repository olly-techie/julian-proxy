/**
 * Configuration, resolved from environment variables.
 * Every value has a working default so `npm start` needs no setup.
 */

const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  host: process.env.JULIAN_PROXY_HOST ?? "127.0.0.1",
  port: int(process.env.JULIAN_PROXY_PORT, 8788),

  upstreamBase: (process.env.JULIAN_PROXY_UPSTREAM ?? "https://api.okeymeta.com.ng/v1").replace(/\/+$/, ""),
  upstreamHost: process.env.JULIAN_PROXY_UPSTREAM_HOST ?? "api.okeymeta.com.ng",

  /** Fallback API key when the client does not send an Authorization header. */
  fallbackApiKey: process.env.OKEYMETA_API_KEY ?? "",

  /** Connection/read timeout for a single upstream request, ms. */
  upstreamTimeout: int(process.env.JULIAN_PROXY_TIMEOUT, 20_000),

  /** Streaming responses get a longer ceiling since tokens trickle in slowly. */
  upstreamStreamTimeout: int(process.env.JULIAN_PROXY_STREAM_TIMEOUT, 120_000),

  /** Attempts for connection failures and upstream 429s. */
  maxAttempts: int(process.env.JULIAN_PROXY_MAX_ATTEMPTS, 3),

  /** Base backoff between retries, ms (grows linearly per attempt). */
  retryBackoff: int(process.env.JULIAN_PROXY_RETRY_BACKOFF, 500),

  // Deliberately NOT under XDG_RUNTIME_DIR: that variable is absent in some
  // shells and containers, which would silently split the PID file across
  // locations and make `status`/`stop` disagree with reality.
  /** Directory for runtime state (PID file, log) written by the CLI. */
  stateDir:
    process.env.JULIAN_PROXY_STATE_DIR ??
    (process.platform === "win32"
      ? `${process.env.LOCALAPPDATA ?? process.env.TEMP ?? "."}\\julian-proxy`
      : `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? "."}/.local/state`}/julian-proxy`),

  pidFile: process.env.JULIAN_PROXY_PID_FILE ?? "",
  logFile: process.env.JULIAN_PROXY_LOG_FILE ?? "",
};

// Resolve against stateDir unless explicitly overridden.
config.pidFile ||= `${config.stateDir}/julian-proxy.pid`;
config.logFile ||= `${config.stateDir}/julian-proxy.log`;
