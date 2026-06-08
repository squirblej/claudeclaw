# HTTP Channel Adapter — Spec

## Problem

ClaudeClaw today supports Discord, Slack, and Telegram as conversational surfaces. Each is a `src/commands/<surface>.ts` file owning a long-lived connection that converts inbound user messages into Claude runs and pipes streamed responses back. Apps that aren't built around one of these messaging platforms have no first-class way to embed a ClaudeClaw agent — they have to either run their own Claude API integration (duplicating session/tool/rotation logic) or piggy-back on Discord as a transport (Cursus does this today via `chat_bridge.py`, which is non-trivial and locks the app to Discord's UX/auth).

## Goal

A first-class HTTP channel adapter that lets any application — web, mobile, CLI, another service — host a ClaudeClaw agent as a chat surface.

Specifically:

1. **Embed-ready**: no UI, no opinion on auth. Frontend-agnostic JSON + SSE.
2. **Multi-channel**: one agent can host many independent conversations (per-user, per-trip, per-athlete, etc.).
3. **Multi-user-per-channel**: e.g. multiple Cursus athletes writing into the same coach channel; Shortlist having Jack and Jess in the same trip thread.
4. **Streaming-first**: live tokens, tool-call visibility — same UX you get on Discord.
5. **Stateless w.r.t. messages**: the embedding app is the message store, exactly like Discord is for the Discord adapter. CC only persists what `sessionManager` already persists (per-channel session mapping in `sessions.json`).
6. **CC discipline preserved**: rotation, plugins, security args all work the same way they do for the Discord channel.

## Non-goals

- Building a UI. The adapter ships JSON + SSE only. A tiny TS client lib (`@claudeclaw/http-client`) MAY be published in a follow-up.
- Replacing the Discord/Slack/Telegram adapters. HTTP is additive.
- Per-user identity provisioning. Embedding apps own their user model; they pass `user_id` and a service token through to the channel.
- Building a multi-tenant SaaS auth layer. Single-installation, service-token-only auth in v1.
- **Storing message history.** The embedding app owns the transcript, the same way Discord owns it for the Discord adapter. CC sees a user message, runs the agent, streams the response — and forgets.

## Use cases

### Shortlist (primary v1 driver)

- One channel per trip (`channel_id = "trip:chamonix-2026"`) — plus a default channel for general planning.
- Two users (Jack, Jess) write into the same channel.
- The Shortlist agent has tools that hit the Shortlist HTTP API (create trip, add event, etc.).
- The Shortlist DB has its own `chat_messages` table per trip; PWA renders from that, POSTs new messages to CC, streams the reply back, and writes both the user message and the agent reply into its own table.

### Cursus (migration target, v0.5)

- One channel per athlete-coach pairing (`channel_id = "athlete:jack-coach:kilian"`).
- Cursus keeps its existing `chat.db` schema (it already stores messages there from the Discord bridge).
- `chat_bridge.py`'s Discord gateway plumbing is replaced by a thin HTTP client: POST messages, subscribe to SSE for agent responses, persist locally as it does today.
- Coach agents (Kilian, Tadej) become HTTP-channel agents instead of Discord-channel agents.
- Discord can stay alongside as a notification channel; the planning loop lives in the PWA.

## Branch & deployment model

- **Branch**: `feat/http-channel`, based off `production`.
- All work lands here until ready to merge into `production` and ship via `deploy.sh`.
- Eventual upstream PR(s) split this branch into logically reviewable chunks — the spec, the config, the server core, the runner bridge, tests, docs.
- Keep `src/commands/http.ts` as the headline addition — mirrors `discord.ts`/`slack.ts`/`telegram.ts` so reviewers see the parallel immediately.

## Config

New top-level `http` section in `settings.json`, mirroring the discord/slack/telegram shape:

```ts
http: {
  enabled: boolean;              // default false
  port: number;                  // default 7088
  host: string;                  // default "127.0.0.1"
  serviceToken: string;          // long-lived bearer; required when enabled
  allowedAgents: string[];       // which agent configs may be hosted, "*" = all
  maxBodyBytes: number;          // default 1_048_576
  cors: {
    enabled: boolean;            // default false (assume same-origin proxy)
    origins: string[];           // explicit list when enabled
  };
}
```

Bind to loopback by default; production deployments put it behind Cloudflare Access / Tunnel / a reverse proxy and override `host` if needed.

