import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKOUT_TTL_MS,
  CheckoutError,
  checkoutRepository,
  ensureRepoRoot,
  makeReadableByTools,
  measureTree,
  parseRef,
  parseRepo,
  parseRequest,
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

function request(overrides: Record<string, unknown> = {}) {
  return {
    repo: "acme/site",
    discard_local_changes: false,
    token: "ghu_test_token",
    ...overrides,
  } as Parameters<typeof checkoutRepository>[0];
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
