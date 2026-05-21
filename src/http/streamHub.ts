/**
 * In-memory per-channel SSE subscriber registry.
 *
 * Each channel has a set of subscribers; publishing fans an event out to all
 * of them. State is process-local and ephemeral — SSE clients reconnect on
 * close and the embedding app sources backfill from its own message store
 * (see HTTP_FRONTEND_SPEC.md).
 */

export type SseEvent =
  | { type: "user_message"; user_id: string; content: string; attachments?: unknown[]; client_message_id?: string; posted_at: number }
  | { type: "agent_token"; run_id: string; text: string }
  | { type: "tool_call_start"; run_id: string; tool_call_id: string; tool_name: string; args?: unknown }
  | { type: "tool_call_result"; run_id: string; tool_call_id: string; result?: unknown; error?: string }
  | { type: "agent_complete"; run_id: string; final_text: string; ended_at: number }
  | { type: "agent_busy"; busy: boolean }
  | { type: "error"; run_id?: string; code: string; message: string }
  | { type: "ping" };

export interface Subscriber {
  send(event: SseEvent): void;
  close(): void;
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

export function publish(channelId: string, event: SseEvent): void {
  const set = channels.get(channelId);
  if (!set || set.size === 0) return;
  for (const sub of set) {
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