## Auth

**v1**: bearer service token only.

- Every API request must include `Authorization: Bearer <serviceToken>`.
- The embedding app (PWA backend, Cursus, etc.) is the trusted relay — it authenticates its own users and forwards calls to the channel with the service token + a `user_id` body/query param identifying which end-user is acting.
- The asserted `user_id` is echoed in stream events so other connected clients know who spoke, but is not persisted by CC.

**v2 (later)**: optional per-user JWT issuance for direct browser → CC HTTP calls without a relaying backend. Out of scope for v1.

## Identity model

`user_id` is an opaque string ≤ 128 chars supplied by the embedding app. CC treats it as an attribution label only — it does not store user records. (Cursus's `chat.db` already maps Discord IDs → athletes; that mapping stays in Cursus. Shortlist's DB similarly maps its auth identities → display names.)

## Channels

Channels are the conversation unit, analogous to a Discord channel/thread.

- `channel_id` (string ≤ 128 chars) — caller-defined, must be unique per agent.
- Backed 1:1 by a CC session via the existing `sessionManager` (`channel_id` is used as the `threadId`).
- No CC-side state beyond the session mapping. Channel "creation" is implicit on the first message POST.

## API surface

All paths prefixed `/v1`. JSON bodies. UTF-8.

### Health

```
GET    /v1/health
       → 200 { status: "ok", version: "1.0.0", uptime_sec: 12345 }
```

### Attachments

POST body's `attachments` field is now wired all the way through to the
agent. Wire shape — base64 inline (chosen over URL hosting for
simplicity: one POST carries everything, no second fetch round-trip, no
URL auth/expiry):

```json
{
  "attachments": [
    {
      "filename": "scan.pdf",
      "mime": "application/pdf",
      "data": "<base64>"
    }
  ]
}
```

Server flow per attachment:

1. Validate shape (`filename`, `mime`, `data` all required strings; `data`
   must be valid base64).
2. Sanitize filename (strip path components, allow `[A-Za-z0-9._-]`).
3. Decode and write to
   `<cwd>/.claude/claudeclaw/inbox/http/<channelId>/<runId>/<filename>`.
4. Build per-attachment prompt lines based on mime:
   - `image/*` → `Image path: <abs>` + "The user attached an image. Inspect this image file directly before answering."
   - `text/*` or `.txt`/`.md` → inline content (truncated at 50 KB) → `Attached text file (<name>):\n<content>`
   - everything else (PDFs, zips, audio without STT, …) → `Attached file (<name>, <mime>): <abs>` + "Use the Read tool to inspect this file…"
5. Append the lines to the user's `content` before passing to the runner.
6. After the run finishes (success or error), delete the per-run inbox dir.

**Size limits**: `http.maxBodyBytes` (default **1 MB**) caps the entire
POST including base64-encoded attachments. base64 inflates by ~33%, so
1 MB of body fits roughly a 750 KB original file. Bump `maxBodyBytes`
to 10 MB or higher if you want to support phone photos / PDFs.

**Content + attachments**: either is sufficient — an attachment-only
message (paste an image with no text) is valid. The server rejects only
when both are absent.

**SSE echo**: the `user_message` event includes attachments as
**metadata only** (`{ filename, mime, size_bytes }`), never the base64
data. The sending tab already has the file; other tabs/users see the
metadata and can fetch from their own backend if they need a preview.

**no_reply**: attachments are still decoded and persisted (so a
no-reply system message can still carry artifacts other tabs might
surface), but the per-run dir is cleaned up immediately since the agent
isn't going to run.

### Messages — the main verb

```
POST   /v1/channels/:channel_id/messages
       headers: Authorization: Bearer <serviceToken>
       body: {
         agent,                            // which CC agent config to run
         user_id,                          // attribution label
         content,                          // text
         attachments?: [{ url, mime, name }],   // embedding app hosts files; CC fetches by URL
         client_message_id?,               // echoed back in the user_message SSE event so
                                            // embedding apps can dedup their optimistic write
         no_reply?: bool                   // suppress agent run (e.g. peer-bot context message)
       }
       → 202 { run_id, queued_at, client_message_id? }
       
       The message is enqueued for the agent immediately. If a run is already
       in flight for this channel, it queues behind it (same per-thread queue
       runner.ts already uses for Discord threads).
       
       The run's output is streamed via the SSE endpoint below — POST does
       not block on the run.
```

