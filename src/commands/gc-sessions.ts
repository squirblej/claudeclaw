/**
 * `claudeclaw gc-sessions` — reclaim disk used by orphaned Claude Code session
 * transcripts.
 *
 * A session JSONL is "orphan" when its sessionId is not referenced by any live
 * mapping in claudeclaw's session stores (global session.json + per-agent
 * fallback + thread sessions). These accumulate when a channel is reset
 * (via the HTTP /reset endpoint, Discord /clear, etc.) — claudeclaw drops the
 * mapping but leaves the JSONL on disk so it stays recoverable.
 *
 * By default this is a dry run: lists what would be removed.
 * Pass `--apply` to actually delete.
 * Pass `--min-age-days=N` to only consider files older than N days
 * (default: 7 — keeps a week of soft-deleted sessions for recovery).
 */

import { readdir, stat, unlink } from "fs/promises";
import { join } from "path";
import { loadSettings } from "../config";
import { peekSession } from "../sessions";
import { listThreadSessions } from "../sessionManager";

const PROJECT_DIR = process.cwd();

function sessionsDir(): string {
  return join(
    process.env.HOME ?? "/root",
    ".claude",
    "projects",
    PROJECT_DIR.replace(/\//g, "-"),
  );
}

async function collectLiveSessionIds(): Promise<Set<string>> {
  const live = new Set<string>();

  // Global session + per-agent global sessions. We don't know agent names
  // up front, but the no-arg form covers the global slot, and agent-scoped
  // sessions live under sessions.json keyed by `agent:<name>`. listThreadSessions
  // doesn't cover those, so peekSession is the only path for the global one.
  const g = await peekSession();
  if (g?.sessionId) live.add(g.sessionId);

  for (const t of await listThreadSessions()) {
    if (t.sessionId) live.add(t.sessionId);
  }

  return live;
}

interface Orphan {
  path: string;
  sessionId: string;
  ageDays: number;
  sizeBytes: number;
}

async function findOrphans(minAgeDays: number): Promise<{ orphans: Orphan[]; scanned: number; live: number }> {
  const live = await collectLiveSessionIds();
  const dir = sessionsDir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { orphans: [], scanned: 0, live: live.size };
  }

  const now = Date.now();
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const orphans: Orphan[] = [];
  let scanned = 0;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    scanned++;
    const sessionId = name.slice(0, -".jsonl".length);
    if (live.has(sessionId)) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      const ageMs = now - st.mtimeMs;
      if (ageMs < minAgeMs) continue;
      orphans.push({
        path: full,
        sessionId,
        ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
        sizeBytes: st.size,
      });
    } catch {}
  }

  return { orphans, scanned, live: live.size };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function parseFlags(argv: string[]): { apply: boolean; minAgeDays: number } {
  let apply = false;
  let minAgeDays = 7;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--min-age-days=")) {
      const v = Number(a.slice("--min-age-days=".length));
      if (Number.isFinite(v) && v >= 0) minAgeDays = v;
    }
  }
  return { apply, minAgeDays };
}

export async function gcSessions(argv: string[] = []): Promise<void> {
  const { apply, minAgeDays } = parseFlags(argv);
  await loadSettings();

  const { orphans, scanned, live } = await findOrphans(minAgeDays);

  console.log(`Scanned ${scanned} JSONL(s) in ${sessionsDir()}`);
  console.log(`Live session IDs: ${live}`);
  console.log(`Orphans older than ${minAgeDays} day(s): ${orphans.length}`);

  if (orphans.length === 0) return;

  let totalBytes = 0;
  for (const o of orphans) {
    totalBytes += o.sizeBytes;
    console.log(`  ${o.sessionId.slice(0, 8)}…  age=${o.ageDays}d  size=${fmtBytes(o.sizeBytes)}`);
  }
  console.log(`Total: ${fmtBytes(totalBytes)}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete.`);
    return;
  }

  let removed = 0;
  for (const o of orphans) {
    try {
      await unlink(o.path);
      removed++;
    } catch (err) {
      console.error(`  failed to remove ${o.path}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Removed ${removed}/${orphans.length} orphan(s), reclaimed ${fmtBytes(totalBytes)}.`);
}
