import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { writeFileWithinRoot } from "../../infra/fs-safe.js";

/**
 * Inline pastes become workspace files before the model sees the turn.
 *
 * A user who pastes a spreadsheet export into chat wants it computed over,
 * but the paste exists only inside the prompt: there is no file for `exec`
 * to read, and a model that goes looking for one finds nothing (or, before
 * the session-store guard, its own transcript). Writing the block to
 * `inbox/` and naming the path in the prompt gives "compute, don't eyeball"
 * something to compute on. The inline copy stays in the message untouched;
 * this only adds the file and the note.
 */

export const INBOX_DIR = "inbox";
// The model's shell runs in the sandbox as the separate `agent-tool` user
// (bwrap `--uid`/`--gid` both set to that uid), so a file only the host user
// can read is a file the agent cannot compute from. fs-safe writes 0600 under
// the host umask; the rest of the workspace is 0644/0755, and so is the inbox.
export const INBOX_DIR_MODE = 0o755;
export const INBOX_FILE_MODE = 0o644;
/** Below this the model reads the paste fine inline; above it, arithmetic by eye starts failing. */
export const DEFAULT_PASTE_MIN_CHARS = 4000;
/** Matches the media store's inbound cap; a chat paste past this is not a paste. */
export const DEFAULT_PASTE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PASTES_PER_MESSAGE = 8;
/** An unfenced run must be at least this many rows to read as tabular data, not prose. */
const MIN_DELIMITED_LINES = 20;
/** At least three columns: two delimiters per line. */
const MIN_DELIMITERS_PER_LINE = 2;
const MAX_NAME_CHARS = 64;

export type InlinePaste = {
  kind: "fenced" | "delimited";
  /** 0-based line index of the first content line. */
  startLine: number;
  /** 0-based line index one past the last content line. */
  endLine: number;
  text: string;
  ext: string;
  /** File name inferred from a nearby `something.csv` mention, already sanitized. */
  name?: string;
};

export type MaterializedPaste = {
  /** POSIX path relative to the workspace root, e.g. `inbox/ads_daily-3f2a9c1e.csv`. */
  path: string;
  bytes: number;
  lines: number;
  /** The inferred or generated base name, for the prompt note. */
  name: string;
};

const FENCE_OPEN = /^\s*(```|~~~)\s*([A-Za-z0-9_.+-]*)\s*$/;
const FENCE_CLOSE = /^\s*(```|~~~)\s*$/;
const NAME_MENTION =
  /([A-Za-z0-9][A-Za-z0-9_.-]*\.(csv|tsv|json|txt|md|xml|ya?ml|log|sql|html?))\b/i;

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  jsonl: "jsonl",
  ndjson: "jsonl",
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  yaml: "yml",
  yml: "yml",
  xml: "xml",
  html: "html",
  htm: "html",
  sql: "sql",
  js: "js",
  javascript: "js",
  ts: "ts",
  typescript: "ts",
  py: "py",
  python: "py",
  sh: "sh",
  bash: "sh",
};

function extensionForLanguage(language: string): string {
  return LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? "txt";
}

function countChar(line: string, char: string): number {
  let count = 0;
  for (const c of line) {
    if (c === char) {
      count += 1;
    }
  }
  return count;
}

type Delimiter = { char: string; ext: string };
const DELIMITERS: Delimiter[] = [
  { char: "\t", ext: "tsv" },
  { char: ",", ext: "csv" },
  { char: "|", ext: "txt" },
];

/** The delimiter a line reads as tabular under, if any: tabs win over commas over pipes. */
function delimiterOf(line: string): { delimiter: Delimiter; count: number } | null {
  for (const delimiter of DELIMITERS) {
    const count = countChar(line, delimiter.char);
    if (count >= MIN_DELIMITERS_PER_LINE) {
      return { delimiter, count };
    }
  }
  return null;
}

export function sanitizePasteName(raw: string): string | undefined {
  const base = path.posix.basename(raw.replace(/\\/g, "/")).trim();
  const cleaned = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return undefined;
  }
  return cleaned.slice(0, MAX_NAME_CHARS);
}

function inferName(lines: string[], beforeLine: number): string | undefined {
  let seen = 0;
  for (let i = beforeLine - 1; i >= 0 && seen < 3; i -= 1) {
    const candidate = lines[i]?.trim();
    if (!candidate) {
      continue;
    }
    seen += 1;
    const match = NAME_MENTION.exec(candidate);
    if (match) {
      return sanitizePasteName(match[1]);
    }
  }
  return undefined;
}

/**
 * Find the large data blocks in a message body: fenced blocks first, then
 * unfenced runs of delimiter-consistent lines outside any fence. Pure.
 */