### Streaming

```
GET    /v1/channels/:channel_id/stream[?agent=<name>]
       headers: Authorization: Bearer <serviceToken>
       → text/event-stream

       The optional ?agent=<name> filters the stream to events from a single
       agent — used by multi-agent channels (e.g. Kilian + Tadej in
       coach-chat) where one consumer only wants one bot's traffic. Events
       without an `agent` field (ping, generic error) always pass.

       Event types (data is JSON). Every agent-attributed event carries an
       `agent` field so multi-bot channels can demultiplex:

         user_message     { agent?, user_id, content, attachments, client_message_id?, posted_at }
                          — echoed to all subscribers when any user POSTs;
                          lets multi-user channels see each other live.
                          `agent` is the bot the message was addressed to
                          (POST body's `agent` field).
         agent_token      { agent, run_id, text }
                          — incremental tokens
         tool_activity    { agent, run_id, text }
                          — pre-formatted "● [Tool] summary" / "  ⎿  result" line
         agent_complete   { agent, run_id, final_text, ended_at }
         agent_busy       { agent, busy: bool }
         session_boundary { agent, previous_session_id, reason, at }
                          — emitted after a successful /reset, so frontends
                          can render a divider in the chat history. `reason`
                          is "user_reset" (normal) or "force_reset" (a run
                          was in flight and was cancelled).
         error            { agent?, run_id?, code, message }
         ping             {}                   — every 15s, keepalive

       No replay. New subscribers see only events from connection time forward.
       The embedding app reads its own message history.
```

### Channel admin (minimal)

CC's `sessions.json` is shared across all surfaces. HTTP channels are
internally namespaced as `http:<agent>:<channel_id>` so two agents can
legitimately reuse the same `channel_id` without colliding. Reset/delete
therefore require `?agent=<name>` to disambiguate.

```
POST   /v1/channels/:channel_id/reset?agent=<name>[&force=true]
       → 200 { channel_id, agent, previous_session_id, forced, message }
       Clears the CC thread session for this (agent, channel) pair. Next
       message on this channel will start a fresh CC session. Mirrors what
       `claudeclaw clear` does for the global session.

       On success, emits a `session_boundary` SSE event to the channel so
       subscribed frontends can render a divider.

       In-flight guard: if a run is currently executing on the thread, the
       default is 409 Conflict so the frontend can warn the user (their
       in-flight reply will continue to stream). Pass `?force=true` to
       cancel the running subprocess (SIGTERM, SIGKILL after 5s) and reset
       anyway; the session_boundary event then carries reason="force_reset".

       → 404 if no session exists yet.
       → 409 { error, busy: true } if a run is active and force is not set.

POST   /v1/channels/:channel_id/compact?agent=<name>
       → 200 { channel_id, agent, session_id, message }
       Compacts the CC thread session in place — keeps continuity but
       trims context. Distinct from /reset which destroys the session
       mapping. No session_boundary is emitted (the session_id is unchanged).
       → 404 if no session exists yet.
       → 409 { error, busy: true } if a run is active. Caller should retry
         after waiting for completion.

DELETE /v1/channels/:channel_id?agent=<name>
       → 204
       Removes the session mapping. Idempotent — 204 even if there was no
       existing mapping. Does NOT cancel an in-flight run or emit
       session_boundary; for user-visible resets prefer POST /reset.
       The embedding app's own data is untouched.
```

### Multi-agent channels

A single `channel_id` can host any number of agents. The HTTP server
namespaces threads internally as `http:<agent>:<channel_id>` (in
`sessions.json`), so each agent gets its own CC session under the same
channel. Two callers posting to the same `channel_id` with different
`agent` values address two different bots.

For consumers, three patterns work:

1. **One SSE stream, demultiplex by `agent` field on each event.** Best
   for chat UIs that want a single merged view of all agents in the
   channel.
2. **Two SSE streams, one per agent, with `?agent=<name>` filter.** Best
   when each agent has its own independent surface.
3. **Cross-agent context (optional, frontend choice)**: relay each
   incoming user message to each agent via separate POSTs, with a
   `[from: <name>]` prefix so the agent knows it's not the sole audience.
   The server has no opinion here — it just routes.

### Disk hygiene

`POST /reset` and `DELETE /v1/channels/:id` only drop the mapping in
`sessions.json` — the underlying Claude Code session JSONL is preserved
on disk under `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`.
This is intentional: a soft reset leaves the conversation recoverable
via `claude --resume <sessionId>`.

