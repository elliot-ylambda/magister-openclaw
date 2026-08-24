import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKOUT_TTL_MS,
  CheckoutError,
  COMMIT_AUTHOR_EMAIL,
  checkoutRepository,
  ensureRepoRoot,
  MAX_MANIFEST_PATH_CHARS,
  makeReadableByTools,
  measureTree,
  parseBranch,
  parsePushRequest,
  parseRef,
  parseRepo,
  parseRequest,
  prepareRepoCommit,
  pushRepoBranch,
  resolveRepoDir,
  scrubToken,
  sweepExpiredCheckouts,
} from "./repo-checkout.js";

const temporary: string[] = [];

afterEach(() => {
  delete process.env.MAGISTER_REPO_ROOT;
  for (const root of temporary.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** A real upstream repository plus a real shallow checkout of it, so the
 *  refresh, dirty-refusal, and idempotency paths run against actual git. */
function upstreamAndCheckout(): { origin: string; repoDir: string; root: string } {
  const origin = scratch("magister-origin-");
  git(origin, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(origin, "README.md"), "first\n");
  git(origin, "add", "README.md");
  git(origin, "commit", "--quiet", "-m", "first");

  const root = scratch("magister-repos-");
  process.env.MAGISTER_REPO_ROOT = root;
  const repoDir = path.join(root, "acme", "site");
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
  return { origin, repoDir, root };
}

/** A *bare* upstream, which is what push needs: git refuses to update the
 *  checked-out branch of a repository that has a working tree. */
function bareUpstreamAndCheckout(): {
  origin: string;
  seed: string;
  repoDir: string;
  root: string;
} {
  const seed = scratch("magister-seed-");
  git(seed, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(seed, "README.md"), "first\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "first");

  const origin = scratch("magister-bare-");
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(seed, "push", "--quiet", `file://${origin}`, "main");

  const root = scratch("magister-repos-");
  process.env.MAGISTER_REPO_ROOT = root;
  const repoDir = path.join(root, "acme", "site");
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  git(root, "clone", "--quiet", "--depth", "1", `file://${origin}`, repoDir);
  git(repoDir, "checkout", "--quiet", "--detach", "HEAD");
  return { origin, seed, repoDir, root };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    discard_local_changes: false,
    token: "ghu_test_token",
    ...overrides,
  } as Parameters<typeof checkoutRepository>[0];
}

function prepare(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    message: "Update the readme",
    ...overrides,
  } as Parameters<typeof prepareRepoCommit>[0];
}

function push(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    branch: "magister/readme",
    token: "ghu_test_token",
    ...overrides,
  } as Parameters<typeof pushRepoBranch>[0];
}

function remoteTip(origin: string, branch: string): string | null {
  const listed = git(origin, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
  return listed.trim() || null;
}

describe("repository identity validation", () => {
  it("accepts a plain owner/name pair", () => {
    expect(parseRepo("acme/site").full).toBe("acme/site");
    expect(parseRepo("a-b_c.d/e.f-g_h").full).toBe("a-b_c.d/e.f-g_h");
  });

  it("rejects traversal segments that a naive owner/name pattern would allow", () => {
    // `^[^/\s]+/[^/\s]+$` matches all of these; each resolves outside the root.
    for (const value of ["../etc", "../..", "acme/..", "./x", "acme/."]) {
      expect(() => parseRepo(value)).toThrow(CheckoutError);
    }
  });

  it("rejects shapes that are not exactly two segments", () => {
    for (const value of ["acme", "acme/site/extra", "/site", "acme/", "acme site", 7, null]) {
      expect(() => parseRepo(value)).toThrow(CheckoutError);
    }
  });

  it("keeps a resolved checkout directory inside the repository root", () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    expect(resolveRepoDir("acme", "site")).toBe(path.join(root, "acme", "site"));
  });
});

describe("ref validation", () => {
  it("accepts branches, tags, and full commit SHAs", () => {
    expect(parseRef("main")).toEqual({ ref: "main", isSha: false });
    expect(parseRef("release/2026.8")).toEqual({ ref: "release/2026.8", isSha: false });
    expect(parseRef("v1.2.3")).toEqual({ ref: "v1.2.3", isSha: false });
    const sha = "a".repeat(40);
    expect(parseRef(sha)).toEqual({ ref: sha, isSha: true });
  });

  it("treats an absent ref as the default branch", () => {
    expect(parseRef(undefined)).toBeNull();
    expect(parseRef("")).toBeNull();
  });

  it("rejects a leading dash, which would be argv injection into git", () => {
    expect(() => parseRef("--upload-pack=touch /tmp/pwned")).toThrow(CheckoutError);
    expect(() => parseRef("-x")).toThrow(CheckoutError);
  });

  it("rejects traversal and malformed ref punctuation", () => {
    for (const value of ["a..b", "a//b", "trailing/", "with space", "tab\there"]) {
      expect(() => parseRef(value)).toThrow(CheckoutError);
    }
  });
});

describe("request parsing", () => {
  it("rejects unknown fields and a missing credential", () => {
    expect(() => parseRequest({ repo: "acme/site", token: "t", surprise: 1 })).toThrow(
      /unknown fields/,
    );
    expect(() => parseRequest({ repo: "acme/site" })).toThrow(/credential/);
    expect(() => parseRequest("nope")).toThrow(CheckoutError);
  });

  it("defaults the discard flag to false so dirty work is never dropped by omission", () => {
    expect(parseRequest({ repo: "acme/site", token: "t" }).discard_local_changes).toBe(false);
    expect(
      parseRequest({ repo: "acme/site", token: "t", discard_local_changes: true })
        .discard_local_changes,
    ).toBe(true);
  });
});

describe("token scrubbing", () => {
  it("removes every occurrence of the credential from text", () => {
    expect(scrubToken("fatal: ghu_secret rejected ghu_secret", "ghu_secret")).toBe(
      "fatal: *** rejected ***",
    );
    expect(scrubToken("clean output", "")).toBe("clean output");
  });
});

describe("tree measurement", () => {
  it("counts files and bytes without following symlinks", async () => {
    const root = scratch("magister-measure-");
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.txt"), "12345");
    fs.writeFileSync(path.join(root, "nested", "b.txt"), "678");
    fs.symlinkSync("/etc/passwd", path.join(root, "link"));

    const stats = await measureTree(root, { maxFiles: 100, maxBytes: 1_000 });
    expect(stats.exceeded).toBe(false);
    expect(stats.files).toBe(3);
    expect(stats.bytes).toBe(8);
  });

  it("stops early once a limit is passed", async () => {
    const root = scratch("magister-measure-");
    for (let index = 0; index < 20; index += 1) {
      fs.writeFileSync(path.join(root, `f${index}.txt`), "x");
    }
    const stats = await measureTree(root, { maxFiles: 5, maxBytes: 1_000 });
    expect(stats.exceeded).toBe(true);
    expect(stats.files).toBeLessThan(20);
  });
});

describe("sandbox readability", () => {
  it("mirrors owner read/execute onto other without granting any write bit", async () => {
    const root = scratch("magister-perms-");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const plain = path.join(root, "README.md");
    const script = path.join(root, "bin", "build.sh");
    fs.writeFileSync(plain, "text");
    fs.writeFileSync(script, "#!/bin/sh\n");
    // What a clone under the host's 0027 umask actually produces.
    fs.chmodSync(root, 0o750);
    fs.chmodSync(path.join(root, "bin"), 0o750);
    fs.chmodSync(plain, 0o640);
    fs.chmodSync(script, 0o750);

    await makeReadableByTools(root);

    const mode = (target: string) => fs.statSync(target).mode & 0o777;
    expect(mode(root)).toBe(0o755);
    expect(mode(path.join(root, "bin"))).toBe(0o755);
    expect(mode(plain)).toBe(0o644);
    // An executable stays executable; the sandbox runs build scripts it reads.
    expect(mode(script)).toBe(0o755);
    for (const target of [root, path.join(root, "bin"), plain, script]) {
      expect(mode(target) & 0o022).toBe(0);
    }
  });

  it("leaves a checked-out tree readable by a non-owner", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    expect(fs.statSync(path.join(repoDir, "README.md")).mode & 0o004).toBe(0o004);
    expect(fs.statSync(repoDir).mode & 0o005).toBe(0o005);
  });

  it("creates a missing repository root traversable, not 0700", async () => {
    // Every other mkdir here is `recursive: true` with mode 0700 for the
    // staging directory, and a recursive mkdir applies its mode to every
    // directory it creates. If one of those created the root, it would land
    // 0700 and the tool user could not traverse it — the bind would mount
    // fine and every checkout would be silently unreadable.
    const root = path.join(scratch("magister-parent-"), "repos");
    process.env.MAGISTER_REPO_ROOT = root;
    expect(fs.existsSync(root)).toBe(false);

    await ensureRepoRoot();

    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });

  it("repairs a root that is already too restrictive", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    fs.chmodSync(root, 0o700);

    await ensureRepoRoot();

    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
  });
});

