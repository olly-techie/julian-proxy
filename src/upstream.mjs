/**
 * Upstream HTTP transport.
 *
 * Uses node:https rather than global fetch: undici intermittently throws
 * UND_ERR_CONNECT_TIMEOUT against api.okeymeta.com.ng, while https.request
 * connects reliably. Retries cover both connection failures and upstream 429s
 * (OkeyMeta rate-limits bursts).
 */

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { config } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requestOnce({ url, method = "GET", body, apiKey, accept = "application/json", timeout }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = url.port || (isHttps ? 443 : 80);

    const req = transport.request(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept,
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        },
      },
      resolve,
    );

    req.setTimeout(timeout, () => req.destroy(new Error(`upstream timed out after ${timeout}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Read an upstream response to completion. */
export async function readAll(res) {
  let b = "";
  for await (const c of res) b += c;
  return b;
}

export async function request(path, { method = "GET", body, apiKey, accept, timeout } = {}) {
  const url = new URL(`${config.upstreamBase}${path}`);
  const opts = { url, method, body, apiKey, accept, timeout: timeout ?? config.upstreamTimeout };

  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const res = await requestOnce(opts);

      if (res.statusCode === 429 && attempt < config.maxAttempts) {
        await readAll(res).catch(() => "");
        const wait = config.retryBackoff * 3 * attempt;
        console.error(`[julian-proxy] upstream 429, retrying in ${wait}ms (attempt ${attempt}/${config.maxAttempts})`);
        await sleep(wait);
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < config.maxAttempts) {
        await sleep(config.retryBackoff * attempt);
      }
    }
  }

  throw lastError ?? new Error("upstream request failed");
}
