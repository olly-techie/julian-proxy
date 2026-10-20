/**
 * Responses API request  ->  Chat Completions request.
 */

/** Flatten Responses content parts into a plain string. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (p?.type === "input_text" || p?.type === "output_text" || p?.type === "text") {
      parts.push(p.text ?? "");
    } else if (p?.type === "input_image") {
      parts.push("[image omitted: upstream model is text-only]");
    }
  }
  return parts.join("");
}

/**
 * Convert a `/v1/responses` body into a `/v1/chat/completions` body.
 * Items that have no Chat Completions equivalent (encrypted reasoning,
 * item references) are dropped rather than guessed at.
 */
export function toChat(body) {
  const messages = [];

  if (body.instructions) messages.push({ role: "system", content: body.instructions });

  for (const item of body.input ?? []) {
    switch (item?.type) {
      case "message": {
        messages.push({
          role: item.role === "developer" ? "system" : item.role,
          content: textOf(item.content),
        });
        break;
      }

      case "function_call": {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: item.call_id ?? item.id,
              type: "function",
              function: { name: item.name, arguments: item.arguments ?? "{}" },
            },
          ],
        });
        break;
      }

      case "function_call_output": {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: textOf(item.output) || String(item.output ?? ""),
        });
        break;
      }

      case "reasoning":
      case "item_reference":
        break;

      default:
        if (item?.role) messages.push({ role: item.role, content: textOf(item.content) });
    }
  }

  const tools = (body.tools ?? [])
    .filter((t) => t?.type === "function" && t.name)
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? {} },
    }));

  const out = { model: body.model, messages, stream: Boolean(body.stream) };

  if (tools.length) {
    out.tools = tools;
    out.tool_choice =
      body.tool_choice && typeof body.tool_choice === "object" && body.tool_choice.name
        ? { type: "function", function: { name: body.tool_choice.name } }
        : "auto";
    out.parallel_tool_calls = body.parallel_tool_calls ?? true;
  }

  return out;
}