describe("brokered checkout against a real repository", () => {
  it("reports an unchanged checkout as already_current", async () => {
    upstreamAndCheckout();
    const receipt = await checkoutRepository(request());
    expect(receipt.status).toBe("already_current");
    expect(receipt.repo).toBe("acme/site");
    expect(receipt.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.file_count).toBeGreaterThan(0);
  });

  it("fast-forwards to a new upstream commit", async () => {
    const { origin, repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(origin, "README.md"), "second\n");
    git(origin, "commit", "--quiet", "-am", "second");

    const receipt = await checkoutRepository(request());
    expect(receipt.status).toBe("refreshed");
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("second\n");
  });

  it("refuses to overwrite dirty work and never discards it implicitly", async () => {
    const { repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "local edit\n");

    await expect(checkoutRepository(request())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("uncommitted changes"),
    });
    // The refusal must leave the user's work exactly as it was.
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("local edit\n");
  });

  it("discards dirty work only when the caller asks explicitly", async () => {
    const { repoDir } = upstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "local edit\n");
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "scratch\n");

    const receipt = await checkoutRepository(request({ discard_local_changes: true }));
    expect(receipt.status).toBe("already_current");
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf8")).toBe("first\n");
    expect(fs.existsSync(path.join(repoDir, "untracked.txt"))).toBe(false);
  });

  it("keeps its bookkeeping out of the working tree", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    // A marker written beside the source would make git status non-empty, and
    // the dirty-work refusal would then reject every subsequent refresh.
    expect(git(repoDir, "status", "--porcelain").trim()).toBe("");
    expect(fs.existsSync(path.join(repoDir, ".git", "magister-checkout.json"))).toBe(true);
  });

  it("serialises concurrent checkouts of the same repository", async () => {
    upstreamAndCheckout();
    const first = checkoutRepository(request());
    await expect(checkoutRepository(request())).rejects.toMatchObject({ statusCode: 409 });
    await first;
    // The slot must clear so later work is not latched out.
    await expect(checkoutRepository(request())).resolves.toMatchObject({
      status: "already_current",
    });
  });
});

