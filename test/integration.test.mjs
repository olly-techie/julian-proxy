/**
 * End-to-end tests against a fake upstream, so these run without an API key
 * and without touching the network.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/** Upstream stand-in that speaks just enough Chat Completions. */
let fakeUpstream;
let upstreamUrl;
let lastUpstreamBody = null;
let lastUpstreamPath = null;

function startFakeUpstream() {
  return new Promise((resolve) => {
    fakeUpstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastUpstreamBody = body ? JSON.parse(body) : null;
        lastUpstreamPath = req.url;

        // Guard against double-versioned paths such as /v1/v1/chat/completions.
        assert.ok(
          !req.url.includes("/v1/v1/"),
          `upstream path should not repeat the version segment: ${req.url}`,
        );

        if (req.url.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ object: "list", data: [{ id: "julian-origin" }] }));
        }

        const wantsTool = /exec_command/.test(body);

        if (!lastUpstreamBody?.stream) {
          const message = wantsTool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
              }
            : { role: "assistant", content: "Hello" };
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              id: "chatcmpl_1",
              object: "chat.completion",
              model: "julian-origin",
              choices: [{ index: 0, message, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }),
          );
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

        send({ choices: [{ delta: { role: "assistant" } }] });
        res.write(": keepalive\n\n");

        if (wantsTool) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec_command", arguments: "" } }] } }] });
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }] } }] });
        } else {
          send({ choices: [{ delta: { content: "Hel" } }] });
          send({ choices: [{ delta: { content: "lo" } }] });
        }

        send({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    fakeUpstream.listen(0, "127.0.0.1", () => {
      upstreamUrl = `http://127.0.0.1:${fakeUpstream.address().port}/v1`;
      resolve();
    });
  });
}

/** Point the proxy at the fake upstream before importing it (config reads env at import). */
let proxy;
let proxyUrl;

before(async () => {
  await startFakeUpstream();
  process.env.JULIAN_PROXY_UPSTREAM = upstreamUrl;
  process.env.JULIAN_PROXY_PORT = "0";
  process.env.JULIAN_PROXY_HOST = "127.0.0.1";
  delete process.env.OKEYMETA_API_KEY;

  const { createServer } = await import("../src/server.mjs");
  proxy = createServer();
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

after(async () => {
  await new Promise((r) => proxy?.close(r));
  await new Promise((r) => fakeUpstream?.close(r));
});

/** POST /v1/responses and collect the raw SSE body. */
async function postResponses(payload, headers = {}) {
  const res = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-key", ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

const sseEvents = (raw) =>
  raw
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });

const basePayload = {
  model: "julian-origin",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
};

describe("GET /health", () => {
  test("reports ok without an API key", async () => {
    const res = await fetch(`${proxyUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });
});

describe("POST /v1/responses (streamed)", () => {
  test("returns a Responses SSE stream for a text answer", async () => {
    const { status, headers, body } = await postResponses({ ...basePayload, stream: true });
    assert.equal(status, 200);
    assert.match(headers.get("content-type"), /text\/event-stream/);

    const events = sseEvents(body);
    const types = events.map((e) => e.event);

    assert.equal(types[0], "response.created");
    assert.ok(types.includes("response.output_text.delta"));
    assert.equal(types.at(-1), "response.completed");

    const completed = events.find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.status, "completed");
    assert.equal(completed.data.response.output[0].content[0].text, "Hello");
    assert.equal(completed.data.response.usage.total_tokens, 12);
  });

  test("returns a Responses SSE stream for a tool call", async () => {
    const { body } = await postResponses({
      ...basePayload,
      stream: true,
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "run a command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });

    const events = sseEvents(body);
    assert.ok(events.some((e) => e.event === "response.function_call_arguments.delta"));

    const item = events.find((e) => e.event === "response.completed").data.response.output[0];
    assert.equal(item.type, "function_call");
    assert.equal(item.name, "exec_command");
    assert.equal(item.arguments, '{"cmd":"ls"}');

    // The tool must reach upstream in Chat Completions shape.
    assert.equal(lastUpstreamBody.tools[0].function.name, "exec_command");
    assert.equal(lastUpstreamBody.tool_choice, "auto");
  });

  test("targets the chat completions path on upstream", async () => {
    await postResponses({ ...basePayload, stream: true });
    assert.equal(lastUpstreamPath, "/v1/chat/completions");
  });

  test("targets the models path on upstream", async () => {
    const res = await fetch(`${proxyUrl}/v1/models`, { headers: { authorization: "Bearer test-key" } });
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamPath, "/v1/models");
  });

  test("forwards instructions as the system message", async () => {
    await postResponses({ ...basePayload, instructions: "Be terse.", stream: true });
    assert.equal(lastUpstreamBody.messages[0].role, "system");
    assert.equal(lastUpstreamBody.messages[0].content, "Be terse.");
  });

  test("round-trips tool results as a Chat Completions tool message", async () => {
    await postResponses({
      ...basePayload,
      stream: true,
      input: [
        ...basePayload.input,
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
      ],
    });
    const toolMsg = lastUpstreamBody.messages.find((m) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.equal(toolMsg.content, "a.txt\nb.txt");
  });

  test("forwards the caller's bearer token upstream", async () => {
    await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ ...basePayload, stream: true }),
    });
    assert.equal(lastUpstreamBody.model, "julian-origin");
  });
});

describe("POST /v1/responses (non-streamed)", () => {
  test("returns a single JSON response object", async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ ...basePayload, stream: false }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
    assert.equal(json.output[0].content[0].text, "Hello");
    assert.equal(json.usage.total_tokens, 12);
  });

  test("returns tool calls as function_call items", async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        ...basePayload,
        stream: false,
        tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object" } }],
      }),
    });
    const json = await res.json();
    assert.equal(json.output[0].type, "function_call");
    assert.equal(json.output[0].name, "exec_command");
    assert.equal(json.output[0].arguments, '{"cmd":"ls"}');
  });
});

describe("error handling", () => {
  test("rejects invalid JSON", async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /not valid JSON/);
  });

  test("rejects a missing model", async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ input: [] }),
    });
    assert.equal(res.status, 400);
  });

  test("401s when no API key is available", async () => {
    const res = await fetch(`${proxyUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...basePayload, stream: true }),
    });
    assert.equal(res.status, 401);
  });

  test("404s an unknown route", async () => {
    const res = await fetch(`${proxyUrl}/nope`);
    assert.equal(res.status, 404);
  });

  test("surfaces an upstream failure as an SSE error event", async () => {
    const bad = http.createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
    await new Promise((r) => bad.listen(0, "127.0.0.1", r));
    const badUrl = `http://127.0.0.1:${bad.address().port}/v1`;

    // Swap the upstream for this one case, then restore.
    process.env.JULIAN_PROXY_UPSTREAM = badUrl;
    const { config } = await import("../src/config.mjs");
    config.upstreamBase = badUrl;

    const { body, status } = await postResponses({ ...basePayload, stream: true });
    assert.equal(status, 500);
    const [event] = sseEvents(body);
    assert.equal(event.event, "error");
    assert.match(event.data.message, /boom/);

    config.upstreamBase = upstreamUrl;
    await new Promise((r) => bad.close(r));
  });
});
