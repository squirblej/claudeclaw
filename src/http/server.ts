/**
 * HTTP channel server. Bun.serve()-based.
 *
 * v0.1 surface:
 *   GET    /v1/health
 *   POST   /v1/channels/:id/messages
 *   GET    /v1/channels/:id/stream     (SSE)
 *
 * See HTTP_CHANNEL_SPEC.md for the full v0.1 acceptance criteria.
 */

import { getSettings } from "../config";
import { checkBearer, isAgentAllowed } from "./auth";
import { publish, subscribe, type SseEvent, type Subscriber } from "./streamHub";
import { runForChannel } from "./runner-bridge";
import { internalThreadId, parseInternalThreadId } from "./threadId";
import { peekThreadSession, removeThreadSession, listThreadSessions } from "../sessionManager";

const SERVER_VERSION = "0.1.0";
let startedAt = 0;

export interface ServerHandle {
  stop(): void;
  port: number;
}

let active: { server: ReturnType<typeof Bun.serve>; handle: ServerHandle } | null = null;

interface PostMessageBody {
  agent?: unknown;
  user_id?: unknown;
  content?: unknown;
  attachments?: unknown;
  client_message_id?: unknown;
  no_reply?: unknown;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}

function corsHeaders(): Record<string, string> {
  const { http } = getSettings();
  if (!http.cors.enabled || http.cors.origins.length === 0) return {};
  return {
    "Access-Control-Allow-Origin": http.cors.origins.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function parseChannelPath(pathname: string): { channelId: string; tail: string } | null {
  const match = pathname.match(/^\/v1\/channels\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    channelId: decodeURIComponent(match[1]!),
    tail: match[2] ?? "",
  };
}

async function readJsonBody<T>(req: Request, maxBytes: number): Promise<T | { _error: string }> {
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { _error: `body exceeds ${maxBytes} bytes` };
  }
  try {
    const text = await req.text();
    if (text.length > maxBytes) return { _error: `body exceeds ${maxBytes} bytes` };
    return JSON.parse(text) as T;
  } catch {
    return { _error: "invalid JSON body" };
  }
}

async function handleHealth(): Promise<Response> {
  return jsonResponse(200, {
    status: "ok",
    version: SERVER_VERSION,
    uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
  });
}

async function handleReset(channelId: string, agent: string): Promise<Response> {
  if (!isAgentAllowed(agent)) return jsonResponse(403, { error: `agent '${agent}' not in allowedAgents` });
  const tid = internalThreadId(agent, channelId);
  const existing = await peekThreadSession(tid);
  if (!existing) return jsonResponse(404, { error: "channel has no active session" });
  await removeThreadSession(tid);
  publish(channelId, {
    type: "agent_busy",
    busy: false,
  });
  return jsonResponse(200, {
    channel_id: channelId,
    agent,
    previous_session_id: existing.sessionId,
    message: "Next message will start a fresh CC session for this channel.",
  });
}

async function handleDelete(channelId: string, agent: string): Promise<Response> {
  if (!isAgentAllowed(agent)) return jsonResponse(403, { error: `agent '${agent}' not in allowedAgents` });
  const tid = internalThreadId(agent, channelId);
  const existing = await peekThreadSession(tid);
  if (!existing) return new Response(null, { status: 204 });
  await removeThreadSession(tid);
  return new Response(null, { status: 204 });
}

async function handleList(agentFilter: string | null): Promise<Response> {
  if (agentFilter && !isAgentAllowed(agentFilter)) {
    return jsonResponse(403, { error: `agent '${agentFilter}' not in allowedAgents` });
  }
  const all = await listThreadSessions();
  const channels: Array<{
    channel_id: string;
    agent: string;
    session_id: string;
    created_at: string;
    last_used_at: string;
    turn_count: number;
  }> = [];
  for (const s of all) {
    const parsed = parseInternalThreadId(s.threadId);
    if (!parsed) continue;
    if (agentFilter && parsed.agent !== agentFilter) continue;
    channels.push({
      channel_id: parsed.channelId,
      agent: parsed.agent,
      session_id: s.sessionId,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      turn_count: s.turnCount,
    });
  }
  return jsonResponse(200, { channels });
}

async function handlePostMessage(req: Request, channelId: string): Promise<Response> {
  const { http } = getSettings();
  const parsed = await readJsonBody<PostMessageBody>(req, http.maxBodyBytes);
  if ("_error" in parsed) return jsonResponse(400, { error: parsed._error });

  const agent = typeof parsed.agent === "string" ? parsed.agent.trim() : "";
  const userId = typeof parsed.user_id === "string" ? parsed.user_id.trim() : "";
  const content = typeof parsed.content === "string" ? parsed.content : "";
  const clientMessageId = typeof parsed.client_message_id === "string" ? parsed.client_message_id : undefined;
  const noReply = parsed.no_reply === true;
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : undefined;

  if (!agent) return jsonResponse(400, { error: "agent is required" });
  if (!userId) return jsonResponse(400, { error: "user_id is required" });
  if (!content) return jsonResponse(400, { error: "content is required" });
  if (!isAgentAllowed(agent)) return jsonResponse(403, { error: `agent '${agent}' not in allowedAgents` });

  const postedAt = Date.now();
  const runId = crypto.randomUUID();

  // Echo the user message to all subscribers immediately (so other users /
  // tabs see it live).
  publish(channelId, {
    type: "user_message",
    user_id: userId,
    content,
    ...(attachments ? { attachments } : {}),
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
    posted_at: postedAt,
  });

  if (!noReply) {
    // Fire-and-forget — the runner emits via SSE.
    runForChannel({ channelId, runId, agent, prompt: content }).catch((err) => {
      console.error(`[http] runForChannel(${channelId}) crashed:`, err);
    });
  }

  return jsonResponse(202, {
    run_id: runId,
    queued_at: postedAt,
    ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
  });
}

function handleStream(channelId: string): Response {
  const encoder = new TextEncoder();
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: SseEvent) => {
        const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller closed
        }
      };

      const subscriber: Subscriber = {
        send,
        close: () => {
          try { controller.close(); } catch {}
        },
      };

      unsubscribe = subscribe(channelId, subscriber);

      // Greet the new subscriber so they know the connection is live.
      send({ type: "ping" });

      pingInterval = setInterval(() => send({ type: "ping" }), 30_000);
    },
    cancel() {
      if (pingInterval) clearInterval(pingInterval);
      if (unsubscribe) unsubscribe();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeaders(),
    },
  });
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === "/v1/health" && method === "GET") {
    return handleHealth();
  }

  const auth = checkBearer(req);
  if (!auth.ok) return jsonResponse(auth.status, auth.body, corsHeaders());

  // GET /v1/channels?agent=<name> — list (no channel_id in path)
  if (url.pathname === "/v1/channels" && method === "GET") {
    return handleList(url.searchParams.get("agent"));
  }

  const parsed = parseChannelPath(url.pathname);
  if (parsed) {
    const { channelId, tail } = parsed;
    if (!channelId || channelId.length > 128) {
      return jsonResponse(400, { error: "channel_id must be 1..128 chars" });
    }
    if (tail === "messages" && method === "POST") {
      const resp = await handlePostMessage(req, channelId);
      const cors = corsHeaders();
      if (Object.keys(cors).length > 0) for (const [k, v] of Object.entries(cors)) resp.headers.set(k, v);
      return resp;
    }
    if (tail === "stream" && method === "GET") {
      return handleStream(channelId);
    }
    if (tail === "reset" && method === "POST") {
      const agent = url.searchParams.get("agent");
      if (!agent) return jsonResponse(400, { error: "?agent= query param required" });
      return handleReset(channelId, agent);
    }
    if (tail === "" && method === "DELETE") {
      const agent = url.searchParams.get("agent");
      if (!agent) return jsonResponse(400, { error: "?agent= query param required" });
      return handleDelete(channelId, agent);
    }
  }

  return jsonResponse(404, { error: "not found" });
}

export function startHttpServer(debug = false): ServerHandle {
  if (active) return active.handle;

  const { http } = getSettings();
  if (!http.serviceToken) {
    throw new Error("http.serviceToken not configured (or CLAUDECLAW_HTTP_TOKEN env)");
  }

  startedAt = Date.now();

  const server = Bun.serve({
    hostname: http.host,
    port: http.port,
    fetch: route,
    error(err) {
      console.error("[http] server error:", err);
      return jsonResponse(500, { error: "internal" });
    },
  });

  const boundPort = typeof server.port === "number" ? server.port : http.port;
  const handle: ServerHandle = {
    port: boundPort,
    stop() {
      try { server.stop(true); } catch {}
      active = null;
    },
  };
  active = { server, handle };

  console.log(`HTTP channel listening on http://${http.host}:${boundPort}`);
  if (http.allowedAgents.includes("*")) {
    console.log("  Allowed agents: *");
  } else {
    console.log(`  Allowed agents: ${http.allowedAgents.join(", ") || "(none — channel will reject all)"}`);
  }
  if (debug) console.log("  Debug: enabled");

  return handle;
}

export function stopHttpServer(): void {
  if (active) active.handle.stop();
}
