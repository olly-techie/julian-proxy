import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toChat, textOf } from "../src/translate-request.mjs";

describe("textOf", () => {
  test("passes through plain strings", () => {
    assert.equal(textOf("hello"), "hello");
  });

  test("concatenates Responses content parts", () => {
    assert.equal(
      textOf([
        { type: "input_text", text: "a" },
        { type: "output_text", text: "b" },
      ]),
      "ab",
    );
  });

  test("substitutes a placeholder for images", () => {
    const out = textOf([{ type: "input_image" }]);
    assert.match(out, /image omitted/);
  });

  test("tolerates junk input", () => {
    assert.equal(textOf(undefined), "");
    assert.equal(textOf(null), "");
  });
});

describe("toChat", () => {
  test("maps instructions to a system message", () => {
    const out = toChat({ model: "julian-origin", instructions: "Be terse.", input: [] });
    assert.deepEqual(out.messages, [{ role: "system", content: "Be terse." }]);
  });

  test("maps a developer message to role system", () => {
    const out = toChat({
      model: "m",
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }],
    });
    assert.equal(out.messages[0].role, "system");
  });

  test("maps function_call to an assistant tool_call", () => {
    const out = toChat({
      model: "m",
      input: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
        },
      ],
    });
    assert.deepEqual(out.messages[0], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } }],
    });
  });

  test("maps function_call_output to a tool message", () => {
    const out = toChat({
      model: "m",
      input: [{ type: "function_call_output", call_id: "call_1", output: "total 4" }],
    });
    assert.deepEqual(out.messages[0], { role: "tool", tool_call_id: "call_1", content: "total 4" });
  });

  test("drops reasoning items, which have no Chat Completions equivalent", () => {
    const out = toChat({
      model: "m",
      input: [
        { type: "reasoning", id: "rs_1", encrypted_content: "zzz" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "user");
  });

  test("converts Responses tools into Chat Completions tools", () => {
    const out = toChat({
      model: "m",
      input: [],
      tools: [
        {
          type: "function",
          name: "add",
          description: "add",
          strict: false,
          parameters: { type: "object", properties: { a: { type: "number" } } },
        },
        { type: "web_search" },
      ],
    });
    assert.deepEqual(out.tools, [
      { type: "function", function: { name: "add", description: "add", parameters: { type: "object", properties: { a: { type: "number" } } } } },
    ]);
    assert.equal(out.tool_choice, "auto");
  });

  test("omits tool fields entirely when no tools are supplied", () => {
    const out = toChat({ model: "m", input: [] });
    assert.equal(out.tools, undefined);
    assert.equal(out.tool_choice, undefined);
  });

  test("mirrors the stream flag", () => {
    assert.equal(toChat({ model: "m", input: [], stream: true }).stream, true);
    assert.equal(toChat({ model: "m", input: [], stream: false }).stream, false);
  });
});
