/**
 * Bridge from runner.ts streamUserMessage into SSE events on streamHub.
 *
 * v0.1 caveat: streamUserMessage uses the global CC session (per-thread
 * sessions for HTTP channels are a v0.2/0.3 follow-up — the existing
 * sessionManager already supports it; runner.ts needs a small extension to
 * pass through a threadId, tracked separately).
 */

import { streamUserMessage, type AgentStreamEvent } from "../runner";
import { publish } from "./streamHub";

export interface RunRequest {
  channelId: string;
  runId: string;
  agent: string;
  prompt: string;
}

/**
 * Start an agent run for a channel. Resolves when the agent has finished
 * (success or error); events are streamed to subscribers throughout.
 *
 * Errors are reported via SSE `error` events; this function does not throw
 * for run-time failures — the caller (POST /messages handler) has already
 * returned 202 by the time we get here, so throwing would just orphan.
 */
export async function runForChannel(req: RunRequest): Promise<void> {
  const { channelId, runId, agent, prompt } = req;
  const finalChunks: string[] = [];

  const onChunk = (text: string) => {
    finalChunks.push(text);
    publish(channelId, { type: "agent_token", run_id: runId, text });
  };

  const onUnblock = () => {
    // Could emit an "agent_typing" or similar; for v0.1 the first agent_token
    // event is the visible signal that the agent has started replying.
  };

  const onAgentEvent = (ev: AgentStreamEvent) => {
    if (ev.type === "spawn") {
      publish(channelId, {
        type: "tool_call_start",
        run_id: runId,
        tool_call_id: ev.id,
        tool_name: ev.description || "Agent",
      });
    } else if (ev.type === "done") {
      publish(channelId, {
        type: "tool_call_result",
        run_id: runId,
        tool_call_id: ev.id,
        result: ev.result,
      });
    }
  };

  publish(channelId, { type: "agent_busy", busy: true });
  try {
    await streamUserMessage(agent, prompt, onChunk, onUnblock, onAgentEvent);
    publish(channelId, {
      type: "agent_complete",
      run_id: runId,
      final_text: finalChunks.join(""),
      ended_at: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    publish(channelId, {
      type: "error",
      run_id: runId,
      code: "agent_run_failed",
      message,
    });
  } finally {
    publish(channelId, { type: "agent_busy", busy: false });
  }
}
