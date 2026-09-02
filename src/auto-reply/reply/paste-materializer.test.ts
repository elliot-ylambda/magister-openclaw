import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_PASTE_MIN_CHARS,
  DEFAULT_TABULAR_MIN_CHARS,
  detectInlinePastes,
  looksTabular,
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

/** The shape of the benchmark's `campaigns.csv`: wide rows, a text column, weekly grain. */
function campaignRows(rows: number): string {
  const lines = [
    "campaign,objective,week_start,spend_usd,impressions,clicks,conversions,revenue_usd,frequency,notes",
  ];
  for (let i = 0; i < rows; i += 1) {
    lines.push(
      `Prospecting - Broad ${i},conversions,2026-07-${String((i % 28) + 1).padStart(2, "0")},1200,200000,3600,60,4080,2.0,"week ${i} of the always-on prospecting flight"`,
    );
  }
  return lines.join("\n");
}

function tsvRows(rows: number): string {
  return csvRows(rows).replace(/,/g, "\t");
}

function markdownTable(rows: number): string {
  const lines = ["| campaign | spend_usd | clicks | conversions |", "|---|---|---|---|"];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`| Prospecting - Broad ${i} | ${(100 + i).toFixed(2)} | ${20 + i} | ${i % 5} |`);
  }
  return lines.join("\n");
}

