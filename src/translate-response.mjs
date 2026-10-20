/**
 * Chat Completions stream  ->  Responses API SSE event stream.
 *
 * Codex requires a streaming `/v1/responses`. This builds the exact event
 * sequence it consumes:
 *   response.created / response.in_progress
 *   [response.output_item.added, response.content_part.added,
 *    response.output_text.delta*, response.output_text.done,
 *    response.content_part.done, response.output_item.done]
 *   [response.output_item.added, response.function_call_arguments.delta*,
 *    response.function_call_arguments.done, response.output_item.done]
 *   response.completed
 */

import { randomUUID } from "node:crypto";

export const nid = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

const emptyUsage = () => ({
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
});

export function mapUsage(u) {
  if (!u) return emptyUsage();
  const input = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? input + output,
  };
}

export function envelope({ id, status, output, usage, model, extra = {} }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage,
    ...extra,
  };
}

export class SseWriter {
  #res;
  #seq = 0;
  #started = false;

  constructor(res) {
    this.#res = res;
  }

  start() {
    this.#res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.#started = true;
  }

  event(type, payload = {}) {
    if (!this.#started) this.start();
    this.#res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.#seq++, ...payload })}\n\n`);
  }

  /** Terminate the stream with a Responses error event, mirroring SSE framing. */
  fail(statusCode, message) {
    if (!this.#started) {
      this.#res.writeHead(statusCode, { "content-type": "text/event-stream; charset=utf-8" });
      this.#started = true;
    }
    this.event("error", { code: null, message, param: null });
    this.#res.end();
  }

  end() {
    if (!this.#started) this.start();
    this.#res.end();
  }
}

/**
 * Drives one streamed completion: consumes upstream SSE, emits Responses SSE.
 * Resolves once `response.completed` has been written.
 */
export class ResponseStream {
  constructor(w, model) {
    this.w = w;
    this.model = model;
    this.id = nid("resp");
    this.textItemId = nid("msg");
    this.textOpen = false;
    this.text = "";
    this.tools = new Map(); // upstream tool index -> { itemId, callId, name, args, open }
    this.usage = emptyUsage();
  }

  begin() {
    const partial = envelope({ id: this.id, status: "in_progress", output: [], usage: this.usage, model: this.model });
    this.w.event("response.created", { response: partial });
    this.w.event("response.in_progress", { response: partial });
  }

  #openText() {
    if (this.textOpen) return 0;
    this.textOpen = true;
    this.w.event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: this.textItemId, role: "assistant", status: "in_progress", content: [] },
    });
    this.w.event("response.content_part.added", {
      item_id: this.textItemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return 0;
  }

  /** Apply one parsed upstream Chat Completions chunk. */
  consume(chunk) {
    if (chunk.usage) this.usage = mapUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};

    if (delta.content) {
      this.#openText();
      this.text += delta.content;
      this.w.event("response.output_text.delta", {
        item_id: this.textItemId,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
        logprobs: [],
      });
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      let t = this.tools.get(idx);
      if (!t) {
        t = { itemId: nid("fc"), callId: tc.id ?? nid("call"), name: "", args: "", open: false };
        this.tools.set(idx, t);
      }
      if (tc.id) t.callId = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) {
        if (!t.open) {
          t.open = true;
          this.w.event("response.output_item.added", {
            output_index: 1 + idx,
            item: {
              type: "function_call",
              id: t.itemId,
              call_id: t.callId,
              name: t.name,
              arguments: "",
              status: "in_progress",
            },
          });
        }
        t.args += tc.function.arguments;
        this.w.event("response.function_call_arguments.delta", {
          item_id: t.itemId,
          output_index: 1 + idx,
          delta: tc.function.arguments,
        });
      }
    }
  }

  /** Close out open items and emit response.completed. */
  finish() {
    const output = [];

    if (this.textOpen) {
      this.w.event("response.output_text.done", {
        item_id: this.textItemId,
        output_index: 0,
        content_index: 0,
        text: this.text,
        logprobs: [],
      });
      this.w.event("response.content_part.done", {
        item_id: this.textItemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      const item = {
        type: "message",
        id: this.textItemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      this.w.event("response.output_item.done", { output_index: 0, item });
      output.push(item);
    }

    let outputIndex = this.textOpen ? 1 : 0;
    for (const t of this.tools.values()) {
      if (!t.name) continue;
      if (t.open) {
        this.w.event("response.function_call_arguments.done", {
          item_id: t.itemId,
          output_index: outputIndex,
          arguments: t.args,
        });
      }
      const item = {
        type: "function_call",
        id: t.itemId,
        call_id: t.callId,
        name: t.name,
        arguments: t.args,
        status: "completed",
      };
      this.w.event("response.output_item.done", { output_index: outputIndex, item });
      output.push(item);
      outputIndex++;
    }

    this.w.event("response.completed", {
      response: envelope({ id: this.id, status: "completed", output, usage: this.usage, model: this.model }),
    });
    this.w.end();
    return output;
  }
}

/** Parse a raw SSE byte buffer into individual `data:` payloads. */
export class SseParser {
  #buf = "";

  push(chunk, onPayload) {
    this.#buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    const lines = this.#buf.split("\n");
    this.#buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue; // ignore ': keepalive' comments
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        onPayload(JSON.parse(data));
      } catch {
        /* tolerate malformed keepalive noise */
      }
    }
  }
}

/** Build a Responses object array from a non-streamed Chat Completions message. */
export function outputFromMessage(msg) {
  if (msg.tool_calls?.length) {
    return msg.tool_calls.map((tc) => ({
      type: "function_call",
      id: nid("fc"),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments ?? "",
      status: "completed",
    }));
  }
  return [
    {
      type: "message",
      id: nid("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: msg.content ?? "", annotations: [] }],
    },
  ];
}
