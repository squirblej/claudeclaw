/**
 * In-memory per-channel SSE subscriber registry.
 *
 * Each channel has a set of subscribers; publishing fans an event out to all
 * of them. State is process-local and ephemeral — SSE clients reconnect on
 * close and the embedding app sources backfill from its own message store
 * (see HTTP_FRONTEND_SPEC.md).
 */

/**
 * Every agent-attributed event carries an `agent` field so a single channel
 * subscriber can host messages from multiple agents (multi-bot channels).
 * Subscribers can optionally filter to one agent via Subscriber.agentFilter;
 * un-attributed events (ping, error without run, etc.) reach all subscribers.
 */
export type SseEvent =
  | { type: "user_message"; agent?: string; user_id: string; content: string; attachments?: Array<{ filename: string; mime: string; size_bytes: number }>; client_message_id?: string; posted_at: number }
  | { type: "agent_token"; agent: string; run_id: string; text: string }
  | { type: "tool_activity"; agent: string; run_id: string; text: string }       // pre-formatted "● [Tool] summary" or "  ⎿  result" line from runUserMessage's onToolEvent
  | { type: "agent_complete"; agent: string; run_id: string; final_text: string; ended_at: number }
  | { type: "agent_busy"; agent: string; busy: boolean }
  | { type: "session_boundary"; agent: string; previous_session_id: string | null; reason: "user_reset" | "force_reset"; at: number }
  | { type: "error"; agent?: string; run_id?: string; code: string; message: string }
  | { type: "ping" };

export interface Subscriber {
  send(event: SseEvent): void;
  close(): void;
  /** When set, only events whose `agent` matches (or have no `agent` field) reach this subscriber. */
  agentFilter?: string;
}

const channels = new Map<string, Set<Subscriber>>();

export function subscribe(channelId: string, sub: Subscriber): () => void {
  let set = channels.get(channelId);
  if (!set) {
    set = new Set();
    channels.set(channelId, set);
  }
  set.add(sub);
  return () => unsubscribe(channelId, sub);
}

export function unsubscribe(channelId: string, sub: Subscriber): void {
  const set = channels.get(channelId);
  if (!set) return;
  set.delete(sub);
  if (set.size === 0) channels.delete(channelId);
}

function eventAgent(event: SseEvent): string | undefined {
  return (event as { agent?: string }).agent;
}

export function publish(channelId: string, event: SseEvent): void {
  const set = channels.get(channelId);
  if (!set || set.size === 0) return;
  const agent = eventAgent(event);
  for (const sub of set) {
    // Filter: if subscriber wants a specific agent, drop events from other
    // agents. Un-attributed events (no `agent` field — ping, error sans run)
    // always pass through.
    if (sub.agentFilter && agent && sub.agentFilter !== agent) continue;
    try {
      sub.send(event);
    } catch {
      // best-effort; the subscriber's stream is presumably closed
    }
  }
}

export function subscriberCount(channelId: string): number {
  return channels.get(channelId)?.size ?? 0;
}

export function closeAll(): void {
  for (const set of channels.values()) {
    for (const sub of set) {
      try { sub.close(); } catch {}
    }
  }
  channels.clear();
}
