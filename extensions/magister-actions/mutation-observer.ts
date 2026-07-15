import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LocalMutationContext = {
  project_id: string;
  operation_id: string;
  owner_id?: string;
  project_fence?: number;
  account_fence?: number | null;
  mode: "observe" | "enforce";
};

export function parseLocalMutationContext(value: unknown): LocalMutationContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.project_id !== "string" ||
    !row.project_id.trim() ||
    typeof row.operation_id !== "string" ||
    !row.operation_id.trim()
  ) {
    return undefined;
  }
  const fence =
    typeof row.project_fence === "number" && Number.isSafeInteger(row.project_fence)
      ? row.project_fence
      : undefined;
  const ownerId = typeof row.owner_id === "string" ? row.owner_id.trim().slice(0, 240) : undefined;
  const mode = row.mode === "enforce" ? "enforce" : "observe";
  if (mode === "enforce" && (!ownerId || fence === undefined || fence < 1)) {
    return undefined;
  }
  return {
    project_id: row.project_id.trim().slice(0, 200),
    operation_id: row.operation_id.trim().slice(0, 240),
    ...(ownerId ? { owner_id: ownerId } : {}),
    ...(fence !== undefined ? { project_fence: fence } : {}),
    ...(typeof row.account_fence === "number" || row.account_fence === null
      ? { account_fence: row.account_fence }
      : {}),
    mode,
  };
}

export class LocalMutationObservation {
  private readonly db: DatabaseSync;
  private finished = false;
  private promotionLocked = false;

  constructor(
    workspace: string,
    readonly context: LocalMutationContext,
    readonly resource: string,
    readonly contentHash: string,
  ) {
    const directory = path.join(workspace, ".magister", "state");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dbPath = path.join(directory, "mutation-observations.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS mutation_resources (
        project_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        latest_fence INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, resource)
      );
      CREATE TABLE IF NOT EXISTS mutation_observations (
        operation_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_id TEXT,
        resource TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        project_fence INTEGER NOT NULL DEFAULT 0,
        account_fence INTEGER,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        failure_code TEXT,
        observed_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);
    fs.chmodSync(dbPath, 0o600);
    this.begin();
  }

  private begin(): void {
    const fence = Math.max(0, this.context.project_fence ?? 0);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.db
        .prepare(`
          SELECT project_id, resource, content_hash FROM mutation_observations
          WHERE operation_id = ?
        `)
        .get(this.context.operation_id) as
        | { project_id: string; resource: string; content_hash: string }
        | undefined;
      if (
        existing &&
        (existing.project_id !== this.context.project_id ||
          existing.resource !== this.resource ||
          existing.content_hash !== this.contentHash)
      ) {
        throw new Error("conflicting local mutation operation replay");
      }
      const resource = this.db
        .prepare(`
          SELECT latest_fence FROM mutation_resources WHERE project_id = ? AND resource = ?
        `)
        .get(this.context.project_id, this.resource) as { latest_fence: number } | undefined;
      if (fence > 0 && resource && fence < resource.latest_fence) {
        throw new Error("stale local mutation fence");
      }
      this.db
        .prepare(`
          INSERT INTO mutation_resources(project_id, resource, latest_fence, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(project_id, resource) DO UPDATE SET
            latest_fence = MAX(latest_fence, excluded.latest_fence),
            updated_at = excluded.updated_at
        `)
        .run(this.context.project_id, this.resource, fence, now);
      this.db
        .prepare(`
          INSERT INTO mutation_observations(
            operation_id, project_id, owner_id, resource, content_hash,
            project_fence, account_fence, mode, state, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?)
          ON CONFLICT(operation_id) DO UPDATE SET owner_id = excluded.owner_id,
            project_fence = MAX(project_fence, excluded.project_fence),
            account_fence = excluded.account_fence, mode = excluded.mode,
            state = 'staged', failure_code = NULL, observed_at = excluded.observed_at,
            finished_at = NULL
        `)
        .run(
          this.context.operation_id,
          this.context.project_id,
          this.context.owner_id ?? null,
          this.resource,
          this.contentHash,
          fence,
          this.context.account_fence ?? null,
          this.context.mode,
          now,
        );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      this.db.close();
      throw error;
    }
  }

  lockPromotion(): void {
    if (this.finished || this.promotionLocked) {
      throw new Error("local mutation observation is not promotable");
    }
    const fence = Math.max(0, this.context.project_fence ?? 0);
    if (this.context.mode === "enforce" && (!this.context.owner_id || fence < 1)) {
      throw new Error("enforced local mutation requires a current owner and fence");
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const resource = this.db
        .prepare(`
          SELECT latest_fence FROM mutation_resources WHERE project_id = ? AND resource = ?
        `)
        .get(this.context.project_id, this.resource) as { latest_fence: number } | undefined;
      if (fence > 0 && resource && fence < resource.latest_fence) {
        throw new Error("stale local mutation fence");
      }
      this.db
        .prepare(`
          UPDATE mutation_observations SET state = 'promoting', failure_code = NULL
          WHERE operation_id = ? AND project_id = ? AND resource = ? AND content_hash = ?
        `)
        .run(this.context.operation_id, this.context.project_id, this.resource, this.contentHash);
      this.promotionLocked = true;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  finish(state: "promoted" | "failed", failureCode?: string): void {
    if (this.finished) {
      return;
    }
    this.db
      .prepare(`
        UPDATE mutation_observations SET state = ?, failure_code = ?, finished_at = ?
        WHERE operation_id = ?
      `)
      .run(state, failureCode?.slice(0, 100) ?? null, Date.now(), this.context.operation_id);
    if (this.promotionLocked) {
      this.db.exec("COMMIT;");
      this.promotionLocked = false;
    }
    this.finished = true;
    this.db.close();
  }
}
