import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("skills/sherpa-onnx-tts bin script", () => {
  const scriptPath = path.resolve(
    process.cwd(),
    "skills",
    "sherpa-onnx-tts",
    "bin",
    "sherpa-onnx-tts",
  );
  const testIfBundledSkillPresent = existsSync(scriptPath) ? it : it.skip;

  testIfBundledSkillPresent(
    "loads as ESM and falls through to usage output when env is missing",
    () => {
      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Missing runtime/model directory.");
      expect(result.stderr).toContain("Usage: sherpa-onnx-tts");
      expect(result.stderr).not.toContain("require is not defined in ES module scope");
    },
  );
});