export function detectInlinePastes(
  body: string,
  options: { minChars?: number } = {},
): InlinePaste[] {
  const minChars = options.minChars ?? DEFAULT_PASTE_MIN_CHARS;
  const lines = body.split("\n");
  const pastes: InlinePaste[] = [];
  const fenced = Array.from({ length: lines.length }, () => false);

  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i] ?? "");
    if (!open) {
      continue;
    }
    const marker = open[1];
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = FENCE_CLOSE.exec(lines[j] ?? "");
      if (candidate && candidate[1] === marker) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      break;
    }
    for (let k = i; k <= close; k += 1) {
      fenced[k] = true;
    }
    const text = lines.slice(i + 1, close).join("\n");
    if (text.length >= minChars) {
      const name = inferName(lines, i);
      const ext = name
        ? path.posix.extname(name).slice(1) || extensionForLanguage(open[2] ?? "")
        : extensionForLanguage(open[2] ?? "");
      pastes.push({ kind: "fenced", startLine: i + 1, endLine: close, text, ext, name });
    }
    i = close;
  }

  let i = 0;
  while (i < lines.length) {
    if (fenced[i]) {
      i += 1;
      continue;
    }
    const first = delimiterOf(lines[i] ?? "");
    if (!first || !(lines[i] ?? "").trim()) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !fenced[end]) {
      const line = lines[end] ?? "";
      if (!line.trim()) {
        break;
      }
      const count = countChar(line, first.delimiter.char);
      // Quoted commas inside a cell move the count by one or two; a
      // different shape entirely ends the run.
      if (count < MIN_DELIMITERS_PER_LINE || Math.abs(count - first.count) > 2) {
        break;
      }
      end += 1;
    }
    const runLines = end - i;
    if (runLines >= MIN_DELIMITED_LINES) {
      const text = lines.slice(i, end).join("\n");
      if (text.length >= minChars) {
        const name = inferName(lines, i);
        const ext = name
          ? path.posix.extname(name).slice(1) || first.delimiter.ext
          : first.delimiter.ext;
        pastes.push({ kind: "delimited", startLine: i, endLine: end, text, ext, name });
      }
    }
    i = Math.max(end, i + 1);
  }

  pastes.sort((a, b) => a.startLine - b.startLine);
  return pastes;
}

function runSuffix(runId: string | undefined): string {
  // The tail, not the head: gateway run ids are `chatcmpl_<uuid>`, so the first
  // eight characters are the same literal prefix on every turn and a later
  // paste would overwrite an earlier one under the same name.
  const cleaned = (runId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8);
  return cleaned || Date.now().toString(36);
}

function formatFileName(
  paste: InlinePaste,
  index: number,
  suffix: string,
  used: Set<string>,
): string {
  const stem = paste.name
    ? paste.name.slice(0, paste.name.length - path.posix.extname(paste.name).length) ||
      `paste-${index + 1}`
    : `paste-${index + 1}`;
  let fileName = `${stem}-${suffix}.${paste.ext}`;
  let dedupe = 2;
  while (used.has(fileName)) {
    fileName = `${stem}-${suffix}-${dedupe}.${paste.ext}`;
    dedupe += 1;
  }
  used.add(fileName);
  return fileName;
}

/**
 * Write each detected paste to `<workspace>/inbox/<name>-<run>.<ext>` and
 * describe what was written. Never throws: a paste that cannot be written is
 * skipped with a verbose log, because the reply must not fail on a
 * convenience file.
 */
/**
 * The config-gated entry every turn path shares: the auto-reply pipeline
 * (channel messages) and the gateway's agent command (webchat, the OpenAI- and
 * OpenResponses-compatible HTTP endpoints, cron). Default on; the
 * `agents.defaults.pasteMaterialization` block is the override, never the
 * source of the default, so a machine config without the key keeps working.
 */
export async function materializeInlinePastesForTurn(params: {
  cfg: OpenClawConfig;
  body: string | undefined;
  workspaceDir: string;
  runId?: string;
}): Promise<MaterializedPaste[]> {
  const pasteConfig = params.cfg.agents?.defaults?.pasteMaterialization;
  if (pasteConfig?.enabled === false) {
    return [];
  }
  return await materializeInlinePastes({
    body: params.body,
    workspaceDir: params.workspaceDir,
    runId: params.runId,
    minChars: pasteConfig?.minChars,
  });
}

export async function materializeInlinePastes(params: {
  body: string | undefined;
  workspaceDir: string;
  runId?: string;
  minChars?: number;
  maxBytes?: number;
}): Promise<MaterializedPaste[]> {
  const body = params.body ?? "";
  if (!body.trim()) {
    return [];
  }
  const maxBytes = params.maxBytes ?? DEFAULT_PASTE_MAX_BYTES;
  const pastes = detectInlinePastes(body, { minChars: params.minChars }).slice(
    0,
    MAX_PASTES_PER_MESSAGE,
  );
  if (pastes.length === 0) {
    return [];
  }
  const suffix = runSuffix(params.runId);
  const used = new Set<string>();
  const written: MaterializedPaste[] = [];
  for (const [index, paste] of pastes.entries()) {
    const data = paste.text.endsWith("\n") ? paste.text : `${paste.text}\n`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > maxBytes) {
      logVerbose(`paste-materializer: skipping ${bytes}-byte paste over the ${maxBytes}-byte cap`);
      continue;
    }
    const fileName = formatFileName(paste, index, suffix, used);
    const relativePath = `${INBOX_DIR}/${fileName}`;
    try {
      await writeFileWithinRoot({
        rootDir: params.workspaceDir,
        relativePath,
        data,
        encoding: "utf8",
        mkdir: true,
      });
      // fs-safe writes 0600 under the host umask (027 on machines) and mkdir
      // makes the directory under it too; chmod is what the sandbox user sees.
      await fs.chmod(path.join(params.workspaceDir, relativePath), INBOX_FILE_MODE);
      await fs.chmod(path.join(params.workspaceDir, INBOX_DIR), INBOX_DIR_MODE);
    } catch (error) {
      logVerbose(`paste-materializer: could not write ${relativePath}: ${String(error)}`);
      continue;
    }
    written.push({
      path: relativePath,
      bytes,
      lines: data.split("\n").length - 1,
      name: paste.name ?? fileName,
    });
  }
  return written;
}