describe("TTL sweeping", () => {
  it("removes a checkout past its TTL and prunes the empty owner directory", async () => {
    const { repoDir, root } = upstreamAndCheckout();
    const stale = new Date(Date.now() - CHECKOUT_TTL_MS - 60_000).toISOString();
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: stale, repo: "acme/site" }),
    );

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(false);
    expect(fs.existsSync(path.join(root, "acme"))).toBe(false);
  });

  it("keeps a checkout that is still inside its TTL", async () => {
    const { repoDir } = upstreamAndCheckout();
    await checkoutRepository(request());
    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).not.toContain(repoDir);
    expect(fs.existsSync(repoDir)).toBe(true);
  });

  it("never deletes a checkout an operation is standing in", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    // The marker is only stamped when an operation *finishes*, and the sweeper
    // also runs on its own hourly timer — so a prepare against a day-old
    // checkout is exactly when the two collide.
    const pending = prepareRepoCommit(prepare());

    const swept = await sweepExpiredCheckouts(Date.now() + CHECKOUT_TTL_MS * 2);

    expect(swept.removed).toEqual([]);
    await expect(pending).resolves.toMatchObject({ status: "prepared" });
    expect(fs.existsSync(repoDir)).toBe(true);
    // Once it is idle again the same sweep does collect it.
    const after = await sweepExpiredCheckouts(Date.now() + CHECKOUT_TTL_MS * 2);
    expect(after.removed).toContain(repoDir);
  });

  it("removes a staging tree orphaned by a crashed clone", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    const orphan = path.join(root, ".staging", "clone-1-1");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "partial"), "x");
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(orphan, old, old);

    const swept = await sweepExpiredCheckouts();
    expect(swept.removed).toContain(orphan);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe("branch validation", () => {
  it("accepts ordinary branch names", () => {
    expect(parseBranch("magister/readme")).toBe("magister/readme");
    expect(parseBranch("fix-1.2")).toBe("fix-1.2");
  });

  it("rejects a value that would nest inside refs/heads twice", () => {
    // `refs/heads/x` becomes `refs/heads/refs/heads/x` when interpolated.
    expect(() => parseBranch("refs/heads/main")).toThrow(CheckoutError);
  });

  it("rejects git's own reserved ref shapes and argv injection", () => {
    for (const value of ["-x", "a..b", "feature.lock", "feature/.hidden", "a//b", ""]) {
      expect(() => parseBranch(value)).toThrow(CheckoutError);
    }
  });

  it("rejects a commit SHA, which is a ref but never a branch to create", () => {
    expect(() => parseBranch("a".repeat(40))).toThrow(CheckoutError);
  });
});

