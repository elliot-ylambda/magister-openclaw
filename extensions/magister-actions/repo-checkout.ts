import { spawn } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/**
 * Brokered repository checkout, and what can be done with one (Phases 3.1–3.2).
 *
 * The checkout is the primitive: freezing a commit and pushing a branch both
 * operate on a tree this module put on disk and cannot exist without it, which
 * is why all three live here.
 *
 * The Gateway resolves the project's GitHub grant and posts it here; this host
 * process runs `git` with the credential reachable only through `GIT_ASKPASS`
 * plus the child's own environment. The credential never appears in argv, in a
 * remote URL, in Git config, in a response body, or anywhere the sandbox can
 * read: the model-directed shell runs `--clearenv --unshare-net --unshare-pid`
 * as a different user, so it can neither inherit the variable nor read this
 * process's `/proc` entry. Freezing a commit is purely local, so that request
 * carries no credential at all.
 *
 * Checkouts live at `/data/repos`, a volume sibling *outside* `OPENCLAW_HOME`.
 * Every recursive walk on a machine — the backup checkpointer, the boot-time
 * workspace chmod, and the restore validator — is rooted at `/data/.openclaw`
 * or narrower, so a sibling is excluded from all of them by construction rather
 * than by six exclusion lists that a seventh walk would silently miss. See
 * `docs/plans/2026-08-24-phase-3-1-checkout-limits-lock.md` in the monorepo.
 */

/** Resolved per call, not frozen at import, matching `corpus-contract.workspaceDir`. */
export function repoRoot(): string {
  return path.resolve(process.env.MAGISTER_REPO_ROOT ?? "/data/repos");
}

export const STAGING_DIR_NAME = ".staging";

export const MAX_REQUEST_BYTES = 16 * 1024;
/** Same number as `backup_checkpoint.MAX_TRACKED_FILES`, so a checkout alone
 *  cannot exhaust the checkpoint budget if the root ever moves inside HOME. */
export const MAX_CHECKOUT_FILES = 20_000;
export const MAX_CHECKOUT_BYTES = 256 * 1024 * 1024;
/** The real guard. A per-checkout cap alone never bounds the root — N
 *  checkouts still fill a 5 GB volume. Mirrors the attempt/total scratch pair
 *  in `sandbox_supervisor.py` (64 MiB / 256 MiB), same 4:1 shape. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const CLONE_TIMEOUT_MS = 120_000;
export const GIT_COMMAND_TIMEOUT_MS = 30_000;
export const CHECKOUT_TTL_MS = 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** An orphaned staging tree can only come from a crashed clone, so anything
 *  older than a clone's own ceiling is unreachable by definition. */
export const STAGING_TTL_MS = CLONE_TIMEOUT_MS * 2;
const SIZE_POLL_INTERVAL_MS = 3_000;

/** Pushing a packfile is the same kind of network operation as fetching one,
 *  so it shares the clone ceiling. The Gateway's own timeout sits above both,
 *  so a structured refusal always wins the race against a bare transport
 *  timeout. */
export const PUSH_TIMEOUT_MS = CLONE_TIMEOUT_MS;

/** A change touching more than this many files is not a diff a person reviewed,
 *  and the manifest that describes it stops being readable long before here. */
export const MAX_PREPARED_FILES = 1_000;
export const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
/** The receipt is read by the model on every call, so the manifest is bounded
 *  independently of how many files the commit is allowed to touch. */
export const MAX_MANIFEST_ENTRIES = 100;
export const MAX_MARKER_HISTORY = 20;

/** Agent commits are attributed to the agent. Borrowing the connected user's
 *  identity would put their name on work they have not read yet, and the
 *  subdomain is deliberately non-routable. */
export const COMMIT_AUTHOR_NAME = "Magister Agent";
export const COMMIT_AUTHOR_EMAIL = "agent@noreply.magistermarketing.com";

const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export type CheckoutRequest = {
  repo: string;
  ref?: string;
  discard_local_changes: boolean;
  token: string;
  mutation_context?: unknown;
};

export type CheckoutReceipt = {
  status: "checked_out" | "refreshed" | "already_current";
  repo: string;
  path: string;
  ref: string;
  commit_sha: string;
  file_count: number;
  byte_size: number;
  expires_at: string;
};

export type PrepareRequest = {
  repo: string;
  message: string;
  /** Deliberately always absent. Freezing a commit is a local `git` operation,
   *  so this is the one brokered request that never carries a credential; the
   *  field is declared so the shared handler still sees a scrubbing contract. */
  token?: undefined;
  mutation_context?: unknown;
};

export type ManifestEntry = { path: string; change: "added" | "modified" | "deleted" };

export type PrepareReceipt = {
  status: "prepared" | "already_prepared";
  repo: string;
  path: string;
  commit_sha: string;
  base_sha: string;
  message: string;
  changed_file_count: number;
  changed_files: ManifestEntry[];
  byte_size: number;
};

export type PushRequest = {
  repo: string;
  branch: string;
  commit_sha: string;
  expected_remote_sha?: string;
  token: string;
  mutation_context?: unknown;
};

export type PushReceipt = {
  status: "pushed" | "already_pushed";
  repo: string;
  branch: string;
  commit_sha: string;
  verified_sha: string;
  previous_remote_sha: string | null;
  default_branch: string;
  branch_url: string;
  pull_request_url: string;
};

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly userAction?: string,
  ) {
    super(message);
  }
}

// ── Validation ──────────────────────────────────────────────────────────

