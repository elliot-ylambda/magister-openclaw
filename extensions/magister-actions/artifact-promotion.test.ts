import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactPromotionError, promoteArtifact } from "./artifact-promotion.js";

const roots: string[] = [];
const previousEnforcement = process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;

afterEach(() => {
  if (previousEnforcement === undefined) {
    delete process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT;
  } else {
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = previousEnforcement;
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(content = "bounded artifact") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magister-promotion-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const attempt = "attempt-1";
  const attemptRoot = path.join(workspace, ".magister", "tmp", "attempts", attempt);
  fs.mkdirSync(attemptRoot, { recursive: true });
  const staged = path.join(attemptRoot, "report.txt");
  fs.writeFileSync(staged, content);
  return {
    workspace,
    attempt,
    staged,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function request(row: ReturnType<typeof fixture>) {
  return {
    attempt_id: row.attempt,
    staged_path: "report.txt",
    destination_path: "deliverables/report.txt",
    sha256: row.sha256,
    mutation_context: {
      project_id: "project-1",
      operation_id: "operation-1",
      owner_id: "gateway-owner-1",
      project_fence: 7,
      mode: "enforce",
    },
  };
}

describe("artifact promotion", () => {
  it("atomically promotes one owned staged file under a current fence", async () => {
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    const result = await promoteArtifact(request(row), {
      workspace: row.workspace,
      agentToolUid: process.getuid?.() ?? 501,
    });
    expect(result).toMatchObject({
      status: "promoted",
      destination_path: "deliverables/report.txt",
      sha256: row.sha256,
      project_fence: 7,
    });
    expect(fs.readFileSync(path.join(row.workspace, "deliverables", "report.txt"), "utf8")).toBe(
      "bounded artifact",
    );
  });

  it("rejects missing fences and platform-managed destinations", async () => {
    const row = fixture();
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    await expect(
      promoteArtifact(
        { ...request(row), mutation_context: undefined },
        {
          workspace: row.workspace,
          agentToolUid: process.getuid?.() ?? 501,
        },
      ),
    ).rejects.toThrow("current enforced mutation fence");
    await expect(
      promoteArtifact(
        { ...request(row), destination_path: ".magister/state/escape" },
        {
          workspace: row.workspace,
          agentToolUid: process.getuid?.() ?? 501,
        },
      ),
    ).rejects.toBeInstanceOf(ArtifactPromotionError);
  });

  it("requires the expected hash before replacing a user file", async () => {
    const row = fixture("new content");
    fs.mkdirSync(path.join(row.workspace, "deliverables"));
    fs.writeFileSync(path.join(row.workspace, "deliverables", "report.txt"), "user edit");
    process.env.MAGISTER_LOCAL_MUTATION_ENFORCEMENT = "1";
    await expect(
      promoteArtifact(request(row), {
        workspace: row.workspace,
        agentToolUid: process.getuid?.() ?? 501,
      }),
    ).rejects.toThrow("replacement was not authorized");
    expect(fs.readFileSync(path.join(row.workspace, "deliverables", "report.txt"), "utf8")).toBe(
      "user edit",
    );
  });
});
