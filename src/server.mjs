/**
 * HTTP surface.
 *
 *   GET  /v1/models            -> passthrough to upstream
 *   POST /v1/responses         -> translated (streaming SSE or one-shot JSON)
 *   GET  /health               -> liveness for local tooling
 */

import http from "node:http";
import { config } from "./config.mjs";
import { request, readAll } from "./upstream.mjs";
import { toChat } from "./translate-request.mjs";
import {
  SseWriter,
  ResponseStream,
  SseParser,
  envelope,
  mapUsage,
  outputFromMessage,
  nid,
} from "./translate-response.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function jsonError(res, status, message, type = "invalid_request_error") {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: null } }));
}

function apiKeyFrom(req) {
  const header = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return header || config.fallbackApiKey;
}

async function handleModels(req, res) {
  const upstream = await request("/models", { apiKey: apiKeyFrom(req) });
  const text = await readAll(upstream);
  res.writeHead(upstream.statusCode, { "content-type": "application/json" });
  res.end(text);
}

async function handleResponses(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, "Request body is not valid JSON.");
  }
  if (!body?.model) return jsonError(res, 400, "Missing required field: model.");

  const apiKey = apiKeyFrom(req);
  if (!apiKey) {
    return jsonError(res, 401, "Missing API key. Send Authorization: Bearer <key>, or set OKEYMETA_API_KEY.");
  }

  const chat = toChat(body);

  if (!body.stream) {
    const upstream = await request("/chat/completions", {
      method: "POST",
      body: { ...chat, stream: false },
      apiKey,
    });
    const text = await readAll(upstream);
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* forward a non-JSON error body verbatim */
    }
    if (upstream.statusCode !== 200) {
      res.writeHead(upstream.statusCode, { "content-type": "application/json" });
      return res.end(text);
    }
    const msg = parsed.choices?.[0]?.message ?? {};
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify(
        envelope({
          id: nid("resp"),
          status: "completed",
          output: outputFromMessage(msg),
          usage: mapUsage(parsed.usage),
          model: body.model,
        }),
      ),
    );
  }

  let upstream;
  try {
    upstream = await request("/chat/completions", {
      method: "POST",
      body: chat,
      apiKey,
      accept: "text/event-stream",
      timeout: config.upstreamStreamTimeout,
    });
  } catch (err) {
    console.error(`[julian-proxy] upstream unreachable: ${err.message}`);
    const w = new SseWriter(res);
    return w.fail(502, `Upstream unreachable: ${err.message}`);
  }

  if (upstream.statusCode !== 200) {
    const detail = await readAll(upstream).catch(() => "");
    console.error(`[julian-proxy] upstream ${upstream.statusCode}: ${detail.slice(0, 200)}`);
    const w = new SseWriter(res);
    return w.fail(upstream.statusCode || 502, detail.slice(0, 500) || `Upstream returned ${upstream.statusCode}`);
  }

  const writer = new SseWriter(res);
  const stream = new ResponseStream(writer, body.model);
  const parser = new SseParser();

  stream.begin();

  try {
    for await (const chunk of upstream) parser.push(chunk, (j) => stream.consume(j));
  } catch (err) {
    console.error(`[julian-proxy] stream aborted: ${err.message}`);
    return writer.fail(502, `Upstream stream aborted: ${err.message}`);
  }

  stream.finish();
}

export function createServer() {
  return http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "") || "/";
    const log = (err) => console.error("[julian-proxy]", err);

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, upstream: config.upstreamBase }));
    }

    if (req.method === "GET" && path.endsWith("/models")) {
      return handleModels(req, res).catch(log);
    }

    if (req.method === "POST" && path.endsWith("/responses")) {
      return handleResponses(req, res).catch((err) => {
        log(err);
        if (!res.headersSent) jsonError(res, 500, err.message ?? "Internal proxy error", "api_error");
        else res.end();
      });
    }

    jsonError(res, 404, `No route for ${req.method} ${req.url}`, "not_found");
  });
}
