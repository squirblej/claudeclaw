# HTTP Channel — Frontend / Embedding Spec

> This is the embedder's contract. For the CC-side API surface and server contract, see [HTTP_CHANNEL_SPEC.md](./HTTP_CHANNEL_SPEC.md).

## Why this exists

The ClaudeClaw HTTP channel adapter is stateless w.r.t. messages — exactly like the Discord adapter is stateless because Discord is the message store. For HTTP, the *embedding app* is the message store. That means the embedder inherits real responsibility: authentication, persistence, optimistic UI, reconnect handling, attachment hosting, and channel lifecycle.

This document is the checklist of what any frontend integrating the HTTP channel must do. Itineraries and the future Cursus client both need to satisfy these.

## 1. User identity

CC accepts a `user_id` string and echoes it. It does not validate, authenticate, or persist user records.

- **Auth**: the embedding app authenticates its own users (cookies, JWT, OIDC, whatever it already uses) and decides who is allowed to post to which channel.
- **User records**: `display_name`, `avatar_url`, role, etc. live in the embedding app's DB.
- **Resolution on render**: when the SSE stream emits a `user_message` with `user_id: "jess@11mr.org"`, the embedding app is responsible for resolving that to a display name and avatar for the UI.
- **Service token handling**: the bearer token has full CC access for any agent in `allowedAgents`. It MUST live on the embedding app's server and never reach the browser. All browser → CC calls must transit the embedding app's backend.

## 2. Message persistence

The full transcript (every user message, every agent reply, every tool call you care about surfacing) lives in the embedding app's DB.

- Schema is the embedding app's choice. A reasonable baseline:
  ```sql
  chat_messages (
    id, channel_id, role ('user'|'agent'|'system'|'tool'),
    user_id, content, attachments_json, tool_calls_json,
    client_message_id, created_at, sequence
  )
  ```
- Both the user's POST and the agent's streamed response are persisted by the embedding app. CC's SSE stream is the *signal*; the embedding app is the *record*.
- History endpoints (paginated scrollback, search) are the embedding app's responsibility. CC has no `GET /messages` endpoint.

## 3. Send + optimistic UI + dedup

- The frontend renders the user message immediately on send (optimistic).
- The POST goes to the embedding app's backend, which:
  1. Generates a `client_message_id` (UUID).
  2. Persists the user message locally with that id.
  3. Forwards to CC `POST /v1/channels/:id/messages` with the same `client_message_id`.
- The SSE `user_message` echo arrives later; the frontend matches it on `client_message_id` and skips re-rendering. (Without this, the echo would duplicate the message in the sender's UI.)
- For multi-user channels (Jack + Jess in the same trip): `user_message` events from *other* users have no matching local `client_message_id` and are rendered as new incoming messages.

## 4. SSE subscription & reconnect

- The frontend subscribes via the embedding app's backend (which proxies the SSE through, attaching the service token).
- On any disconnect, reconnect. **There is no replay from CC.** Anything missed during the gap is recovered by re-fetching the latest messages from the embedding app's own DB (which the backend has been writing to on each `agent_token`/`agent_complete` event).
- The cleanest pattern: on reconnect, GET history from the local DB since the last seen `created_at`, then resume live SSE. The frontend never sees the gap.

## 5. Stream consumption — turning tokens into a message

Agent responses arrive as a sequence of events:

```
agent_token   { run_id, text }   ← many
agent_token   { run_id, text }
tool_activity { run_id, text }   ← "● [ToolName] summary"  (tool call started)
tool_activity { run_id, text }   ← "  ⎿  [ToolName] result" (tool result)
agent_token   { run_id, text }
agent_complete{ run_id, final_text }
```

The embedding app must:

- On the first `agent_token` for a `run_id`: insert a `chat_messages` row with role='agent', `client_message_id = run_id`, content = "" (or the first chunk), `is_partial = 1`.
- On subsequent `agent_token`s: append text to that row.
- On `tool_activity`: the `text` field is a pre-formatted human-readable line (matches how the Discord adapter renders tool calls). The embedding app can append it to a `tool_log` array on the row, render it inline in muted text, render in a side panel, or hide entirely. The leading character indicates kind: `●` is a tool call start, `⎿` is a result line.
- On `agent_complete`: set content to `final_text` (canonical version — supersedes any token concatenation, which may have edge cases around partial UTF-8 or markdown), `is_partial = 0`.
- On `error`: persist the error against the run_id row and surface to the UI.

## 6. Attachments

- The embedding app hosts files itself (its own object storage / filesystem) and provides URLs CC can fetch.
- The POST body's `attachments[].url` must be reachable from the CC process (typically a same-host URL since CC is loopback-bound by default).
- For sensitive content, sign URLs with short-lived tokens; CC will fetch within seconds.
- CC does not store or re-host attachments.

## 7. Multi-user UX

- The `user_message` SSE event broadcasts to all subscribers of the channel, including the sender's other tabs and other users.
- The embedding app's UI should render messages from other users distinctly (avatar, name, colour) and reflect new ones in real time.
- Typing indicators are NOT in v1 — if needed, the embedding app can implement them out-of-band (e.g. a separate `/typing` WebSocket on its own backend), since this is fundamentally an embedding-app concern (user identity, presence) and doesn't need CC.

## 8. Channel lifecycle

- `channel_id` is the embedding app's responsibility to choose and keep stable. Recommended convention: `<entity>:<id>`, e.g. `trip:chamonix-2026`, `athlete:jack-coach:kilian`.
- Channels are created implicitly on first message POST — no need to call anything.
- When the underlying entity is deleted (trip removed, athlete-coach pairing ended), the embedding app SHOULD call `DELETE /v1/channels/:id` to clean up the CC session mapping.
- To clear context without losing the visible transcript (e.g. "start a fresh planning session for this trip"): call `POST /v1/channels/:id/reset`. The embedding app's stored messages are unaffected; only CC's session resets.

## 9. Backend proxy (recommended pattern)

Most frontends should NOT call CC directly. Standard shape:

```
Browser → embedding-app backend → CC HTTP channel
                                ↓
                          embedding-app DB (transcript)
```

The backend:
- Authenticates the browser user.
- Translates app-user-id → `user_id` for CC.
- Holds the CC service token.
- Persists every user message and every streamed agent event into the local DB.
- Proxies SSE through to the browser (often with its own auth gating).

This keeps the service token off the wire, lets the backend write to its DB on every event (so reconnect-from-DB works), and gives the embedding app a single audit point.

## 10. Minimal embedding checklist

Before integrating, confirm the embedding app has:

- [ ] User auth and identity model
- [ ] A `chat_messages` (or equivalent) table
- [ ] Backend route that proxies POST → CC, persists user message
- [ ] Backend route that proxies SSE → browser, persists agent events as they stream
- [ ] Optimistic UI with `client_message_id` dedup
- [ ] History endpoint reading from local DB
- [ ] Attachment hosting with URLs reachable from CC
- [ ] Multi-user message rendering
- [ ] DELETE channel call on entity teardown