/** One sentence per line with the comma counts real prose has: none, one, several. */
function prose(minChars: number): string {
  const sentences = [
    "The quarter opened slowly, with brand search flat and prospecting spend drifting upward.",
    "Retargeting held its CPA through the whole period.",
    "By week three, creative fatigue showed up in frequency, click-through, and cost per click alike, which is the usual order.",
    "We paused two ad sets and moved the budget into the broad audience.",
    "The founder asked for a plan, a budget, and a bounded test, in that order.",
  ];
  const lines: string[] = [];
  let length = 0;
  for (let i = 0; length < minChars; i += 1) {
    const line = sentences[i % sentences.length] ?? "";
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

/** A 1,500-character single-line JSON document: never tabular, so it only ever earns a file by size. */
const jsonPayload = JSON.stringify({
  rows: Array.from({ length: 120 }, (_, i) => ({ i, v: i * 2 })),
});

describe("looksTabular", () => {
  it("needs six rows and 400 characters before shape earns a file", () => {
    const fiveWideLines = campaignRows(4);
    expect(fiveWideLines.split("\n")).toHaveLength(5);
    expect(fiveWideLines.length).toBeGreaterThan(DEFAULT_TABULAR_MIN_CHARS);
    expect(looksTabular(fiveWideLines)).toBeNull();

    const sixShortLines = csvRows(5);
    expect(sixShortLines.split("\n")).toHaveLength(6);
    expect(sixShortLines.length).toBeLessThan(DEFAULT_TABULAR_MIN_CHARS);
    expect(looksTabular(sixShortLines)).toBeNull();

    expect(looksTabular(campaignRows(5))).toEqual({ delimiter: ",", ext: "csv" });
  });

  it("maps the delimiter the rows agree on to an extension", () => {
    expect(looksTabular(tsvRows(10))).toEqual({ delimiter: "\t", ext: "tsv" });
    expect(looksTabular(markdownTable(10))).toEqual({ delimiter: "|", ext: "md" });
    const pipes = csvRows(10).replace(/,/g, "|");
    expect(looksTabular(pipes)).toEqual({ delimiter: "|", ext: "txt" });
  });

  it("tolerates a minority of rows with quoted commas and rejects a block that mostly disagrees", () => {
    const rows = csvRows(9).split("\n");
    const quoteComma = (row: string) => row.replace("brand-search", '"brand, search"');
    const oneOff = rows.map((row, index) => (index === 3 ? quoteComma(row) : row));
    expect(looksTabular(oneOff.join("\n"))).toEqual({ delimiter: ",", ext: "csv" });

    const fourOff = rows.map((row, index) =>
      [2, 4, 6, 8].includes(index) ? quoteComma(row) : row,
    );
    expect(looksTabular(fourOff.join("\n"))).toBeNull();
  });

  it("reads uniformly comma-punctuated prose as prose", () => {
    const listy = Array.from(
      { length: 30 },
      (_, i) => `Point ${i}: first, second, third, and so on.`,
    ).join("\n");
    expect(listy.length).toBeGreaterThan(DEFAULT_TABULAR_MIN_CHARS);
    expect(looksTabular(listy)).toBeNull();
    expect(looksTabular(prose(3800))).toBeNull();
  });
});

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

  it("names a bare-fenced table by its delimiter instead of txt", () => {
    expect(detectInlinePastes(`\`\`\`\n${csvRows(120)}\n\`\`\``)[0]?.ext).toBe("csv");
    expect(detectInlinePastes(`\`\`\`\n${tsvRows(10)}\n\`\`\``)[0]?.ext).toBe("tsv");
    expect(detectInlinePastes(`\`\`\`\n${markdownTable(10)}\n\`\`\``)[0]?.ext).toBe("md");
    // An explicit language still wins over the shape.
    expect(detectInlinePastes(`\`\`\`text\n${csvRows(120)}\n\`\`\``)[0]?.ext).toBe("txt");
  });

  it("materializes a 17-row CSV under the size cutoff, as the benchmark supplies it", () => {
    const csv = campaignRows(16);
    expect(csv.split("\n")).toHaveLength(17);
    expect(csv.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    const body = `You are analyzing four weeks of Meta campaign data.\n\n## Supplied source: campaigns.csv\n\n${csv}\n\nProduce the analysis.`;
    const pastes = detectInlinePastes(body);
    expect(pastes).toHaveLength(1);
    expect(pastes[0]).toMatchObject({ kind: "delimited", ext: "csv", name: "campaigns.csv" });
    expect(pastes[0]?.text).toBe(csv);
  });

  it("materializes a 3,800-character table but not 3,800 characters of prose", () => {
    const csv = csvRows(75);
    expect(csv.length).toBeGreaterThan(3700);
    expect(csv.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    expect(detectInlinePastes(csv)).toHaveLength(1);
    expect(detectInlinePastes(`\`\`\`\n${csv}\n\`\`\``)).toHaveLength(1);

    const text = prose(3800);
    expect(text.length).toBeGreaterThan(3700);
    expect(text.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    expect(detectInlinePastes(text)).toEqual([]);
    expect(detectInlinePastes(`\`\`\`\n${text}\n\`\`\``)).toEqual([]);
  });

  it("materializes an unfenced markdown table", () => {
    const table = markdownTable(10);
    const body = `Here are the numbers:\n\n${table}\n\nWhat stands out?`;
    const pastes = detectInlinePastes(body);
    expect(pastes).toHaveLength(1);
    expect(pastes[0]).toMatchObject({ kind: "delimited", ext: "md" });
    expect(pastes[0]?.text).toBe(table);
  });

  it("ignores prose with commas, tables under six rows, and small fenced blocks", () => {
    const listy = Array.from(
      { length: 30 },
      (_, i) => `Point ${i}: first, second, third, and so on.`,
    ).join("\n");
    const threeWideLines = campaignRows(2);
    expect(threeWideLines.split("\n")).toHaveLength(3);
    expect(threeWideLines.length).toBeGreaterThan(300);
    const body = `${listy}\n\n${threeWideLines}\n\n${csvRows(3)}\n\n\`\`\`csv\na,b,c\n1,2,3\n\`\`\``;
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

  it("honors the size threshold for a non-tabular paste and exempts a table from it", () => {
    const fenced = `\`\`\`json\n${jsonPayload}\n\`\`\``;
    expect(jsonPayload.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    expect(detectInlinePastes(fenced)).toEqual([]);
    expect(detectInlinePastes(fenced, { minChars: 500 })).toHaveLength(1);
    expect(detectInlinePastes(fenced, { minChars: 50_000 })).toEqual([]);
    expect(detectInlinePastes(csvRows(25), { minChars: 50_000 })).toHaveLength(1);
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

  it("writes a small table under the size cutoff", async () => {
    const body = `## Supplied source: campaigns.csv\n\n${campaignRows(16)}\n`;
    const written = await materializeInlinePastes({ body, workspaceDir, runId: "abc" });
    expect(written.map((paste) => paste.path)).toEqual(["inbox/campaigns-abc.csv"]);
    expect(written[0]?.lines).toBe(17);
    await expect(
      fs.readFile(path.join(workspaceDir, "inbox/campaigns-abc.csv"), "utf8"),
    ).resolves.toBe(`${campaignRows(16)}\n`);
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

  it("leaves the file and directory readable by the sandbox user", async () => {
    // The agent's shell runs as a different uid than the host process that
    // writes the file, but with the host's gid. 0600 under the host umask is
    // what shipped first; the agent got "Permission denied" and burned 23
    // execs working around it. The exact mode depends on the umask the test
    // runs under (0640/0750 on machines, 0644/0755 on a 022 dev box), so the
    // assertion is on the group bits the sandbox needs.
    const pastes = await materializeInlinePastesForTurn({
      cfg: {} as OpenClawConfig,
      body,
      workspaceDir,
      runId: "chatcmpl_4b5ae6dc-eb98-42fa-97de-9bc5dbc5626b",
    });
    const file = await fs.stat(path.join(workspaceDir, pastes[0].path));
    const dir = await fs.stat(path.join(workspaceDir, "inbox"));
    expect(file.mode & 0o040, "inbox file is not group-readable").not.toBe(0);
    expect(dir.mode & 0o010, "inbox directory is not group-traversable").not.toBe(0);
  });

  it("writes nothing when the config disables it", async () => {
    const cfg = {
      agents: { defaults: { pasteMaterialization: { enabled: false } } },
    } as OpenClawConfig;
    await expect(materializeInlinePastesForTurn({ cfg, body, workspaceDir })).resolves.toEqual([]);
    await expect(fs.access(path.join(workspaceDir, "inbox"))).rejects.toThrow();
  });

  it("takes the size threshold from the config", async () => {
    const small = `## Supplied source: tiny.json\n\n\`\`\`json\n${jsonPayload}\n\`\`\``;
    expect(small.length).toBeLessThan(DEFAULT_PASTE_MIN_CHARS);
    await expect(
      materializeInlinePastesForTurn({ cfg: {} as OpenClawConfig, body: small, workspaceDir }),
    ).resolves.toEqual([]);
    const cfg = {
      agents: { defaults: { pasteMaterialization: { minChars: 500 } } },
    } as OpenClawConfig;
    const pastes = await materializeInlinePastesForTurn({ cfg, body: small, workspaceDir });
    expect(pastes.map((paste) => paste.name)).toEqual(["tiny.json"]);
  });
});
