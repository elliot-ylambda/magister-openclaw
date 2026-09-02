import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_PASTE_MIN_CHARS,
  detectInlinePastes,
  materializeInlinePastes,
  materializeInlinePastesForTurn,
  sanitizePasteName,
} from "./paste-materializer.js";

function csvRows(rows: number): string {
  const lines = ["date,campaign,adset,spend_usd,impressions,clicks,conversions"];
  for (let i = 0; i < rows; i += 1) {
    lines.push(
      `2026-03-${String((i % 28) + 1).padStart(2, "0")},brand-search,bs-exact,${(100 + i).toFixed(2)},${6000 + i},${100 + i},${i % 9}`,
    );
  }
  return lines.join("\n");
}

describe("detectInlinePastes", () => {
  it("finds an unfenced CSV under a heading and names it from the heading", () => {
    const body = `Review the quarter.\n\n## Supplied source: ads_daily.csv\n\n${csvRows(120)}\n\nWrite the review.`;
    const pastes = detectInlinePastes(body);
    expect(pastes).toHaveLength(1);
    expect(pastes[0]).toMatchObject({ kind: "delimited", ext: "csv", name: "ads_daily.csv" });
    expect(pastes[0]?.text).toBe(csvRows(120));
    expect(pastes[0]?.text.length).toBeGreaterThan(DEFAULT_PASTE_MIN_CHARS);
  });

  it("finds a fenced block and maps its language to an extension", () => {
    const payload = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ i, v: i * 2 })),
    });
    const body = `Here is the export:\n\n\`\`\`json\n${payload}\n\`\`\`\n\nSummarize it.`;
    const pastes = detectInlinePastes(body);
    expect(pastes).toHaveLength(1);
    expect(pastes[0]).toMatchObject({ kind: "fenced", ext: "json", name: undefined });
    expect(pastes[0]?.text).toBe(payload);
  });

  it("ignores prose with commas, short tables, and small fenced blocks", () => {
    const prose = Array.from(
      { length: 30 },
      (_, i) => `Point ${i}: first, second, third, and so on.`,
    ).join("\n");
    const body = `${prose}\n\n${csvRows(8)}\n\n\`\`\`csv\na,b,c\n1,2,3\n\`\`\``;
    expect(detectInlinePastes(body)).toEqual([]);
  });

  it("does not double count a delimited block that sits inside a fence", () => {
    const body = `\`\`\`csv\n${csvRows(120)}\n\`\`\``;
    const pastes = detectInlinePastes(body);
    expect(pastes).toHaveLength(1);
    expect(pastes[0]?.kind).toBe("fenced");
  });

  it("keeps the inferred name inside the inbox", () => {
    expect(sanitizePasteName("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(sanitizePasteName("C:\\exports\\Q2 report.csv")).toBe("Q2-report.csv");
    expect(sanitizePasteName("..")).toBeUndefined();
    const body = `source: ../../etc/shadow.csv\n${csvRows(120)}`;
    expect(detectInlinePastes(body)[0]?.name).toBe("shadow.csv");
  });

  it("honors a lower threshold", () => {
    expect(detectInlinePastes(csvRows(25), { minChars: 500 })).toHaveLength(1);
    expect(detectInlinePastes(csvRows(25), { minChars: 50_000 })).toEqual([]);
  });
});

describe("materializeInlinePastes", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paste-materializer-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("writes the paste into inbox/ with a run suffix and reports what it wrote", async () => {
    const body = `## Supplied source: ads_daily.csv\n\n${csvRows(120)}\n`;
    const written = await materializeInlinePastes({ body, workspaceDir, runId: "run-3f2a9c1e-77" });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      path: "inbox/ads_daily-2a9c1e77.csv",
      name: "ads_daily.csv",
      lines: 121,
    });
    const onDisk = await fs.readFile(path.join(workspaceDir, written[0]?.path ?? ""), "utf8");
    expect(onDisk).toBe(`${csvRows(120)}\n`);
    expect(written[0]?.bytes).toBe(Buffer.byteLength(onDisk));
  });

  it("dedupes two pastes that infer the same name within one message", async () => {
    const body = `file a.csv\n${csvRows(120)}\n\nfile a.csv\n${csvRows(121)}\n`;
    const written = await materializeInlinePastes({ body, workspaceDir, runId: "abc" });
    expect(written.map((p) => p.path)).toEqual(["inbox/a-abc.csv", "inbox/a-abc-2.csv"]);
  });

  it("skips a paste over the byte cap and returns nothing for an empty body", async () => {
    const body = `\`\`\`\n${csvRows(120)}\n\`\`\``;
    expect(await materializeInlinePastes({ body, workspaceDir, maxBytes: 100 })).toEqual([]);
    expect(await materializeInlinePastes({ body: "   ", workspaceDir })).toEqual([]);
    await expect(fs.readdir(workspaceDir)).resolves.toEqual([]);
  });
});

describe("materializeInlinePastesForTurn", () => {
  let workspaceDir = "";

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "paste-turn-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  const body = `## Supplied source: ads_daily.csv\n\n${csvRows(120)}`;

  it("is on by default and honors the run id", async () => {
    const pastes = await materializeInlinePastesForTurn({
      cfg: {} as OpenClawConfig,
      body,
      workspaceDir,
      runId: "chatcmpl_4b5ae6dc-eb98-42fa-97de-9bc5dbc5626b",
    });
    expect(pastes).toHaveLength(1);
    expect(pastes[0]?.path).toBe("inbox/ads_daily-dbc5626b.csv");
    await expect(fs.readFile(path.join(workspaceDir, pastes[0].path), "utf8")).resolves.toBe(
      `${csvRows(120)}\n`,
    );
  });

  it("writes nothing when the config disables it", async () => {
    const cfg = {
      agents: { defaults: { pasteMaterialization: { enabled: false } } },
    } as OpenClawConfig;
    await expect(materializeInlinePastesForTurn({ cfg, body, workspaceDir })).resolves.toEqual([]);
    await expect(fs.access(path.join(workspaceDir, "inbox"))).rejects.toThrow();
  });

  it("takes the size threshold from the config", async () => {
    const small = `## Supplied source: tiny.csv\n\n${csvRows(25)}`;
    expect(small.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    await expect(
      materializeInlinePastesForTurn({ cfg: {} as OpenClawConfig, body: small, workspaceDir }),
    ).resolves.toEqual([]);
    const cfg = {
      agents: { defaults: { pasteMaterialization: { minChars: 500 } } },
    } as OpenClawConfig;
    const pastes = await materializeInlinePastesForTurn({ cfg, body: small, workspaceDir });
    expect(pastes.map((paste) => paste.name)).toEqual(["tiny.csv"]);
  });
});
