import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageEntry = fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const packageRoot = path.dirname(path.dirname(packageEntry));

async function importPiDist(relativePath: string) {
  return import(pathToFileURL(path.join(packageRoot, "dist", relativePath)).href);
}

describe("Pi coding agent security backports", () => {
  it("rejects Git sources that can escape a managed install root", async () => {
    const { parseGitUrl } = await importPiDist("utils/git.js");

    expect(parseGitUrl("git:https://evil.example/%2e%2e/escape")).toBeNull();
    expect(parseGitUrl("git:https://evil.example/org/../escape")).toBeNull();
    expect(parseGitUrl("git:https://evil.example/org\\escape/repo")).toBeNull();

    expect(parseGitUrl("https://github.com/openai/codex.git#main")).toMatchObject({
      host: "github.com",
      path: "openai/codex",
      ref: "main",
      pinned: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "uses private permissions for auth and temporary extension state",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "pi-security-backport-"));

      try {
        const authPath = path.join(root, "auth", "auth.json");
        const { FileAuthStorageBackend } = await importPiDist("core/auth-storage.js");
        const backend = new FileAuthStorageBackend(authPath);
        backend.withLock(() => ({ result: undefined, next: '{"token":"secret"}' }));
        expect(statSync(authPath).mode & 0o777).toBe(0o600);

        const { DefaultPackageManager } = await importPiDist("core/package-manager.js");
        const agentDir = path.join(root, "agent");
        const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: {} });
        const extensionTemp = path.resolve(agentDir, "tmp", "extensions");
        const temporaryInstall = path.resolve(manager.getTemporaryDir("npm"));

        expect(temporaryInstall.startsWith(`${extensionTemp}${path.sep}`)).toBe(true);
        expect(statSync(extensionTemp).mode & 0o777).toBe(0o700);
        expect(() =>
          manager.getGitInstallPath({ host: "evil.example", path: "../../escape" }, "user"),
        ).toThrow(/outside package install root/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("uses a scheme allow-list for exported Markdown URLs", () => {
    const template = readFileSync(
      path.join(packageRoot, "dist", "core", "export-html", "template.js"),
      "utf8",
    );

    expect(template).toContain("function sanitizeMarkdownUrl(value)");
    expect(template).toContain("!/^(https?|mailto|tel|ftp)$/i.test(scheme[1])");
    expect(template.match(/sanitizeMarkdownUrl\(token\.href\)/g)).toHaveLength(2);
  });
});
