/**
 * Bridge from runner.ts runUserMessage into SSE events on streamHub.
 *
 * Each HTTP channel maps to its own CC session: the channelId is passed as
 * the threadId, exactly like Discord/Slack/Telegram do. Per-channel runs
 * serialise via the runner's per-thread queue.
 *
 * runUserMessage exposes streaming via two callbacks:
 *   - onChunk(text)        → token deltas (fan out as agent_token)
 *   - onToolEvent(line)    → human-readable tool call/result lines
 *                            ("● [ToolName] summary", "  ⎿  [ToolName] result")
 * We pass these straight through; the embedding app decides how to render.
 */

import { runUserMessage } from "../runner";
import { publish } from "./streamHub";

export interface RunRequest {
  channelId: string;
  runId: string;
  agent: string;
  prompt: string;
}

/**
 * Start an agent run for a channel. Resolves when the agent has finished
 * (success or error); events stream throughout.
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

  const onToolEvent = (line: string) => {
    publish(channelId, { type: "tool_activity", run_id: runId, text: line });
  };

  publish(channelId, { type: "agent_busy", busy: true });
  try {
    const result = await runUserMessage(
      agent,
      prompt,
      channelId,              // threadId — gives us a per-channel CC session
      agent,                  // agentName — picks up per-agent CLAUDE.md if configured
      onChunk,
      onToolEvent,
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 4000);
      publish(channelId, {
        type: "error",
        run_id: runId,
        code: `agent_exit_${result.exitCode}`,
        message: detail || `agent exited with code ${result.exitCode}`,
      });
    }
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
