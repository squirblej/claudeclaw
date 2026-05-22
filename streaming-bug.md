# Bug: Discord streaming deadlock on text-only responses

## Summary
When `discord.streaming` is enabled (which is the default — `streaming: raw.discord?.streaming !== false` in config.ts), replies are silently dropped for any turn that produces only text with no tool events.

## Root cause
`onChunk` does not call `postPlaceholder`. `onToolEvent` does. So:
- Turns with tool use (image reading, web search, etc.) → `onToolEvent` fires → placeholder posted → `waitForStreamMsg()` resolves → `finalize()` deletes placeholder → `sendMessage` fires ✓
- Turns with pure text response (no tools) → only `onChunk` fires → `postPlaceholder` never called → `streamMsgSettled` stays `false` → `waitForStreamMsg()` hangs forever → `sendMessage` never reached ✗

Externally visible: the ⏳ placeholder never appears (no tool events = no postPlaceholder), the skill completes (exit 0, output in log), but no reply is posted to Discord. No error is logged.

## Fix applied locally (2026-05-09)
Added `postPlaceholder` call to `onChunk`, matching `onToolEvent` behaviour:

```typescript
// src/commands/discord.ts — makeDiscordStreamCallback
const onChunk = (text: string): void => {
  accumulated += text;
  if (!placeholderPosted) {
    postPlaceholder().catch((err) =>
      console.error(`[Discord][stream] postPlaceholder error: ${err instanceof Error ? err.message : err}`),
    );
  }
  if (streamMsgId) scheduleEdit();
};
```

File patched: `src/commands/discord.ts` around line 642.

## Notes
- Default `streaming: true` means this affects all bots unless `streaming: false` is explicitly set
- Bots affected: any with tool-light conversations (short factual replies, acknowledgements, etc.)
- Chef bot has `streaming: true` explicitly set; gardener and coach have no override (hit default = true)