/** `owner/name`, each segment safe as a single path component.
 *
 *  The leading character class is what rejects `.` and `..`: a bare
 *  `[^/\s]+/[^/\s]+` pattern accepts `../x`, which would resolve outside the
 *  repo root. `resolveRepoDir` re-checks containment anyway. */
export function parseRepo(value: unknown): { owner: string; name: string; full: string } {
  if (typeof value !== "string" || !value.includes("/")) {
    throw new CheckoutError("repo must be in owner/name form");
  }
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new CheckoutError("repo must be in owner/name form");
  }
  const [owner = "", name = ""] = parts;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) {
    throw new CheckoutError("repo owner and name must be plain GitHub identifiers");
  }
  return { owner, name, full: `${owner}/${name}` };
}

/** A branch, a tag, or a full commit SHA.
 *
 *  A ref beginning with `-` is argv injection into `git`, which is why the
 *  first character is constrained separately. Callers additionally pass `--`
 *  before every user-supplied value. */
export function parseRef(value: unknown): { ref: string; isSha: boolean } | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new CheckoutError("ref must be a string");
  }
  if (SHA_RE.test(value)) {
    return { ref: value, isSha: true };
  }
  if (!REF_RE.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/")) {
    throw new CheckoutError("ref is not an accepted branch, tag, or commit form");
  }
  return { ref: value, isSha: false };
}

/** A branch this action is allowed to write.
 *
 *  Stricter than `parseRef`: the value is interpolated into `refs/heads/<x>`,
 *  so a leading `refs/` would silently produce `refs/heads/refs/heads/x`, and
 *  a `.lock` suffix collides with git's own ref locking. */
export function parseBranch(value: unknown): string {
  const parsed = parseRef(value);
  if (!parsed || parsed.isSha) {
    throw new CheckoutError("branch must be a branch name");
  }
  const branch = parsed.ref;
  if (branch.startsWith("refs/") || branch.endsWith(".lock") || branch.includes("/.")) {
    throw new CheckoutError("branch is not an accepted branch name");
  }
  return branch;
}

export function parseSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new CheckoutError(`${label} must be a full 40-character commit SHA`);
  }
  return value;
}

export function resolveRepoDir(owner: string, name: string): string {
  const resolved = path.resolve(repoRoot(), owner, name);
  const prefix = `${repoRoot()}${path.sep}`;
  if (!resolved.startsWith(prefix) || resolved.slice(prefix.length).split(path.sep).length !== 2) {
    throw new CheckoutError("resolved checkout path escapes the repository root", 400);
  }
  return resolved;
}

// ── Git execution ───────────────────────────────────────────────────────

type GitResult = { code: number; stdout: string; stderr: string };

/** Replace any accidental appearance of the credential before it reaches a
 *  response body or a log line. Nothing should place it there — argv and the
 *  remote URL are both clean — so this is insurance, not the mechanism. */
export function scrubToken(text: string, token: string): string {
  if (!token) {
    return text;
  }
  return text.split(token).join("***");
}

async function runGit(
  args: string[],
  options: {
    cwd?: string;
    token?: string;
    timeoutMs: number;
    onTick?: () => Promise<boolean>;
  },
): Promise<GitResult> {
  const { cwd, token, timeoutMs, onTick } = options;
  // An empty HOME plus GIT_CONFIG_NOSYSTEM means git reads no user or system
  // config, so no inherited credential.helper can cache or exfiltrate the
  // token, and no `~/.gitconfig` can rewrite the remote URL.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.join(repoRoot(), STAGING_DIR_NAME, ".githome"),
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  if (token) {
    env.GIT_ASKPASS = await ensureAskpassHelper();
    env.MAGISTER_GIT_TOKEN = token;
  }
  const child = spawn(
    "git",
    ["-c", "credential.helper=", "-c", "advice.detachedHead=false", ...args],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) {
      stderr += chunk.toString("utf8");
    }
  });

  let abortReason: string | null = null;
  const kill = (reason: string) => {
    if (abortReason) {
      return;
    }
    abortReason = reason;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => kill("timeout"), timeoutMs);
  const poll = onTick
    ? setInterval(() => {
        void onTick().then((withinBudget) => {
          if (!withinBudget) {
            kill("quota");
          }
        });
      }, SIZE_POLL_INTERVAL_MS)
    : null;

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (value) => resolve(value ?? -1));
    });
    if (abortReason === "timeout") {
      throw new CheckoutError(
        `The clone exceeded the ${Math.round(timeoutMs / 1000)}s limit.`,
        504,
        "Retry with a smaller repository, or narrow the ref.",
      );
    }
    if (abortReason === "quota") {
      throw new CheckoutError(
        "The repository exceeded the checkout size limit while cloning.",
        413,
        "This repository is too large for a brokered checkout. Use the GitHub integration to read individual files.",
      );
    }
    return { code, stdout, stderr: token ? scrubToken(stderr, token) : stderr };
  } finally {
    clearTimeout(timer);
    if (poll) {
      clearInterval(poll);
    }
  }
}

/**
 * Create the repository root at 0755, explicitly.
 *
 * The entrypoint already does this at boot, so this is the belt to that
 * braces — but it is load-bearing belt. Every other `mkdir` here is
 * `recursive: true` with mode 0700 for the staging directory, and a recursive
 * mkdir applies its mode to *every* directory it creates. On a machine where
 * the root is missing, creating `.staging` first would leave `/data/repos`
 * itself at 0700, and the tool user cannot traverse it — every checkout would
 * mount correctly and be unreadable, with nothing pointing at the cause.
 */
