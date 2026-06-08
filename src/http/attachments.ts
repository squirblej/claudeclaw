/**
 * HTTP-channel attachment handling.
 *
 * Wire format (POST body):
 *   attachments: Array<{
 *     filename: string;   // basename, no path separators
 *     mime: string;       // e.g. "image/png", "text/plain"
 *     data: string;       // base64-encoded bytes
 *   }>
 *
 * Base64 is chosen for simplicity — one POST carries everything; no second
 * fetch round-trip from CC to the frontend's storage; no URL-auth/expiry
 * problems. Trade-off: base64 inflates payload by ~33%, so `http.maxBodyBytes`
 * needs to be sized for the largest expected attachment (default is 1 MB,
 * which only covers small text/screenshot payloads — bump to 10 MB or higher
 * if you want PDFs / phone photos).
 *
 * Lifecycle: bytes get decoded and written into
 *   ~/.claude/claudeclaw/inbox/http/<channelId>/<runId>/<sanitized-filename>
 * before the agent runs, and the per-run dir is deleted in the runner-bridge
 * `finally` block once the run completes (or errors).
 */

import { mkdir, writeFile, rm, readFile } from "fs/promises";
import { join, extname, basename } from "path";

/** Parsed + decoded attachment ready for the runner. */
export interface AttachmentFile {
  path: string;      // absolute path on disk
  filename: string;  // sanitized basename
  mime: string;
  sizeBytes: number;
}

/** Metadata-only shape echoed in the user_message SSE event (no base64). */
export interface AttachmentMeta {
  filename: string;
  mime: string;
  size_bytes: number;
}

export interface ParsedAttachment {
  filename: string;
  mime: string;
  data: string; // base64
}

export interface ValidationError {
  index: number;
  reason: string;
}

const FILENAME_MAX_LEN = 200;
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

/** Strip path components and unsafe chars; fall back to a generic name if empty. */
export function sanitizeFilename(raw: string, fallbackIndex: number): string {
  const base = basename(raw).slice(0, FILENAME_MAX_LEN);
  if (SAFE_FILENAME_RE.test(base)) return base;
  // Replace unsafe chars with "_"; preserve the extension if any.
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]/g, "_");
  const cleanedExt = ext.replace(/[^A-Za-z0-9.]/g, "_");
  const out = (stem || `attachment-${fallbackIndex}`) + cleanedExt;
  return out.slice(0, FILENAME_MAX_LEN);
}

/**
 * Validate the array shape and decode each attachment's base64. Returns either
 * the parsed array (with metadata) or a list of per-index validation errors.
 */
export function validateAttachments(
  raw: unknown,
): { ok: true; parsed: ParsedAttachment[] } | { ok: false; errors: ValidationError[] } {
  if (raw === undefined || raw === null) return { ok: true, parsed: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [{ index: -1, reason: "attachments must be an array" }] };
  }
  const errors: ValidationError[] = [];
  const parsed: ParsedAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!a || typeof a !== "object") {
      errors.push({ index: i, reason: "attachment must be an object" });
      continue;
    }
    const filename = (a as { filename?: unknown }).filename;
    const mime = (a as { mime?: unknown }).mime;
    const data = (a as { data?: unknown }).data;
    if (typeof filename !== "string" || filename.length === 0) {
      errors.push({ index: i, reason: "attachment.filename must be a non-empty string" });
      continue;
    }
    if (typeof mime !== "string" || mime.length === 0) {
      errors.push({ index: i, reason: "attachment.mime must be a non-empty string" });
      continue;
    }
    if (typeof data !== "string" || data.length === 0) {
      errors.push({ index: i, reason: "attachment.data must be a non-empty base64 string" });
      continue;
    }
    parsed.push({ filename, mime, data });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, parsed };
}

function decodeBase64(s: string): Uint8Array {
  // atob ignores whitespace? Some clients add newlines. Strip first.
  const cleaned = s.replace(/\s+/g, "");
  try {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new Error("invalid base64");
  }
}

/**
 * Write decoded attachments to disk under
 * ~/.claude/claudeclaw/inbox/http/<channelId>/<runId>/.
 * Returns absolute paths + metadata for the runner.
 */
export async function persistAttachments(
  attachments: ParsedAttachment[],
  channelId: string,
  runId: string,
): Promise<{ dir: string; files: AttachmentFile[] }> {
  const dir = inboxDir(channelId, runId);
  await mkdir(dir, { recursive: true });
  const files: AttachmentFile[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    let name = sanitizeFilename(a.filename, i);
    // Avoid clobbering if the caller sent two attachments with the same name.
    if (usedNames.has(name)) {
      const ext = extname(name);
      const stem = name.slice(0, name.length - ext.length);
      name = `${stem}-${i}${ext}`;
    }
    usedNames.add(name);
    const bytes = decodeBase64(a.data);
    const path = join(dir, name);
    await writeFile(path, bytes);
    files.push({ path, filename: name, mime: a.mime, sizeBytes: bytes.length });
  }
  return { dir, files };
}

/** Remove the per-run inbox directory. Best-effort. */
export async function cleanupAttachments(dir: string): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function inboxDir(channelId: string, runId: string): string {
  // channelId is already validated to length ≤ 128 + URL-safe enough; still
  // sanitize to be defensive against unusual chars.
  const safeChannel = channelId.replace(/[^A-Za-z0-9._:-]/g, "_");
  return join(
    process.cwd(),
    ".claude",
    "claudeclaw",
    "inbox",
    "http",
    safeChannel,
    runId,
  );
}

/** Strip base64 payloads from the SSE echo — frontend already has the file. */
export function metadataFor(files: AttachmentFile[]): AttachmentMeta[] {
  return files.map((f) => ({
    filename: f.filename,
    mime: f.mime,
    size_bytes: f.sizeBytes,
  }));
}

const INLINE_TEXT_MAX_BYTES = 50_000;

/**
 * Build the prompt fragments that announce attachments to the agent.
 * Mirrors discord.ts's image / voice / text classification:
 *   - image/*           → `Image path: <abs>` + inspect instruction
 *   - text/* or .txt/.md → inline content (truncated at 50 KB)
 *   - everything else   → file path + Read-tool hint (PDFs, etc.)
 * Returned as an array of lines to append to the prompt; runner-bridge joins.
 */
export async function buildAttachmentPromptLines(files: AttachmentFile[]): Promise<string[]> {
  if (files.length === 0) return [];
  const lines: string[] = [];
  for (const f of files) {
    if (f.mime.startsWith("image/")) {
      lines.push(`Image path: ${f.path}`);
      lines.push("The user attached an image. Inspect this image file directly before answering.");
      continue;
    }
    const ext = extname(f.filename).toLowerCase();
    const isTextLike = f.mime.startsWith("text/") || ext === ".txt" || ext === ".md";
    if (isTextLike) {
      try {
        const raw = await readFile(f.path, "utf-8");
        const content = raw.length > INLINE_TEXT_MAX_BYTES
          ? raw.slice(0, INLINE_TEXT_MAX_BYTES) + "\n...[truncated]"
          : raw;
        lines.push(`Attached text file (${f.filename}):\n${content}`);
      } catch {
        lines.push(`Attached text file (${f.filename}) — could not be read.`);
      }
      continue;
    }
    // Binary file (PDF, zip, etc.). Hand the agent a path + a hint.
    lines.push(`Attached file (${f.filename}, ${f.mime}): ${f.path}`);
    lines.push(`Use the Read tool to inspect this file before answering if it's relevant.`);
  }
  return lines;
}