Over time these orphaned JSONLs accumulate. The CLI provides a GC pass:

```
claudeclaw gc-sessions [--apply] [--min-age-days=N]
       Walks ~/.claude/projects/<sanitized-cwd>/, intersects JSONL
       filenames against live session IDs (global + per-thread), lists
       orphans older than --min-age-days (default 7). Dry-run by
       default; --apply to delete.
```

### Listing (cheap, derived from sessionManager)

```
GET    /v1/channels?agent=<name>
       → 200 { channels: [{ channel_id, agent, session_id, created_at,
                            last_used_at, turn_count }] }
       Lists all live HTTP-channel thread sessions, optionally filtered by
       agent. Reads from sessionManager.listThreadSessions() and unwraps
       the http:<agent>:<channel_id> prefix; non-HTTP threads (Discord,
       Slack, Telegram) are excluded.
```

That's the whole surface for v1.

## Embedding

CC is stateless w.r.t. messages. The embedding app owns auth, persistence, optimistic UI, reconnect handling, attachment hosting, and channel lifecycle. See [HTTP_FRONTEND_SPEC.md](./HTTP_FRONTEND_SPEC.md) for the embedder's contract and checklist.

## Implementation

### File layout

```
src/commands/http.ts          — top-level command: start/stop the HTTP server, mirrors slack.ts
src/http/server.ts            — Bun.serve() bootstrap, route mounting
src/http/auth.ts              — bearer-token middleware
src/http/streamHub.ts         — in-memory pub/sub for SSE fanout per channel
src/http/runner-bridge.ts     — bridges runner.ts streamUserMessage events to SSE
```

No `store.ts`. No `messages.ts` route. No tables.

### Server lifecycle

Follows the discord/slack/telegram pattern exactly. Add an `--http` flag to `claudeclaw start --trigger`:

- `src/commands/start.ts` gets a new `httpFlag` alongside `discordFlag`/`slackFlag`/`telegramFlag`.
- When set, `start.ts` calls `import("./http").then(m => m.startHttpServer(debugFlag))`, same dynamic-import pattern as the others.
- `src/commands/http.ts` exports `startHttpServer(debug)` / `stopHttpServer()` mirroring `startGateway`/`stopGateway` in `discord.ts`.

No separate `claudeclaw http` command.

### CC session reuse

Each HTTP channel registers as a `threadId` with `sessionManager`. Existing `getThreadSession` / `createThreadSession` / `incrementThreadTurn` calls work unchanged. This means rotation, compaction, security args, plugin lifecycle all behave identically to a Discord thread — we get them for free.

### Streaming bridge

When a `POST /messages` enqueues a run:

1. Generate a `run_id`.
2. Emit `user_message` SSE to all subscribers of the channel (so other connected users see the message arrive live).
3. Call `streamUserMessage(agent, content, onChunk, onUnblock, onAgentEvent)` with handlers that:
   - `onChunk(text)` → emit `agent_token`.
   - `onAgentEvent({type:'tool_use', ...})` → emit `tool_call_start`.
   - `onAgentEvent({type:'tool_result', ...})` → emit `tool_call_result`.
4. On completion: emit `agent_complete` with the final text.
5. On error: emit `error` event with the run_id and detail.

No DB writes; everything in-process and ephemeral.

### Pub/sub fanout

`streamHub` is an in-process `Map<channel_id, Set<SSEController>>`. POST handlers and the runner bridge call `streamHub.publish(channel_id, event)`. Survives until the process restarts. SSE clients reconnect on close; missed events are gone — the embedding app's local store is the truth.

### Backpressure / queueing

Reuse `runner.ts`'s per-thread queue (it already serialises per-thread runs). HTTP channels are threads. If a second POST arrives mid-run, it queues behind the in-flight run, same as Discord behaviour.

### Security parity

- `security` settings from CC config apply to HTTP-channel runs identically to Discord.
- `model-router` applies normally.
- Plugin lifecycle (`before_agent_start`, `before_prompt_build`) fires the same way.
- Peer-bot doesn't apply (no bot identity on HTTP). Skip.

## Roadmap

### v0.1 — Walking skeleton ✅