export async function ensureRepoRoot(): Promise<string> {
  const root = repoRoot();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o755 });
  await fs.promises.chmod(root, 0o755);
  return root;
}

const askpassByRoot = new Map<string, string>();

/** The helper itself holds no secret — it echoes the child's own environment,
 *  which only the host user can read. Written once per repository root. */
async function ensureAskpassHelper(): Promise<string> {
  const root = await ensureRepoRoot();
  const cached = askpassByRoot.get(root);
  if (cached) {
    return cached;
  }
  const dir = path.join(root, STAGING_DIR_NAME);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.join(dir, ".githome"), { recursive: true, mode: 0o700 });
  const target = path.join(dir, "askpass.sh");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    "  Username*) printf '%s\\n' 'x-access-token' ;;",
    "  *) printf '%s\\n' \"$MAGISTER_GIT_TOKEN\" ;;",
    "esac",
    "",
  ].join("\n");
  await fs.promises.writeFile(target, script, { mode: 0o700 });
  await fs.promises.chmod(target, 0o700);
  askpassByRoot.set(root, target);
  return target;
}

// ── Measurement, sweeping ───────────────────────────────────────────────

export type TreeStats = { files: number; bytes: number; exceeded: boolean };

/** Walk without following symlinks, stopping the moment a limit is passed.
 *
 *  Early exit is what makes the in-flight size poll cheap: an oversized clone
 *  is detected after a bounded number of `lstat` calls, not a full traversal. */
export async function measureTree(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<TreeStats> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      files += 1;
      try {
        bytes += (await fs.promises.lstat(full)).size;
      } catch {
        continue;
      }
      if (files > limits.maxFiles || bytes > limits.maxBytes) {
        return { files, bytes, exceeded: true };
      }
    }
  }
  return { files, bytes, exceeded: false };
}

/**
 * Mirror owner read/execute onto group and other, and drop every non-owner
 * write bit.
 *
 * The host process runs under a 0027 umask, so a fresh clone lands 0640 files
 * and 0750 directories — which the sandbox cannot read. Bubblewrap's user
 * namespace does not preserve the host supplementary-group mapping, so
 * traversal cannot rely on the shared group; `sandbox_supervisor.
 * prepare_workspace_read_surface` solves the identical problem for the
 * workspace with exactly this rule, and the checkout needs it for the same
 * reason. The bind itself is read-only, so widening the read bits grants
 * nothing beyond reading files the project already owns.
 */
export async function makeReadableByTools(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (!entry.isFile()) {
        continue;
      }
      try {
        const mode = (await fs.promises.lstat(full)).mode & 0o7777;
        const ownerReadExecute = mode & 0o500;
        await fs.promises.chmod(
          full,
          (mode & ~0o077) | (ownerReadExecute >> 3) | (ownerReadExecute >> 6),
        );
      } catch {
        continue;
      }
    }
  }
  try {
    const mode = (await fs.promises.lstat(root)).mode & 0o7777;
    const ownerReadExecute = mode & 0o500;
    await fs.promises.chmod(
      root,
      (mode & ~0o077) | (ownerReadExecute >> 3) | (ownerReadExecute >> 6),
    );
  } catch {
    // A root that vanished mid-sweep needs no permissions.
  }
}

export type PreparedCommit = {
  sha: string;
  base_sha: string;
  prepared_at: string;
  message: string;
};

export type PushedBranch = { branch: string; sha: string; pushed_at: string };

type CheckoutMarker = {
  last_used_at: string;
  repo: string;
  /** The upstream commit this checkout started from. Every manifest is diffed
   *  against it, so a stack of prepared commits still describes one change set
   *  rather than the delta since the previous freeze. */
  base_sha?: string;
  prepared?: PreparedCommit[];
  /** Branches this checkout has pushed. This — not a remote lookup — is what
   *  "Magister-owned" means: reading a branch tip's committer would cost an
   *  extra authenticated fetch, and a record we wrote ourselves cannot be
   *  spoofed by whoever last pushed to the remote. */
  pushed?: PushedBranch[];
};

/** Kept inside `.git/` on purpose: anything written into the working tree
 *  would show up as untracked in `git status --porcelain`, and the dirty-work
 *  refusal would then reject every refresh of a clean checkout. */
function markerPath(repoDir: string): string {
  return path.join(repoDir, ".git", "magister-checkout.json");
}

async function readMarker(repoDir: string): Promise<CheckoutMarker | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(markerPath(repoDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CheckoutMarker;
  } catch {
    return null;
  }
}

function trimHistory<T>(entries: T[]): T[] {
  return entries.slice(-MAX_MARKER_HISTORY);
}

async function stampMarker(
  repoDir: string,
  repo: string,
  patch?: Partial<Omit<CheckoutMarker, "last_used_at" | "repo">>,
): Promise<void> {
  const previous = (await readMarker(repoDir)) ?? {};
  const marker: CheckoutMarker = {
    ...previous,
    ...patch,
    last_used_at: new Date().toISOString(),
    repo,
  };
  await fs.promises.writeFile(markerPath(repoDir), JSON.stringify(marker), { mode: 0o600 });
}

/** Prepared commits that have not reached any remote branch.
 *
 *  These leave the working tree *clean*, so the dirty-work refusal does not see
 *  them — without this the second `checkout_repo` of a session would detach
 *  HEAD back to the upstream tip and silently orphan frozen work. */
