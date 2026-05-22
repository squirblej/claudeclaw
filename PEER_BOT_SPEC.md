# Peer Bot Awareness — Spec

## Problem

Two ClaudeClaw bots (e.g. Kilian/coach and Tadej/coach-tom) are deployed in a shared Discord channel alongside two human users for collaborative 4-way conversations. Currently `discord.ts` line 437 hard-filters all bot messages: `if (message.author.bot) return;` — so each bot is blind to what the other says. Neither bot can reference, respond to, or be aware of the other's contributions.

## Goal

Let trusted peer bots:
1. Have their messages visible in each other's Claude session context
2. Optionally trigger a response if they @mention the bot
3. Never cause infinite reply loops

## Config changes

Add `trustedBotIds` to `DiscordConfig` in `src/config.ts`:

```ts
discord: {
  token: string;
  allowedUserIds: string[];
  listenChannels: string[];
  trustedBotIds: string[];       // NEW: Discord user IDs of peer bots
  maxBotTriggerDepth: number;    // NEW: max bot→bot reply hops, default 1
}
```

Default values (in the `defaults` object):
```ts
discord: { token: "", allowedUserIds: [], listenChannels: [], trustedBotIds: [], maxBotTriggerDepth: 1 },
```

`maxBotTriggerDepth` is per-bot in each bot's `settings.json`. Set to `0` for context-only (peer bot messages visible but never trigger a response). Set to `2`+ for multi-hop chains (use with caution). Default of `1` means one bot-to-bot reply hop per exchange.

Wire them in `loadSettings` the same way `listenChannels` is handled (map to strings for `trustedBotIds`, parse int for `maxBotTriggerDepth`, fall back to defaults).

## Behaviour

### Trusted bot messages — context injection

When a message arrives from a trusted bot ID, instead of immediately returning, buffer it in a per-channel queue:

```ts
const pendingBotMessages = new Map<string, string[]>(); // channelId → prompt lines
```

For each trusted bot message, push a formatted line:
```
[Discord from <bot.username> | peer-bot] Message: <cleaned content>
```

This buffer is prepended to the next human-triggered (or bot-triggered) prompt for that channel, then cleared. Claude therefore sees peer bot messages as part of the context leading into its response, without a separate Claude run being fired for the bot message itself.

### Trusted bot messages — trigger on @mention

If the trusted bot message also @mentions this bot (i.e. `guildTriggerReason` returns `"mention"` or `"mention_in_content"`), it DOES trigger a run — but subject to the depth guard below.

Before triggering, flush the buffer (including this message) as the prompt prefix as usual.

### Depth guard — preventing infinite loops

Track bot-trigger depth per channel:

```ts
const botTriggerDepth = new Map<string, number>(); // channelId → current depth
```

Logic:
- Human message triggers a run → depth stays 0 (reset to 0 after run completes)
- Trusted bot @mention triggers a run at depth 0 → depth becomes 1, run proceeds
- Trusted bot @mention at depth >= `maxBotTriggerDepth` (default 1) → skip trigger, still buffer the message for context

After any run completes (success or error), decrement depth for that channel (min 0).

### Label format

When a trusted bot message is included in the buffered context, use the label `[Discord from <username> | peer-bot]`. This signals to Claude that the sender is another AI, not a human, without requiring any prompt-engineering in CLAUDE.md.

## Implementation — `src/commands/discord.ts`

### 1. Module-level state

```ts
const pendingBotMessages = new Map<string, string[]>();
const botTriggerDepth = new Map<string, number>();
```

### 2. Replace the hard bot filter (line 437)

Current:
```ts
if (message.author.bot) return;
```

Replace with:
```ts
if (message.author.bot) {
  const config = getSettings().discord;
  if (!config.trustedBotIds.includes(message.author.id)) return; // unknown bot, ignore

  const channelId = message.channel_id;
  const isGuild = !!message.guild_id;
  const label = `${message.author.username} | peer-bot`;
  const content = message.content.replace(/\0/g, "").trim();
  const line = `[Discord from ${label}] Message: ${content}`;

  // Always buffer for context
  const buf = pendingBotMessages.get(channelId) ?? [];
  buf.push(line);
  pendingBotMessages.set(channelId, buf);

  // Only trigger if this bot was @mentioned AND depth allows
  const triggerReason = isGuild ? guildTriggerReason(message) : null;
  const isMention = triggerReason === "mention" || triggerReason === "mention_in_content";
  const depth = botTriggerDepth.get(channelId) ?? 0;
  if (!isMention || depth >= (config.maxBotTriggerDepth ?? 1)) return;

  // Fall through to normal message handling (depth will be incremented below)
  botTriggerDepth.set(channelId, depth + 1);
  // continue to rest of handleMessageCreate as a triggered run
}
```

Because the function continues past this block into the normal message handling path, the trusted bot @mention is processed just like a human mention — using the human's existing prompt-building code. The buffered lines (including this message) are prepended to the prompt (see step 3).

### 3. Prepend buffered peer-bot messages to the prompt

Just before `const prefixedPrompt = promptParts.join("\n");` (currently line 665), insert:

```ts
const channelId = message.channel_id; // already defined above
const buffered = pendingBotMessages.get(channelId) ?? [];
if (buffered.length > 0) {
  promptParts.unshift(...buffered);
  pendingBotMessages.delete(channelId);
}
```

### 4. Decrement depth after run

After `const result = await runUserMessage(...)`:

```ts
const depth = botTriggerDepth.get(channelId) ?? 0;
if (depth > 0) botTriggerDepth.set(channelId, depth - 1);
```

## Example flow

Setup: Kilian bot has Tadej's Discord user ID in `trustedBotIds`; shared channel is NOT in `listenChannels` (mention-only).

```
Jack:  @Kilian what did Tadej say about our race plan?
Kilian: [runs, responds with plan]
Kilian: @Tadej does that match your take?
→ Tadej's bot sees @mention, triggers Tadej's session (depth 0→1)
Tadej:  [runs, responds]
Tadej:  @Kilian agreed, but I'd add X
→ Kilian sees @mention, but depth=1 >= maxBotTriggerDepth=1 → suppressed
→ Kilian buffers Tadej's message for next human trigger
Jack:  @Kilian what do you think of what Tadej added?
→ depth reset to 0; Kilian runs with Tadej's buffered message as context prefix
```

## What does NOT change

- DMs are unaffected (trusted bot logic only runs in guilds)
- `allowedUserIds` gate: if set, trusted bot IDs are exempt (they shouldn't need auth)
- Thread sessions: trusted bot messages buffer per channel ID, same as the human handling
- Telegram: untouched

## Testing

1. Add a second ClaudeClaw bot's user ID to `trustedBotIds` on one bot
2. In a channel (not in `listenChannels`), have the second bot @mention the first
3. Verify: first bot responds (depth=0 → 1)
4. First bot's response @mentions second bot → second bot responds (depth 0 → 1 in second bot's state)
5. Second bot does NOT @mention first bot → chain stops
6. Verify buffer: second bot sends a message WITHOUT @mentioning first; first bot does NOT respond; first bot's next human-triggered run includes second bot's message in context
