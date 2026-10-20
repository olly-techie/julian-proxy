import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  SseWriter,
  ResponseStream,
  SseParser,
  mapUsage,
  envelope,
  outputFromMessage,
  nid,
} from "../src/translate-response.mjs";

/** Minimal ServerResponse stand-in that captures SSE writes. */
class FakeRes extends EventEmitter {
  headers = {};
  statusCode = null;
  chunks = [];

  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.ended = true;
    return this;
  }

  get body() {
    return this.chunks.join("");
  }

  /** Parse the captured SSE stream into {event, data} records. */
  events() {
    return this.body
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        return { event: ev, data: data ? JSON.parse(data) : null };
      });
  }

  types() {
    return this.events().map((e) => e.event);
  }
}

const feed = (stream, res, chunks) => {
  for (const c of chunks) stream.consume(c);
  stream.finish();
  return res;
};

const textChunk = (content) => ({ choices: [{ delta: { content } }] });

describe("helpers", () => {
  test("nid produces prefixed ids", () => {
    assert.match(nid("resp"), /^resp_[a-f0-9]{22}$/);
  });

  test("mapUsage converts Chat Completions usage", () => {
    assert.deepEqual(
      mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } }),
      {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15,
      },
    );
  });

  test("mapUsage tolerates a missing usage block", () => {
    assert.equal(mapUsage(undefined).total_tokens, 0);
  });

  test("envelope is a well-formed response object", () => {
    const e = envelope({ id: "resp_1", status: "completed", output: [], usage: mapUsage(), model: "julian-origin" });
    assert.equal(e.object, "response");
    assert.equal(e.status, "completed");
    assert.equal(e.model, "julian-origin");
  });

  test("outputFromMessage builds a message item", () => {
    const [item] = outputFromMessage({ content: "hi" });
    assert.equal(item.type, "message");
    assert.equal(item.content[0].text, "hi");
  });

  test("outputFromMessage prefers tool calls", () => {
    const out = outputFromMessage({ content: null, tool_calls: [{ id: "c1", function: { name: "add", arguments: "{}" } }] });
    assert.equal(out[0].type, "function_call");
    assert.equal(out[0].name, "add");
  });
});

describe("SseParser", () => {
  test("parses data lines and ignores keepalives", () => {
    const p = new SseParser();
    const seen = [];
    p.push(': keepalive\n\ndata: {"a":1}\n\n: keepalive\n\ndata: {"a":2}\n\n', (j) => seen.push(j));
    assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
  });

  test("handles a payload split across chunks", () => {
    const p = new SseParser();
    const seen = [];
    p.push('data: {"a":', (j) => seen.push(j));
    p.push('1}\n\n', (j) => seen.push(j));
    assert.deepEqual(seen, [{ a: 1 }]);
  });

  test("ignores [DONE] and malformed lines", () => {
    const p = new SseParser();
    const seen = [];
    p.push("data: [DONE]\n\ndata: not-json\n\n", (j) => seen.push(j));
    assert.deepEqual(seen, []);
  });
});

describe("ResponseStream (text)", () => {
  test("emits the full Responses event sequence", () => {
    const res = new FakeRes();
    const w = new SseWriter(res);
    const s = new ResponseStream(w, "julian-origin");
    s.begin();
    feed(s, res, [textChunk("Hel"), textChunk("lo")]);

    assert.deepEqual(res.types(), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const deltas = res.events().filter((e) => e.event === "response.output_text.delta");
    assert.deepEqual(deltas.map((d) => d.data.delta), ["Hel", "lo"]);

    const done = res.events().find((e) => e.event === "response.output_text.done");
    assert.equal(done.data.text, "Hello");

    const completed = res.events().find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.output[0].content[0].text, "Hello");
    assert.equal(completed.data.response.status, "completed");
  });

  test("sets SSE headers on first write", () => {
    const res = new FakeRes();
    const w = new SseWriter(res);
    const s = new ResponseStream(w, "m");
    s.begin();
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/event-stream/);
  });

  test("uses a stable item id across deltas", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    feed(s, res, [textChunk("a"), textChunk("b")]);
    const ids = new Set(
      res.events()
        .filter((e) => e.event === "response.output_text.delta")
        .map((e) => e.data.item_id),
    );
    assert.equal(ids.size, 1);
  });

  test("carries usage through to response.completed", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    s.consume(textChunk("x"));
    s.consume({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } });
    s.finish();
    const completed = res.events().find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.usage.total_tokens, 9);
  });

  test("sequence numbers increase monotonically", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    feed(s, res, [textChunk("a"), textChunk("b"), textChunk("c")]);
    const seqs = res.events().map((e) => e.data.sequence_number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  });
});

describe("ResponseStream (tool calls)", () => {
  const toolChunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "exec_command", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
  ];

  test("emits function_call argument deltas and a completed item", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    feed(s, res, toolChunks);

    const types = res.types();
    assert.ok(types.includes("response.function_call_arguments.delta"));
    assert.equal(types.at(-1), "response.completed");

    const deltas = res.events().filter((e) => e.event === "response.function_call_arguments.delta");
    assert.deepEqual(deltas.map((d) => d.data.delta), ['{"cmd"', ':"ls"}']);

    const done = res.events().find((e) => e.event === "response.function_call_arguments.done");
    assert.equal(done.data.arguments, '{"cmd":"ls"}');

    const completed = res.events().find((e) => e.event === "response.completed");
    const item = completed.data.response.output[0];
    assert.equal(item.type, "function_call");
    assert.equal(item.name, "exec_command");
    assert.equal(item.call_id, "call_1");
    assert.equal(item.arguments, '{"cmd":"ls"}');
  });

  test("numbers output_index after any text item", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    feed(s, res, [textChunk("thinking"), ...toolChunks]);
    const completed = res.events().find((e) => e.event === "response.completed");
    assert.equal(completed.data.response.output.length, 2);
    assert.equal(completed.data.response.output[0].type, "message");
    assert.equal(completed.data.response.output[1].type, "function_call");
  });

  test("handles parallel tool calls as distinct items", () => {
    const res = new FakeRes();
    const s = new ResponseStream(new SseWriter(res), "m");
    s.begin();
    feed(s, res, [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "one", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "two", arguments: "{}" } }] } }] },
    ]);
    const completed = res.events().find((e) => e.event === "response.completed");
    assert.deepEqual(completed.data.response.output.map((o) => o.name), ["one", "two"]);
    assert.equal(new Set(completed.data.response.output.map((o) => o.call_id)).size, 2);
  });
});

describe("SseWriter.fail", () => {
  test("emits a Responses error event and closes", () => {
    const res = new FakeRes();
    const w = new SseWriter(res);
    w.fail(502, "upstream down");
    const [e] = res.events();
    assert.equal(e.event, "error");
    assert.equal(e.data.message, "upstream down");
    assert.equal(res.statusCode, 502);
    assert.equal(res.ended, true);
  });
});