function unpushedCommits(marker: CheckoutMarker | null): PreparedCommit[] {
  const pushed = new Set((marker?.pushed ?? []).map((entry) => entry.sha));
  return (marker?.prepared ?? []).filter((commit) => !pushed.has(commit.sha));
}

async function markerAge(repoDir: string, now: number): Promise<number> {
  const parsed = await readMarker(repoDir);
  if (parsed) {
    // Unvalidated JSON from disk: a non-string parses to NaN and falls through
    // to the directory mtime below, which is the point of the guard.
    const stamped = Date.parse(parsed.last_used_at);
    if (Number.isFinite(stamped)) {
      return now - stamped;
    }
  }
  try {
    return now - (await fs.promises.stat(repoDir)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function listCheckouts(): Promise<string[]> {
  const found: string[] = [];
  let owners: fs.Dirent[];
  try {
    owners = await fs.promises.readdir(repoRoot(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const owner of owners) {
    if (!owner.isDirectory() || owner.name.startsWith(".")) {
      continue;
    }
    let repos: fs.Dirent[];
    try {
      repos = await fs.promises.readdir(path.join(repoRoot(), owner.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const repo of repos) {
      if (repo.isDirectory() && !repo.name.startsWith(".")) {
        found.push(path.join(repoRoot(), owner.name, repo.name));
      }
    }
  }
  return found;
}

/**
 * Delete checkouts past their TTL, plus staging trees orphaned by a crash.
 *
 * Repo content is fully reproducible from the remote, so its value on the
 * volume decays to nothing while its bulk does not. This is a hard requirement
 * of the design, not housekeeping: it is the term on which repo bytes are
 * allowed onto a backed-up volume at all.
 */
export async function sweepExpiredCheckouts(now = Date.now()): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const repoDir of await listCheckouts()) {
    if ((await markerAge(repoDir, now)) > CHECKOUT_TTL_MS) {
      await fs.promises.rm(repoDir, { recursive: true, force: true });
      await pruneEmptyOwner(path.dirname(repoDir));
      removed.push(repoDir);
    }
  }
  const staging = path.join(repoRoot(), STAGING_DIR_NAME);
  let pending: fs.Dirent[] = [];
  try {
    pending = await fs.promises.readdir(staging, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of pending) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(staging, entry.name);
    try {
      if (now - (await fs.promises.stat(full)).mtimeMs > STAGING_TTL_MS) {
        await fs.promises.rm(full, { recursive: true, force: true });
        removed.push(full);
      }
    } catch {
      continue;
    }
  }
  return { removed };
}

async function pruneEmptyOwner(ownerDir: string): Promise<void> {
  try {
    const remaining = await fs.promises.readdir(ownerDir);
    if (remaining.length === 0) {
      await fs.promises.rmdir(ownerDir);
    }
  } catch {
    // A non-empty or already-removed owner directory is fine either way.
  }
}

async function totalBytes(): Promise<number> {
  let total = 0;
  for (const repoDir of await listCheckouts()) {
    total += (
      await measureTree(repoDir, {
        maxFiles: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      })
    ).bytes;
  }
  return total;
}

// ── Checkout ────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

async function headSha(repoDir: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return result.code === 0 ? result.stdout.trim() : "";
}

async function isDirty(repoDir: string): Promise<boolean> {
  const result = await runGit(["status", "--porcelain"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

function remoteUrl(repo: string): string {
  // No credential and no username here: the whole point of GIT_ASKPASS is that
  // the URL stays clean enough to appear in an error message.
  return `https://github.com/${repo}.git`;
}

async function fetchRef(
  repoDir: string,
  request: CheckoutRequest,
  ref: { ref: string; isSha: boolean } | null,
  budget: () => Promise<boolean>,
): Promise<void> {
  const target = ref ? ref.ref : "HEAD";
  const fetched = await runGit(["fetch", "--depth", "1", "--no-tags", "origin", "--", target], {
    cwd: repoDir,
    token: request.token,
    timeoutMs: CLONE_TIMEOUT_MS,
    onTick: budget,
  });
  if (fetched.code !== 0) {
    throw new CheckoutError(
      `Could not fetch ${describeRef(ref)} from ${request.repo}.`,
      422,
      truncate(fetched.stderr),
    );
  }
  const checkedOut = await runGit(["checkout", "--detach", "--force", "FETCH_HEAD"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (checkedOut.code !== 0) {
    throw new CheckoutError(
      `Could not check out ${describeRef(ref)}.`,
      422,
      truncate(checkedOut.stderr),
    );
  }
}

function describeRef(ref: { ref: string; isSha: boolean } | null): string {
  return ref ? ref.ref : "the default branch";
}

function truncate(value: string, limit = 400): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

async function performCheckout(request: CheckoutRequest): Promise<CheckoutReceipt> {
  const { owner, name, full } = parseRepo(request.repo);
  const ref = parseRef(request.ref);
  const repoDir = resolveRepoDir(owner, name);

  await ensureRepoRoot();
  await sweepExpiredCheckouts();

  const existing = await fs.promises
    .stat(path.join(repoDir, ".git"))
    .then(() => true)
    .catch(() => false);

  let status: CheckoutReceipt["status"];
  if (existing) {
    const marker = await readMarker(repoDir);
    const unpushed = unpushedCommits(marker);
    if (unpushed.length > 0 && !request.discard_local_changes) {
      throw new CheckoutError(
        `The existing checkout of ${full} has ${unpushed.length} prepared commit(s) that were never pushed.`,
        409,
        "Push that work to a branch first, or ask the user whether to discard it and retry with discard_local_changes=true.",
      );
    }
    if (await isDirty(repoDir)) {
      if (!request.discard_local_changes) {
        throw new CheckoutError(
          `The existing checkout of ${full} has uncommitted changes.`,
          409,
          "Ask the user whether to keep or discard that work; retry with discard_local_changes=true only if they choose to discard it.",
        );
      }
      await runGit(["reset", "--hard"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
      await runGit(["clean", "-fdx"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
    }
    const before = await headSha(repoDir);
    await fetchRef(repoDir, request, ref, () => withinCheckoutBudget(repoDir));
    status = (await headSha(repoDir)) === before ? "already_current" : "refreshed";
  } else {
    await ensureRoomForNewCheckout();
    await cloneFresh(repoDir, request, ref);
    status = "checked_out";
  }

  const stats = await measureTree(repoDir, {
    maxFiles: MAX_CHECKOUT_FILES,
    maxBytes: MAX_CHECKOUT_BYTES,
  });
  if (stats.exceeded) {
    await fs.promises.rm(repoDir, { recursive: true, force: true });
    await pruneEmptyOwner(path.dirname(repoDir));
    throw new CheckoutError(
      `${full} exceeds the checkout limit of ${MAX_CHECKOUT_FILES} files or ${Math.round(MAX_CHECKOUT_BYTES / (1024 * 1024))} MiB.`,
      413,
      "This repository is too large for a brokered checkout. Use the GitHub integration to read individual files.",
    );
  }

  await makeReadableByTools(repoDir);
  const head = await headSha(repoDir);
  // HEAD moved, so any prepared commit now sits on a base that is no longer
  // this checkout's. `pushed` survives: those branches still exist on the
  // remote and are still ours to fast-forward.
  await stampMarker(
    repoDir,
    full,
    status === "already_current" ? undefined : { base_sha: head, prepared: [] },
  );
  return {
    status,
    repo: full,
    path: repoDir,
    ref: ref ? ref.ref : "HEAD",
    commit_sha: head,
    file_count: stats.files,
    byte_size: stats.bytes,
    expires_at: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
  };
}

async function withinCheckoutBudget(dir: string): Promise<boolean> {
  const stats = await measureTree(dir, {
    maxFiles: MAX_CHECKOUT_FILES,
    maxBytes: MAX_CHECKOUT_BYTES,
  });
  return !stats.exceeded;
}

async function ensureRoomForNewCheckout(): Promise<void> {
  if ((await totalBytes()) < MAX_TOTAL_BYTES) {
    return;
  }
  await sweepExpiredCheckouts();
  if ((await totalBytes()) >= MAX_TOTAL_BYTES) {
    throw new CheckoutError(
      `Checked-out repositories already use the full ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MiB budget.`,
      507,
      "Finish or abandon the current repository work; unused checkouts are removed automatically after 24 hours.",
    );
  }
}

async function cloneFresh(
  repoDir: string,
  request: CheckoutRequest,
  ref: { ref: string; isSha: boolean } | null,
): Promise<void> {
  const staging = path.join(repoRoot(), STAGING_DIR_NAME, `clone-${process.pid}-${Date.now()}`);
  await fs.promises.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
  try {
    const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (ref && !ref.isSha) {
      args.push("--branch", ref.ref);
    }
    args.push("--", remoteUrl(request.repo), staging);
    const cloned = await runGit(args, {
      token: request.token,
      timeoutMs: CLONE_TIMEOUT_MS,
      onTick: () => withinCheckoutBudget(staging),
    });
    if (cloned.code !== 0) {
      throw new CheckoutError(
        `Could not clone ${request.repo} at ${describeRef(ref)}.`,
        422,
        truncate(cloned.stderr),
      );
    }
    if (ref?.isSha) {
      await fetchRef(staging, request, ref, () => withinCheckoutBudget(staging));
    }
    // 0755: the sandbox must traverse owner directories to reach the checkout,
    // and cannot rely on the shared group (see makeReadableByTools).
    await fs.promises.mkdir(path.dirname(repoDir), { recursive: true, mode: 0o755 });
    await fs.promises.chmod(path.dirname(repoDir), 0o755);
    await fs.promises.rename(staging, repoDir);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

/** One operation per repository at a time — checkout, prepare, and push all
 *  mutate the same working tree, so they share one lock rather than three.
 *
 *  Unlike the Gateway's `min instances = 2`, the OpenClaw host is a single
 *  process on a single machine, so an in-process map really is the authority
 *  here — there is no second writer to race with. */
async function withRepoLock<T>(repo: string, busy: string, task: () => Promise<T>): Promise<T> {
  const key = repo.toLowerCase();
  if (inFlight.has(key)) {
    throw new CheckoutError(
      busy,
      409,
      "Wait for the in-flight repository operation to finish, then retry.",
    );
  }
  const running = task();
  inFlight.set(key, running);
  try {
    return await running;
  } finally {
    inFlight.delete(key);
  }
}

export async function checkoutRepository(request: CheckoutRequest): Promise<CheckoutReceipt> {
  return withRepoLock(request.repo, `A checkout of ${request.repo} is already running.`, () =>
    performCheckout(request),
  );
}

// ── Prepare ─────────────────────────────────────────────────────────────

async function requireCheckout(repo: string): Promise<{ repoDir: string; full: string }> {
  const { owner, name, full } = parseRepo(repo);
  const repoDir = resolveRepoDir(owner, name);
  const present = await fs.promises
    .stat(path.join(repoDir, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!present) {
    throw new CheckoutError(
      `${full} is not checked out on this machine.`,
      409,
      "Check the repository out first, then retry.",
    );
  }
  return { repoDir, full };
}

/** `git diff --name-status`, parsed into the manifest shape the receipt uses. */
function parseNameStatus(stdout: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [code = "", file = ""] = line.split("\t");
    if (!file) {
      continue;
    }
    const change: ManifestEntry["change"] = code.startsWith("A")
      ? "added"
      : code.startsWith("D")
        ? "deleted"
        : "modified";
    entries.push({ path: file.slice(0, 200), change });
  }
  return entries;
}

async function changedBytes(repoDir: string, entries: ManifestEntry[]): Promise<number> {
  let total = 0;
  for (const entry of entries) {
    if (entry.change === "deleted") {
      continue;
    }
    try {
      total += (await fs.promises.lstat(path.join(repoDir, entry.path))).size;
    } catch {
      continue;
    }
  }
  return total;
}

/** Mirror read bits onto the files this commit touched.
 *
 *  A file the agent creates lands under the host's 0027 umask, which is fine
 *  for the sandbox's group but leaves the checkout internally inconsistent with
 *  the tree `makeReadableByTools` produced. Doing it per-manifest keeps the cost
 *  proportional to the change rather than to the repository. */
async function mirrorChangedFiles(repoDir: string, entries: ManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.change === "deleted") {
      continue;
    }
    const target = path.join(repoDir, entry.path);
    try {
      const mode = (await fs.promises.lstat(target)).mode & 0o7777;
      const ownerReadExecute = mode & 0o500;
      await fs.promises.chmod(
        target,
        (mode & ~0o077) | (ownerReadExecute >> 3) | (ownerReadExecute >> 6),
      );
    } catch {
      continue;
    }
  }
}

async function performPrepare(request: PrepareRequest): Promise<PrepareReceipt> {
  const { repoDir, full } = await requireCheckout(request.repo);
  const marker = await readMarker(repoDir);
  const prepared = marker?.prepared ?? [];
  // A marker written before this field existed, or a checkout nothing has
  // frozen yet: HEAD *is* the base in both cases.
  const base = marker?.base_sha ?? (prepared.at(-1)?.base_sha || (await headSha(repoDir)));
  // `headSha` answers with an empty string when git fails, and an empty base
  // would make every `base..sha` diff below silently report zero changed files
  // — a receipt that says nothing changed about a commit that changed plenty.
  if (!SHA_RE.test(base)) {
    throw new CheckoutError(
      `Could not determine the base commit of ${full}.`,
      409,
      "Check the repository out again, then retry.",
    );
  }

  const staged = await runGit(["add", "-A"], { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS });
  if (staged.code !== 0) {
    throw new CheckoutError(`Could not stage changes in ${full}.`, 422, truncate(staged.stderr));
  }

  const pending = await runGit(["diff", "--cached", "--name-status", "--no-renames"], {
    cwd: repoDir,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  const pendingEntries = parseNameStatus(pending.stdout);

  if (pendingEntries.length === 0) {
    const last = prepared.at(-1);
    // Re-running the same prepare after a lost response must succeed, not fail
    // with "nothing to commit": the freeze it asked for already happened.
    if (last && last.message === request.message) {
      return await prepareReceipt(repoDir, full, "already_prepared", last);
    }
    throw new CheckoutError(
      `There is nothing to commit in ${full}.`,
      409,
      "Edit files in the checkout first. Files ignored by the repository's .gitignore are never committed.",
    );
  }
  if (pendingEntries.length > MAX_PREPARED_FILES) {
    throw new CheckoutError(
      `This change touches ${pendingEntries.length} files, above the ${MAX_PREPARED_FILES}-file limit for one commit.`,
      413,
      "Split the work into smaller commits, or revert the files that were not meant to change.",
    );
  }
  const bytes = await changedBytes(repoDir, pendingEntries);
  if (bytes > MAX_PREPARED_BYTES) {
    throw new CheckoutError(
      `This change adds ${Math.round(bytes / (1024 * 1024))} MiB, above the ${Math.round(MAX_PREPARED_BYTES / (1024 * 1024))} MiB limit for one commit.`,
      413,
      "Remove large generated or binary files from the change; they usually belong in .gitignore.",
    );
  }

  const committed = await runGit(
    [
      "-c",
      `user.name=${COMMIT_AUTHOR_NAME}`,
      "-c",
      `user.email=${COMMIT_AUTHOR_EMAIL}`,
      "commit",
      "--quiet",
      "--no-verify",
      "--message",
      request.message,
    ],
    { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS },
  );
  if (committed.code !== 0) {
    throw new CheckoutError(
      `Could not create a commit in ${full}.`,
      422,
      truncate(committed.stderr),
    );
  }

  const commit: PreparedCommit = {
    sha: await headSha(repoDir),
    base_sha: base,
    prepared_at: new Date().toISOString(),
    message: request.message,
  };
  await mirrorChangedFiles(repoDir, pendingEntries);
  await stampMarker(repoDir, full, {
    base_sha: base,
    prepared: trimHistory([...prepared, commit]),
  });
  return await prepareReceipt(repoDir, full, "prepared", commit);
}

/** The manifest is always the whole change against the checkout's base, not the
 *  delta since the previous freeze — that is what a reviewer sees on the pull
 *  request, and therefore what the agent must be describing. */
async function prepareReceipt(
  repoDir: string,
  full: string,
  status: PrepareReceipt["status"],
  commit: PreparedCommit,
): Promise<PrepareReceipt> {
  const diff = await runGit(
    ["diff", "--name-status", "--no-renames", `${commit.base_sha}..${commit.sha}`],
    { cwd: repoDir, timeoutMs: GIT_COMMAND_TIMEOUT_MS },
  );
  const entries = parseNameStatus(diff.stdout);
  return {
    status,
    repo: full,
    path: repoDir,
    commit_sha: commit.sha,
    base_sha: commit.base_sha,
    message: commit.message,
    changed_file_count: entries.length,
    changed_files: entries.slice(0, MAX_MANIFEST_ENTRIES),
    byte_size: await changedBytes(repoDir, entries),
  };
}

export async function prepareRepoCommit(request: PrepareRequest): Promise<PrepareReceipt> {
  return withRepoLock(request.repo, `An operation on ${request.repo} is already running.`, () =>
    performPrepare(request),
  );
}

// ── Push ────────────────────────────────────────────────────────────────

type RemoteView = { defaultBranch: string; tip: string | null };

/** One authenticated round trip that answers both questions push needs: which
 *  branch is the default (never writable), and where the target branch is now. */
async function readRemote(
  repoDir: string,
  repo: string,
  branch: string,
  token: string,
): Promise<RemoteView> {
  const listed = await runGit(["ls-remote", "--symref", "origin", "HEAD", `refs/heads/${branch}`], {
    cwd: repoDir,
    token,
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
  });
  if (listed.code !== 0) {
    throw new CheckoutError(
      `Could not read the current state of ${repo} on GitHub.`,
      502,
      truncate(listed.stderr),
    );
  }
  let defaultBranch = "";
  let tip: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (symref?.[1]) {
      defaultBranch = symref[1];
      continue;
    }
    const [sha = "", ref = ""] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && SHA_RE.test(sha)) {
      tip = sha;
    }
  }
  if (!defaultBranch) {
    throw new CheckoutError(
      `Could not determine the default branch of ${repo}.`,
      502,
      "Retry; if it keeps failing the repository may be empty or the connection may have lost access to it.",
    );
  }
  return { defaultBranch, tip };
}

async function performPush(request: PushRequest): Promise<PushReceipt> {
  const { repoDir, full } = await requireCheckout(request.repo);
  const marker = await readMarker(repoDir);
  const prepared = marker?.prepared ?? [];
  const frozen = prepared.find((commit) => commit.sha === request.commit_sha);
  if (!frozen) {
    throw new CheckoutError(
      `${request.commit_sha.slice(0, 12)} was not prepared from this checkout.`,
      400,
      "Prepare a commit first and push the commit_sha it returns.",
    );
  }

  const remote = await readRemote(repoDir, full, request.branch, request.token);
  const receipt = (status: PushReceipt["status"], verified: string): PushReceipt => ({
    status,
    repo: full,
    branch: request.branch,
    commit_sha: request.commit_sha,
    verified_sha: verified,
    previous_remote_sha: remote.tip,
    default_branch: remote.defaultBranch,
    branch_url: `https://github.com/${full}/tree/${request.branch}`,
    pull_request_url: `https://github.com/${full}/compare/${remote.defaultBranch}...${request.branch}?expand=1`,
  });

  const recordPush = async () => {
    await stampMarker(repoDir, full, {
      pushed: trimHistory([
        ...(marker?.pushed ?? []).filter((entry) => entry.branch !== request.branch),
        { branch: request.branch, sha: request.commit_sha, pushed_at: new Date().toISOString() },
      ]),
    });
  };

  // Idempotency is checked before every refusal below. A retry after a lost
  // response finds its own commit on the branch, and must report success rather
  // than trip the "that branch already exists" rule it created.
  if (remote.tip === request.commit_sha) {
    await recordPush();
    return receipt("already_pushed", remote.tip);
  }
  if (request.branch === remote.defaultBranch) {
    throw new CheckoutError(
      `${request.branch} is the default branch of ${full}.`,
      409,
      "Push to a new branch and open a pull request; merging is the only way the default branch changes.",
    );
  }
  if (remote.tip === null) {
    if (request.expected_remote_sha) {
      throw new CheckoutError(
        `Branch ${request.branch} does not exist in ${full}, so it cannot be at ${request.expected_remote_sha.slice(0, 12)}.`,
        409,
        "Omit expected_remote_sha to create the branch, or push to the branch that does exist.",
      );
    }
  } else {
    const owned = (marker?.pushed ?? []).some((entry) => entry.branch === request.branch);
    if (!owned) {
      throw new CheckoutError(
        `Branch ${request.branch} already exists in ${full} and was not created by this checkout.`,
        409,
        "Push to a new branch name. An existing branch may hold work this project did not write.",
      );
    }
    if (request.expected_remote_sha !== remote.tip) {
      throw new CheckoutError(
        `Branch ${request.branch} has moved since it was read.`,
        409,
        `It is now at ${remote.tip.slice(0, 12)}. Re-read the branch and retry with that value as expected_remote_sha.`,
      );
    }
  }

  // Never `--force` and never `--force-with-lease`: a plain push is itself a
  // compare-and-swap, because git refuses any update that is not a
  // fast-forward. The shallow clone can push because the frozen commit's parent
  // is the remote's own tip, so there is no missing history to send.
  const pushed = await runGit(
    ["push", "origin", `${request.commit_sha}:refs/heads/${request.branch}`],
    { cwd: repoDir, token: request.token, timeoutMs: PUSH_TIMEOUT_MS },
  );
  if (pushed.code !== 0) {
    throw new CheckoutError(
      `GitHub rejected the push to ${request.branch}.`,
      409,
      truncate(pushed.stderr),
    );
  }

  const after = await readRemote(repoDir, full, request.branch, request.token);
  if (after.tip !== request.commit_sha) {
    throw new CheckoutError(
      `The push to ${request.branch} reported success but the branch is not at ${request.commit_sha.slice(0, 12)}.`,
      502,
      "Re-read the branch on GitHub before making any further change to it.",
    );
  }
  await recordPush();
  return receipt("pushed", after.tip);
}

export async function pushRepoBranch(request: PushRequest): Promise<PushReceipt> {
  return withRepoLock(request.repo, `An operation on ${request.repo} is already running.`, () =>
    performPush(request),
  );
}

// ── HTTP surface ────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new CheckoutError("checkout request is too large", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CheckoutError("checkout request must be valid JSON");
  }
}

export function parseRequest(value: unknown): CheckoutRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckoutError("checkout request must be an object");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set(["repo", "ref", "discard_local_changes", "token", "mutation_context"]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new CheckoutError("checkout request has unknown fields");
  }
  if (typeof row.token !== "string" || !row.token) {
    throw new CheckoutError("checkout request is missing the repository credential", 401);
  }
  if (row.discard_local_changes !== undefined && typeof row.discard_local_changes !== "boolean") {
    throw new CheckoutError("discard_local_changes must be a boolean");
  }
  const { full } = parseRepo(row.repo);
  const ref = parseRef(row.ref);
  return {
    repo: full,
    ref: ref?.ref,
    discard_local_changes: row.discard_local_changes === true,
    token: row.token,
    mutation_context: row.mutation_context,
  };
}

function requireFields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckoutError(`${label} request must be an object`);
  }
  const row = value as Record<string, unknown>;
  const permitted = new Set([...allowed, "mutation_context"]);
  if (Object.keys(row).some((key) => !permitted.has(key))) {
    throw new CheckoutError(`${label} request has unknown fields`);
  }
  return row;
}

export function parsePrepareRequest(value: unknown): PrepareRequest {
  const row = requireFields(value, ["repo", "message"], "prepare");
  const { full } = parseRepo(row.repo);
  if (typeof row.message !== "string" || !row.message.trim()) {
    throw new CheckoutError("prepare request needs a commit message");
  }
  if (row.message.length > 2_000) {
    throw new CheckoutError("commit message is too long");
  }
  return { repo: full, message: row.message.trim(), mutation_context: row.mutation_context };
}

export function parsePushRequest(value: unknown): PushRequest {
  const row = requireFields(
    value,
    ["repo", "branch", "commit_sha", "expected_remote_sha", "token"],
    "push",
  );
  if (typeof row.token !== "string" || !row.token) {
    throw new CheckoutError("push request is missing the repository credential", 401);
  }
  const { full } = parseRepo(row.repo);
  return {
    repo: full,
    branch: parseBranch(row.branch),
    commit_sha: parseSha(row.commit_sha, "commit_sha"),
    expected_remote_sha:
      row.expected_remote_sha === undefined || row.expected_remote_sha === null
        ? undefined
        : parseSha(row.expected_remote_sha, "expected_remote_sha"),
    token: row.token,
    mutation_context: row.mutation_context,
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

/** Parse, then run, then answer — with the credential scrubbed from every exit.
 *
 *  The request is parsed before the work starts so that the token is known for
 *  scrubbing even when the work itself is what fails. */
async function handleBrokeredPost<Request extends { token?: string }, Receipt>(
  req: IncomingMessage,
  res: ServerResponse,
  operation: {
    parse: (body: unknown) => Request;
    execute: (request: Request) => Promise<Receipt>;
    errorCode: string;
    failure: string;
  },
): Promise<boolean> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  let token = "";
  try {
    const request = operation.parse(await readJsonBody(req));
    token = request.token ?? "";
    sendJson(res, 200, await operation.execute(request));
  } catch (error) {
    const status = error instanceof CheckoutError ? error.statusCode : 500;
    const raw = error instanceof CheckoutError ? error.message : operation.failure;
    const userAction = error instanceof CheckoutError ? error.userAction : undefined;
    sendJson(res, status, {
      error: operation.errorCode,
      message: scrubToken(raw, token),
      user_action: userAction ? scrubToken(userAction, token) : undefined,
    });
  }
  return true;
}

export function handleRepoCheckout(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parseRequest,
    execute: checkoutRepository,
    errorCode: "checkout_rejected",
    failure: "checkout failed",
  });
}

export function handleRepoPrepare(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parsePrepareRequest,
    execute: prepareRepoCommit,
    errorCode: "prepare_rejected",
    failure: "preparing the commit failed",
  });
}

export function handleRepoPush(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleBrokeredPost(req, res, {
    parse: parsePushRequest,
    execute: pushRepoBranch,
    errorCode: "push_rejected",
    failure: "pushing the branch failed",
  });
}

/** Periodic TTL enforcement, independent of whether a checkout is requested.
 *
 *  Unreferenced so it can never hold the host process open. */
export function startCheckoutSweeper(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExpiredCheckouts().catch(() => undefined);
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
