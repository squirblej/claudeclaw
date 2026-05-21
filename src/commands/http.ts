/**
 * `claudeclaw http` — start the HTTP channel server (mirrors slack.ts /
 * discord.ts / telegram.ts patterns).
 *
 * In daemon mode, start.ts calls startHttp() when `--http` is passed.
 * Standalone (`bun run src/index.ts http`) is also supported for development.
 */

import { loadSettings, getSettings } from "../config";
import { ensureProjectClaudeMd } from "../runner";
import { startHttpServer, stopHttpServer } from "../http/server";
import { closeAll } from "../http/streamHub";

let started = false;

export function startHttp(debug = false): void {
  if (started) return;
  const { http } = getSettings();
  if (!http.enabled) {
    console.log("HTTP channel: enabled=false in settings — skipping start.");
    return;
  }
  if (!http.serviceToken) {
    console.error("HTTP channel: no serviceToken configured. Set http.serviceToken or CLAUDECLAW_HTTP_TOKEN.");
    return;
  }
  startHttpServer(debug);
  started = true;
}

export function stopHttp(): void {
  if (!started) return;
  stopHttpServer();
  closeAll();
  started = false;
}

process.on("SIGTERM", () => stopHttp());
process.on("SIGINT", () => stopHttp());

/** Standalone entry point: `bun run src/index.ts http` */
export async function http(): Promise<void> {
  await loadSettings();
  await ensureProjectClaudeMd();
  const { http: cfg } = getSettings();
  if (!cfg.serviceToken) {
    console.error("HTTP channel: serviceToken not configured (settings.http.serviceToken or CLAUDECLAW_HTTP_TOKEN env).");
    process.exit(1);
  }
  startHttpServer(true);
  // Keep process alive
  await new Promise(() => {});
}