describe("push request parsing", () => {
  it("requires a full SHA and a credential, and rejects unknown fields", () => {
    expect(() => parsePushRequest({ ...push(), commit_sha: "abc123" })).toThrow(/40-character/);
    expect(() =>
      parsePushRequest({ repo: "acme/site", branch: "b", commit_sha: "a".repeat(40) }),
    ).toThrow(/credential/);
    expect(() => parsePushRequest({ ...push(), commit_sha: "a".repeat(40), extra: 1 })).toThrow(
      /unknown fields/,
    );
  });

  it("treats an absent expected_remote_sha as 'this branch must not exist'", () => {
    const parsed = parsePushRequest({ ...push(), commit_sha: "a".repeat(40) });
    expect(parsed.expected_remote_sha).toBeUndefined();
  });
});

describe("preparing a commit", () => {
  it("freezes the working tree and reports the change against the checkout base", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    fs.writeFileSync(path.join(repoDir, "NEW.md"), "new\n");

    const receipt = await prepareRepoCommit(prepare());

    expect(receipt.status).toBe("prepared");
    expect(receipt.base_sha).toBe(base);
    expect(receipt.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(receipt.commit_sha).not.toBe(base);
    expect(receipt.changed_file_count).toBe(2);
    expect(receipt.changed_files).toEqual(
      expect.arrayContaining([
        { path: "README.md", change: "modified" },
        { path: "NEW.md", change: "added" },
      ]),
    );
    expect(git(repoDir, "status", "--porcelain").trim()).toBe("");
  });

  it("attributes the commit to the agent, never to the connected user", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    await prepareRepoCommit(prepare());
    expect(git(repoDir, "log", "-1", "--format=%ae").trim()).toBe(COMMIT_AUTHOR_EMAIL);
    expect(git(repoDir, "log", "-1", "--format=%ce").trim()).toBe(COMMIT_AUTHOR_EMAIL);
  });

  it("refuses when the agent has not changed anything", async () => {
    bareUpstreamAndCheckout();
    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("nothing to commit"),
    });
  });

  it("repeats as already_prepared instead of creating an empty second commit", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const first = await prepareRepoCommit(prepare());

    const again = await prepareRepoCommit(prepare());

    expect(again.status).toBe("already_prepared");
    expect(again.commit_sha).toBe(first.commit_sha);
    expect(again.changed_file_count).toBe(1);
    expect(git(repoDir, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("never commits what the repository's own .gitignore excludes", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\n");
    fs.writeFileSync(path.join(repoDir, ".env"), "SECRET=1\n");

    const receipt = await prepareRepoCommit(prepare());

    expect(receipt.changed_files.map((entry) => entry.path)).toEqual([".gitignore"]);
  });

  it("stacks a second commit and still reports the whole change set", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "one.md"), "1\n");
    await prepareRepoCommit(prepare({ message: "first pass" }));
    fs.writeFileSync(path.join(repoDir, "two.md"), "2\n");

    const receipt = await prepareRepoCommit(prepare({ message: "second pass" }));

    expect(receipt.base_sha).toBe(base);
    expect(receipt.changed_file_count).toBe(2);
  });

  it("refuses to prepare a repository that is not checked out", async () => {
    const root = scratch("magister-repos-");
    process.env.MAGISTER_REPO_ROOT = root;
    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("manifest paths address real files", () => {
  it("keeps a non-ASCII path verbatim, sizes it, and widens its read bits", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const name = "docs/café — ⚙.md";
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, name), "hello\n");
    fs.chmodSync(path.join(repoDir, "docs"), 0o750);
    fs.chmodSync(path.join(repoDir, name), 0o640);

    const receipt = await prepareRepoCommit(prepare());

    // git's default --name-status would have reported this as
    // `"docs/caf\303\251 ..."`, which matches no file on disk — so the byte
    // budget would have skipped it and its permissions would never have moved.
    expect(receipt.changed_files).toEqual([{ path: name, change: "added" }]);
    expect(receipt.byte_size).toBe(6);
    expect(fs.statSync(path.join(repoDir, name)).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(repoDir, "docs")).mode & 0o777).toBe(0o755);
  });

  it("widens every directory it created, not only the file inside them", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.mkdirSync(path.join(repoDir, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "deep", "index.ts"), "export {};\n");
    fs.chmodSync(path.join(repoDir, "src", "deep", "index.ts"), 0o640);
    fs.chmodSync(path.join(repoDir, "src", "deep"), 0o750);
    fs.chmodSync(path.join(repoDir, "src"), 0o750);

    await prepareRepoCommit(prepare());

    // A 0750 folder is untraversable for the sandbox user, so a correctly
    // permissioned file inside one is still unreachable.
    expect(fs.statSync(path.join(repoDir, "src")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(repoDir, "src", "deep")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(repoDir, "src", "deep", "index.ts")).mode & 0o777).toBe(0o644);
  });

  it("shortens a long path in the receipt only, keeping the file name", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const segment = "d".repeat(60);
    const relative = path.join(segment, segment, segment, segment, "config.json");
    expect(relative.length).toBeGreaterThan(MAX_MANIFEST_PATH_CHARS);
    fs.mkdirSync(path.dirname(path.join(repoDir, relative)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, relative), "{}\n");
    fs.chmodSync(path.join(repoDir, relative), 0o600);

    const receipt = await prepareRepoCommit(prepare());

    const entry = receipt.changed_files[0];
    expect(entry?.path).toHaveLength(MAX_MANIFEST_PATH_CHARS);
    expect(entry?.path.startsWith("…")).toBe(true);
    expect(entry?.path.endsWith("config.json")).toBe(true);
    // Cosmetic only: the whole path was still measured and widened.
    expect(receipt.byte_size).toBe(3);
    expect(fs.statSync(path.join(repoDir, relative)).mode & 0o777).toBe(0o644);
  });
});

