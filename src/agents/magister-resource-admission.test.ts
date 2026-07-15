import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMagisterResourceAdmission } from "./magister-resource-admission.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function cgroup(current: number, maximum: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magister-admission-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "memory.current"), String(current));
  fs.writeFileSync(path.join(root, "memory.max"), String(maximum));
  return root;
}

describe("Magister resource admission", () => {
  it("pauses children and preprocessing at 70 percent", async () => {
    const result = await resolveMagisterResourceAdmission({
      env: { MAGISTER_RESOURCE_ADMISSION_ENABLED: "1" },
      cgroupRoot: cgroup(700, 1000),
    });
    expect(result).toMatchObject({
      allowPreprocessing: false,
      allowChild: false,
      allowTool: true,
      reason: "machine_memory_high",
    });
  });

  it("queues tools at 80 percent and fails closed without telemetry", async () => {
    const critical = await resolveMagisterResourceAdmission({
      env: { MAGISTER_RESOURCE_ADMISSION_ENABLED: "1" },
      cgroupRoot: cgroup(800, 1000),
    });
    expect(critical.allowTool).toBe(false);
    expect(critical.reason).toBe("machine_memory_critical");

    const missing = await resolveMagisterResourceAdmission({
      env: { MAGISTER_RESOURCE_ADMISSION_ENABLED: "1" },
      cgroupRoot: "/missing-magister-cgroup",
    });
    expect(missing).toMatchObject({
      allowChild: false,
      allowTool: false,
      reason: "machine_memory_telemetry_unavailable",
    });
  });
});
