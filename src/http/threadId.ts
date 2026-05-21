/**
 * HTTP channels share the global sessions.json store with Discord/Slack/
 * Telegram threads. To prevent collisions (Discord snowflakes look nothing
 * like our channel_ids, but two different agents could legitimately use the
 * same channel_id), we namespace HTTP threadIds as:
 *
 *   http:<agent>:<channel_id>
 *
 * Callers never see this prefix — the HTTP server translates on the way in
 * and out.
 */

const PREFIX = "http:";

export function internalThreadId(agent: string, channelId: string): string {
  return `${PREFIX}${agent}:${channelId}`;
}

export interface ParsedThreadId {
  agent: string;
  channelId: string;
}

export function parseInternalThreadId(threadId: string): ParsedThreadId | null {
  if (!threadId.startsWith(PREFIX)) return null;
  const rest = threadId.slice(PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  return {
    agent: rest.slice(0, colon),
    channelId: rest.slice(colon + 1),
  };
}

export function isHttpThreadId(threadId: string): boolean {
  return threadId.startsWith(PREFIX);
}