- Config + `start --http` wiring
- `http.ts` + `server.ts` + bearer auth middleware
- POST `/v1/channels/:id/messages`
- GET `/v1/channels/:id/stream` with `user_message` / `agent_token` / `agent_complete` events
- Health endpoint
- Manual test page (`examples/http-channel-tester.html`)

v0.1 used `streamUserMessage` (the daemon-chat path) which lacks threadId, fallback handling, timeouts, and agentName support — so all HTTP channels shared the global CC session.

### v0.2 — Per-channel CC sessions ✅

- HTTP channel switched to `runUserMessage`, mirroring Discord/Slack/Telegram (they all use it; `streamUserMessage` is only used by the daemon's "chat" command in `start.ts`).
- HTTP channels pass `channelId` as the `threadId` argument, getting an independent `sessionManager` thread session per channel. Concurrent runs on different channels do not share context; same-channel runs serialise via the runner's per-thread queue.
- HTTP channels pass `agent` as the `agentName` argument, so per-agent CLAUDE.md and agent dir conventions apply.
- Inherits fallback session handling, timeouts, watchdog, and stale-session recovery from `execClaude` for free.
- Tool visibility: `runUserMessage` exposes `onToolEvent(line)` with pre-formatted strings (`● [ToolName] summary`, `  ⎿  [ToolName] result`). HTTP relays each line as a `tool_activity` SSE event. (Structured tool events are a possible future improvement once `execClaude` exposes them.)
- No `runner.ts` changes needed.

### v0.3 — Channel admin ✅

- POST `/v1/channels/:id/reset?agent=<name>` — clears the thread session; next message starts fresh
- DELETE `/v1/channels/:id?agent=<name>` — removes the thread session mapping; idempotent
- GET `/v1/channels?agent=<name>` — lists HTTP-channel thread sessions, optional agent filter
- Internal threadIds namespaced as `http:<agent>:<channel_id>` so two agents can share a `channel_id` without colliding in `sessions.json`. (Cross-cutting concern flagged: Discord/Slack/Telegram threads avoid collisions only by accident of differing ID spaces; project-wide namespacing is out of scope here but precedent is set.)

### v0.4 — Session lifecycle + multi-agent + attachments ✅

- POST `/v1/channels/:id/reset?agent=<name>` now returns 409 when a run is in flight; pass `?force=true` to cancel and reset
- POST `/v1/channels/:id/compact?agent=<name>` — in-place compact distinct from reset
- New SSE event `session_boundary { agent, previous_session_id, reason, at }` so frontends draw a divider rather than reinventing it per-app
- Every agent-attributed SSE event now carries an `agent` field; `GET /v1/channels/:id/stream?agent=<name>` filters to one agent for multi-bot channels
- Per-thread cancellation in `runner.ts` via AsyncLocalStorage-scoped subprocess tracking; new exports `cancelThread(threadId)`, `isThreadBusy(threadId)`
- `claudeclaw gc-sessions [--apply] [--min-age-days=N]` reclaims orphaned Claude Code JSONLs
- **Attachments wired end-to-end**: POST `attachments: [{ filename, mime, data }]` (base64); server validates, decodes, writes to per-run inbox dir, builds image/text/file prompt lines (mirroring Discord adapter), cleans up after run. SSE echo carries metadata only.

### v0.5 — Shortlist integration

- Shortlist v0 ships with chat panel from day one (per Path A)
- Validates: agent posting through API, PWA streaming UX, two-user concurrency

### v0.6 — Cursus migration

- Build a thin Python `http_chat_client.py` to replace `chat_bridge.py`'s outbound writes and the Discord listener
- Replace the Discord gateway code with SSE subscription
- Migrate coach agents from Discord channel → HTTP channel
- Keep Discord around for notifications only (or drop entirely)

### v0.7 — Per-user JWT auth (optional)

- Allow browsers to call the API directly without a relaying backend
- JWT signed by the embedding app's pre-registered public key

### v0.7 — Upstream PR sequence

- Split the work into reviewable chunks: spec, config, server core, runner bridge, tests, docs
- File each as a PR to `moazbuilds/claudeclaw`

## Open questions

1. **Tool call args size in SSE events**: do we ship full args (potentially large) or summaries? Default: full args, leave size limits to the embedding app.
2. **Webhook outbound parity for Cursus migration**: do we need a webhook surface so external systems can be notified of channel activity without holding an SSE connection? Defer to v0.5 once Cursus's actual needs surface during the migration.
