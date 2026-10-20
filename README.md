# julian-proxy

Use [OkeyMeta / Julian](https://okeymeta.com.ng) as an **OpenAI Responses API** endpoint — so streaming clients like **Codex CLI** can run on it.

## Why this exists

Julian is OpenAI-compatible for Chat Completions, but its `/v1/responses` endpoint accepts `"stream": true` and then ignores it, returning a single non-SSE JSON blob.

Codex CLI 0.15x+ requires a **streaming** Responses API, and removed `wire_api = "chat"`, so it cannot talk to Julian directly.

`julian-proxy` sits in between:

```
Codex CLI ──POST /v1/responses (SSE)──▶ julian-proxy ──POST /v1/chat/completions──▶ OkeyMeta
                                        ▲
                        Responses ⇄ Chat Completions, including
                        tool calls, in both directions
```

It translates requests **and** responses, so tool calling, streaming and multi-turn agent loops all work.

## Requirements

- Node.js **20 or newer** (tested on 20, 22, 24)
- An OkeyMeta API key from <https://okeymeta.com.ng/api/signup>
- No runtime dependencies

## Install

```bash
# from npm
npm install -g julian-proxy

# from source (pnpm)
git clone https://github.com/olly-techie/julian-proxy.git
cd julian-proxy && pnpm install && pnpm link --global
```

## Quick start

```bash
export OKEYMETA_API_KEY=okeymeta-your-key-here

julian-proxy start      # detached
julian-proxy status
julian-proxy logs       # tail the detached instance's log
julian-proxy stop
```

Or run it in the foreground:

```bash
pnpm start
# [julian-proxy] listening on http://127.0.0.1:8788
# [julian-proxy] upstream: https://api.okeymeta.com.ng/v1
```

Verify:

```bash
curl http://127.0.0.1:8788/health
# {"ok":true,"upstream":"https://api.okeymeta.com.ng/v1"}
```

## Use with Codex CLI

Add a provider to `~/.codex/config.toml`:

```toml
model = "julian-origin"
model_provider = "okeymeta"
model_reasoning_effort = "medium"

[model_providers.okeymeta]
name = "OkeyMeta (Julian via julian-proxy)"
base_url = "http://127.0.0.1:8788/v1"
env_key = "OKEYMETA_API_KEY"
wire_api = "responses"
```

`env_key` means Codex reads the key from the environment and forwards it as a
bearer token, so the proxy never needs to be configured with your key at all.

## Use with Docker

```bash
docker build -t julian-proxy .
docker run --rm -p 8788:8788 -e OKEYMETA_API_KEY=okeymeta-... julian-proxy
```

Set `JULIAN_PROXY_HOST=0.0.0.0` (the image already does) to reach it from
outside the container.

## Use with any other client

Anything that speaks the OpenAI Responses API works — just point it at the proxy:

```bash
curl http://127.0.0.1:8788/v1/responses \
  -H "Authorization: Bearer $OKEYMETA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "julian-origin",
    "instructions": "You are a coding agent.",
    "input": [{"type": "message", "role": "user", "content": "hello"}],
    "stream": true
  }'
```

## API

| Route | Behaviour |
|---|---|
| `POST /v1/responses` | Translated. Honours `stream: true`/`false`. |
| `GET /v1/models` | Passthrough to upstream. |
| `GET /health` | Liveness plus the configured upstream. |

Non-streaming requests work too — the proxy sends `stream: false` upstream and
wraps the result as a single Responses object.

### What gets translated

| Responses | Chat Completions |
|---|---|
| `instructions` | leading `system` message |
| `role: "developer"` message | `system` message |
| `function_call` | assistant `tool_calls` |
| `function_call_output` | `tool` message |
| `reasoning` (encrypted) | *dropped* — no equivalent upstream |
| `input_image` | text placeholder — the model is text-only |

Responses streams are emitted as the event sequence Codex expects:
`response.created` → `response.in_progress` → per-item
`output_item.added` / `content_part.added` / `output_text.delta`* /
`function_call_arguments.delta`* / `…done` → `response.completed`.

## Configuration

Every variable is optional; the defaults work.

| Variable | Default | Purpose |
|---|---|---|
| `JULIAN_PROXY_HOST` | `127.0.0.1` | Listen address |
| `JULIAN_PROXY_PORT` | `8788` | Listen port |
| `JULIAN_PROXY_UPSTREAM` | `https://api.okeymeta.com.ng/v1` | Upstream base URL |
| `OKEYMETA_API_KEY` | — | Fallback key when a request omits `Authorization` |
| `JULIAN_PROXY_TIMEOUT` | `20000` | Per-request upstream timeout (ms) |
| `JULIAN_PROXY_STREAM_TIMEOUT` | `120000` | Streaming timeout (ms) |
| `JULIAN_PROXY_MAX_ATTEMPTS` | `3` | Retries for connection failures and `429`s |
| `JULIAN_PROXY_RETRY_BACKOFF` | `500` | Base backoff (ms), grows per attempt |
| `JULIAN_PROXY_STATE_DIR` | `$XDG_STATE_HOME/julian-proxy` | Runtime state directory |
| `JULIAN_PROXY_PID_FILE` | `<state dir>/julian-proxy.pid` | PID file for the detached CLI |
| `JULIAN_PROXY_LOG_FILE` | `<state dir>/julian-proxy.log` | Log for the detached CLI |

State lives in `$XDG_STATE_HOME/julian-proxy` (`~/.local/state/julian-proxy` on
Linux), not `$XDG_RUNTIME_DIR`, because that variable is absent in some shells
and containers — which would split the PID file across locations and make
`status` disagree with reality.

See `.env.example`. Note the proxy does **not** read `.env` itself — export the
variables, or let your process manager do it.

## CLI

```
julian-proxy              start detached (default)
julian-proxy start        start detached
julian-proxy foreground   run in this terminal
julian-proxy stop         stop the detached instance
julian-proxy restart      stop, then start
julian-proxy status       report whether it is running
julian-proxy logs         print the last 64 KB of the log
```

`start` is idempotent: it never kills an instance that is already serving, which
would abort requests in flight. Process control uses a PID file plus
`process.kill`, not `pgrep`, so it behaves the same on Linux, macOS and Windows.

## Implementation notes

Two details are load-bearing, both found by testing against the live API:

- **`node:https`, not global `fetch`.** Undici intermittently fails with
  `UND_ERR_CONNECT_TIMEOUT` against `api.okeymeta.com.ng`, while
  `https.request` connects reliably. The proxy uses `node:https` with retries.
- **429 backoff.** OkeyMeta rate-limits bursts. The proxy retries these with
  linear backoff instead of surfacing the error.

Known limitation: Chat Completions has no reasoning-effort field, so
`reasoning.effort` from a client is not forwarded and Codex prints a
"Model metadata for `julian-origin` not found" warning. This is cosmetic.

## Development

```bash
pnpm install
pnpm test     # 43 tests, no network or API key needed
pnpm run lint
pnpm run dev  # auto-restart on change
```

The integration suite runs a fake upstream on localhost, so tests never touch
the network or spend tokens.

## License

MIT — see [LICENSE](LICENSE).