describe("refreshing a checkout that holds frozen work", () => {
  it("refuses, because a prepared commit leaves the tree clean", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const prepared = await prepareRepoCommit(prepare());

    await expect(checkoutRepository(request())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("never pushed"),
    });
    expect(git(repoDir, "rev-parse", "HEAD").trim()).toBe(prepared.commit_sha);
  });

  it("discards it only on an explicit request, and resets the base", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    const base = git(repoDir, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    const prepared = await prepareRepoCommit(prepare());

    await checkoutRepository(request({ discard_local_changes: true }));

    expect(git(repoDir, "rev-parse", "HEAD").trim()).toBe(base);
    await expect(pushRepoBranch(push({ commit_sha: prepared.commit_sha }))).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("pushing a branch", () => {
  async function prepared(): Promise<{
    origin: string;
    seed: string;
    repoDir: string;
    sha: string;
  }> {
    const context = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(context.repoDir, "README.md"), "edited\n");
    const receipt = await prepareRepoCommit(prepare());
    return { ...context, sha: receipt.commit_sha };
  }

  it("creates the branch and verifies it by reading the remote back", async () => {
    const { origin, sha } = await prepared();

    const receipt = await pushRepoBranch(push({ commit_sha: sha }));

    expect(receipt.status).toBe("pushed");
    expect(receipt.verified_sha).toBe(sha);
    expect(receipt.previous_remote_sha).toBeNull();
    expect(receipt.default_branch).toBe("main");
    expect(receipt.pull_request_url).toContain("compare/main...magister/readme");
    expect(remoteTip(origin, "magister/readme")).toBe(sha);
  });

  it("reports already_pushed when the branch is already at that commit", async () => {
    const { sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));

    // The retry after a lost response must not trip the "branch exists" rule
    // that its own successful push created.
    const receipt = await pushRepoBranch(push({ commit_sha: sha }));

    expect(receipt.status).toBe("already_pushed");
    expect(receipt.verified_sha).toBe(sha);
  });

  it("refuses the default branch", async () => {
    const { sha } = await prepared();
    await expect(pushRepoBranch(push({ branch: "main", commit_sha: sha }))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("default branch"),
    });
  });

  it("refuses a branch this checkout did not create", async () => {
    const { origin, sha } = await prepared();
    git(origin, "branch", "human-work", "main");

    await expect(
      pushRepoBranch(push({ branch: "human-work", commit_sha: sha })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not created by this checkout"),
    });
    expect(remoteTip(origin, "human-work")).not.toBe(sha);
  });

  it("refuses an expected SHA for a branch that does not exist yet", async () => {
    const { sha } = await prepared();
    await expect(
      pushRepoBranch(push({ commit_sha: sha, expected_remote_sha: "b".repeat(40) })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("compares and swaps when updating a branch it already owns", async () => {
    const { origin, repoDir, sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));
    fs.writeFileSync(path.join(repoDir, "SECOND.md"), "second\n");
    const next = await prepareRepoCommit(prepare({ message: "second pass" }));

    await expect(
      pushRepoBranch(push({ commit_sha: next.commit_sha, expected_remote_sha: "c".repeat(40) })),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("has moved") });

    const receipt = await pushRepoBranch(
      push({ commit_sha: next.commit_sha, expected_remote_sha: sha }),
    );
    expect(receipt.status).toBe("pushed");
    expect(remoteTip(origin, "magister/readme")).toBe(next.commit_sha);
  });

  it("cannot overwrite work that landed on its own branch, because it never forces", async () => {
    const { origin, seed, repoDir, sha } = await prepared();
    await pushRepoBranch(push({ commit_sha: sha }));
    // Someone else advances the branch to an unrelated commit.
    fs.writeFileSync(path.join(seed, "THEIRS.md"), "theirs\n");
    git(seed, "add", "THEIRS.md");
    git(seed, "commit", "--quiet", "-m", "theirs");
    git(seed, "push", "--quiet", "--force", `file://${origin}`, "main:magister/readme");
    const theirs = remoteTip(origin, "magister/readme");

    fs.writeFileSync(path.join(repoDir, "OURS.md"), "ours\n");
    const next = await prepareRepoCommit(prepare({ message: "ours" }));

    await expect(
      pushRepoBranch(push({ commit_sha: next.commit_sha, expected_remote_sha: theirs ?? "" })),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(remoteTip(origin, "magister/readme")).toBe(theirs);
  });

  it("refuses a commit that was never frozen here", async () => {
    await prepared();
    await expect(pushRepoBranch(push({ commit_sha: "d".repeat(40) }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("not prepared"),
    });
  });
});

describe("prepare with an unusable base", () => {
  it("refuses rather than reporting a commit as having changed nothing", async () => {
    const { repoDir } = bareUpstreamAndCheckout();
    fs.writeFileSync(path.join(repoDir, "README.md"), "edited\n");
    // A marker whose base is not a commit: every `base..sha` diff would come
    // back empty and the receipt would claim an empty change set.
    fs.writeFileSync(
      path.join(repoDir, ".git", "magister-checkout.json"),
      JSON.stringify({ last_used_at: new Date().toISOString(), repo: "acme/site", base_sha: "" }),
    );

    await expect(prepareRepoCommit(prepare())).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("base commit"),
    });
  });
});
