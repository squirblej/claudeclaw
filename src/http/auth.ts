/**
 * Bearer-token auth for HTTP channel endpoints. The token is configured under
 * settings.http.serviceToken (or via CLAUDECLAW_HTTP_TOKEN env). Embedding
 * apps proxy browser → CC; the token never reaches the browser.
 */

import { getSettings } from "../config";

export interface AuthFailure {
  ok: false;
  status: number;
  body: { error: string };
}

export interface AuthSuccess {
  ok: true;
}

export function checkBearer(req: Request): AuthSuccess | AuthFailure {
  const { http } = getSettings();
  if (!http.serviceToken) {
    return { ok: false, status: 500, body: { error: "http.serviceToken not configured" } };
  }
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return { ok: false, status: 401, body: { error: "missing bearer token" } };
  }
  const presented = header.slice("Bearer ".length).trim();
  if (presented !== http.serviceToken) {
    return { ok: false, status: 401, body: { error: "invalid bearer token" } };
  }
  return { ok: true };
}

export function isAgentAllowed(agent: string): boolean {
  const { http } = getSettings();
  if (!agent) return false;
  return http.allowedAgents.includes("*") || http.allowedAgents.includes(agent);
}
