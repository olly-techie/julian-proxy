#!/usr/bin/env node
/**
 * julian-proxy CLI — cross-platform process control.
 *
 *   julian-proxy            start detached (default)
 *   julian-proxy start      start detached
 *   julian-proxy foreground run in this terminal (same as `npm start`)
 *   julian-proxy stop       stop the detached instance
 *   julian-proxy restart    stop, then start
 *   julian-proxy status     report whether it is running
 *
 * Uses a PID file plus process.kill rather than pgrep, so it behaves the same
 * on Linux, macOS and Windows.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "index.mjs");

const env = process.env;
const STATE_DIR =
  env.JULIAN_PROXY_STATE_DIR ??
  (process.platform === "win32"
    ? `${env.LOCALAPPDATA ?? env.TEMP ?? "."}\\julian-proxy`
    : `${env.XDG_STATE_HOME ?? `${env.HOME ?? "."}/.local/state`}/julian-proxy`);

const PID_FILE = env.JULIAN_PROXY_PID_FILE ?? `${STATE_DIR}/julian-proxy.pid`;
const LOG_FILE = env.JULIAN_PROXY_LOG_FILE ?? `${STATE_DIR}/julian-proxy.log`;

/**
 * Probe the port when the PID file is missing or stale, so `status` still
 * reports an orphan rather than claiming the proxy is stopped.
 */
async function portAnswers() {
  const port = env.JULIAN_PROXY_PORT ?? "8788";
  const host = env.JULIAN_PROXY_HOST ?? "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === "EPERM";
  }
}

function runningPid() {
  const pid = readPid();
  if (isAlive(pid)) return pid;
  if (pid) clearPid(); // stale
  return null;
}

function clearPid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

async function start() {
  const existing = runningPid();
  if (existing) {
    console.log(`julian-proxy: already running (pid ${existing}, log: ${LOG_FILE})`);
    return 0;
  }

  // No PID file, but something is serving — don't spawn a doomed second
  // process that would only fail with EADDRINUSE.
  if (await portAnswers()) {
    console.log(
      `julian-proxy: already serving on port ${env.JULIAN_PROXY_PORT ?? 8788}, ` +
        `but no PID file at ${PID_FILE}`,
    );
    return 0;
  }

  ensureDir(LOG_FILE);
  const out = fs.openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: ROOT,
    env: process.env,
  });
  child.unref();

  ensureDir(PID_FILE);
  fs.writeFileSync(PID_FILE, String(child.pid));

  // Confirm it actually came up before claiming success.
  await new Promise((r) => setTimeout(r, 800));
  const log = (() => {
    try {
      return fs
        .readFileSync(LOG_FILE, "utf8")
        .trim()
        .split("\n")
        .slice(-3)
        .join("\n");
    } catch {
      return "(no log output)";
    }
  })();

  if (isAlive(child.pid)) {
    console.log(`julian-proxy: started (pid ${child.pid}, log: ${LOG_FILE})`);
    return 0;
  }

  clearPid();
  console.error(`julian-proxy: failed to start.\n${log}`);
  return 1;
}

function stop() {
  const pid = runningPid();
  if (!pid) {
    clearPid();
    return portAnswers().then((up) => {
      if (up) {
        console.log(
          `julian-proxy: serving on port ${env.JULIAN_PROXY_PORT ?? 8788}, ` +
            `but no PID file at ${PID_FILE} — stop it with your process manager`,
        );
        return 1;
      }
      console.log("julian-proxy: not running");
      return 0;
    });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    console.error(`julian-proxy: could not stop pid ${pid}: ${err.message}`);
    return Promise.resolve(1);
  }
  clearPid();
  console.log(`julian-proxy: stopped (pid ${pid})`);
  return Promise.resolve(0);
}

function status() {
  const pid = runningPid();
  if (pid) {
    console.log(`julian-proxy: running (pid ${pid}, log: ${LOG_FILE})`);
    return 0;
  }
  return portAnswers().then((up) => {
    if (up) {
      console.log(
        `julian-proxy: running, but no PID file at ${PID_FILE}\n` +
          `             (started outside this CLI, or the PID file was deleted)`,
      );
      return 0;
    }
    console.log("julian-proxy: stopped");
    return 1; // conventional: non-zero when not running
  });
}

function logs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`julian-proxy: no log file yet at ${LOG_FILE}`);
    return 0;
  }
  const size = fs.statSync(LOG_FILE).size;
  const tailBytes = Math.min(size, 64 * 1024);
  const fd = fs.openSync(LOG_FILE, "r");
  const buf = Buffer.alloc(tailBytes);
  fs.readSync(fd, buf, 0, tailBytes, size - tailBytes);
  fs.closeSync(fd);
  process.stdout.write(buf.toString());
  return 0;
}

const [, , cmd = "start"] = process.argv;

const HELP = `julian-proxy — bridge the OpenAI Responses API to OkeyMeta/Julian Chat Completions

Usage:
  julian-proxy              start detached (default)
  julian-proxy start        start detached
  julian-proxy foreground   run in this terminal (same as \`npm start\`)
  julian-proxy stop         stop the detached instance
  julian-proxy restart      stop, then start
  julian-proxy status       report whether it is running (exit 1 if not)
  julian-proxy logs         print the last 64 KB of the detached instance's log
  julian-proxy --help       this text

Environment:
  JULIAN_PROXY_PORT           listen port            (default 8788)
  JULIAN_PROXY_HOST           listen address         (default 127.0.0.1)
  JULIAN_PROXY_UPSTREAM       upstream base URL      (default https://api.okeymeta.com.ng/v1)
  OKEYMETA_API_KEY            fallback key when a request omits Authorization
  JULIAN_PROXY_RETRY_BACKOFF       base backoff between retries, ms
  JULIAN_PROXY_STATE_DIR           runtime state dir (pid + log)
  JULIAN_PROXY_LOG_FILE            detached log destination
  JULIAN_PROXY_PID_FILE            detached PID file
`;

switch (cmd) {
  case "start":
    process.exit(await start());
  case "stop":
    process.exit(await stop());
  case "restart":
    await stop();
    process.exit(await start());
    break;
  case "status":
    process.exit(await status());
  case "logs":
    process.exit(logs());
  case "foreground":
  case "run":
    process.argv = [process.argv[0], ENTRY];
    await import(ENTRY);
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(`julian-proxy: unknown command "${cmd}" (try: start | stop | restart | status | foreground)`);
    process.exit(2);
}
