import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CloudLinkRecord,
  DaemonStatus,
  LoadedRoutine,
  ProviderConnectionRecord,
  RoutinePaths,
  RunRecord,
  StoredRoutine,
} from "@open-routines/core";
import {
  DEFAULT_HOME_DIRNAME,
  createId,
  isoNow,
} from "@open-routines/core";
import {
  getNextRunAt,
  parseStoredRoutineDocument,
  stringifyRoutineDocument,
} from "@open-routines/spec";

interface PutConnectionInput {
  provider: ProviderConnectionRecord["provider"];
  label: string;
  authStrategy: ProviderConnectionRecord["authStrategy"];
  metadata?: Record<string, unknown>;
  secretRef: string;
}

interface CreateRunInput {
  routine: StoredRoutine;
  triggerType: RunRecord["triggerType"];
  scheduledAt?: string | null;
  logPath?: string | null;
}

interface UpdateRunInput {
  status?: RunRecord["status"];
  startedAt?: string | null;
  endedAt?: string | null;
  exitCode?: number | null;
  summary?: string | null;
  errorMessage?: string | null;
}

export class RoutineStore {
  readonly paths: RoutinePaths;
  private readonly database: DatabaseSync;

  constructor(homeDir = getDefaultHomeDir()) {
    this.paths = buildRoutinePaths(homeDir);
    mkdirSync(dirname(this.paths.dbPath), { recursive: true });
    this.database = new DatabaseSync(this.paths.dbPath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.initializeSchema();
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.homeDir, { recursive: true }),
      mkdir(this.paths.routinesDir, { recursive: true }),
      mkdir(this.paths.logsDir, { recursive: true }),
      mkdir(this.paths.artifactsDir, { recursive: true }),
      mkdir(this.paths.stateDir, { recursive: true }),
    ]);
  }

  close(): void {
    this.database.close();
  }

  async upsertRoutine(loaded: LoadedRoutine): Promise<StoredRoutine> {
    await this.initialize();
    const managedPath = join(this.paths.routinesDir, `${loaded.document.name}.yaml`);
    await copyFile(loaded.sourcePath, managedPath);

    const now = isoNow();
    const existing = this.database
      .prepare("SELECT id, created_at FROM routines WHERE name = ?")
      .get(loaded.document.name) as { id: string; created_at: string } | undefined;
    const id = existing?.id ?? createId("routine");
    const createdAt = existing?.created_at ?? now;

    this.database
      .prepare(
        `
        INSERT INTO routines (
          id, name, source_path, managed_path, checksum, enabled, document_json,
          next_run_at, last_run_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          source_path = excluded.source_path,
          managed_path = excluded.managed_path,
          checksum = excluded.checksum,
          enabled = 1,
          document_json = excluded.document_json,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        id,
        loaded.document.name,
        loaded.sourcePath,
        managedPath,
        loaded.checksum,
        stringifyRoutineDocument(loaded.document),
        loaded.nextRunAt,
        createdAt,
        now,
      );

    return this.getRoutineByName(loaded.document.name);
  }

  listRoutines(): StoredRoutine[] {
    const rows = this.database
      .prepare(
        `
        SELECT id, name, source_path, managed_path, checksum, enabled, document_json,
               next_run_at, last_run_at, created_at, updated_at
        FROM routines
        ORDER BY name ASC
        `,
      )
      .all() as unknown as RoutineRow[];

    return rows.map(mapRoutineRow);
  }

  listDueRoutines(currentTime = isoNow()): StoredRoutine[] {
    const rows = this.database
      .prepare(
        `
        SELECT id, name, source_path, managed_path, checksum, enabled, document_json,
               next_run_at, last_run_at, created_at, updated_at
        FROM routines
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC
        `,
      )
      .all(currentTime) as unknown as RoutineRow[];

    return rows.map(mapRoutineRow);
  }

  getRoutineByName(name: string): StoredRoutine {
    const row = this.database
      .prepare(
        `
        SELECT id, name, source_path, managed_path, checksum, enabled, document_json,
               next_run_at, last_run_at, created_at, updated_at
        FROM routines
        WHERE name = ?
        `,
      )
      .get(name) as RoutineRow | undefined;

    if (!row) {
      throw new Error(`Routine "${name}" was not found.`);
    }

    return mapRoutineRow(row);
  }

  disableRoutine(name: string): StoredRoutine {
    const now = isoNow();
    this.database
      .prepare(
        `UPDATE routines SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE name = ?`,
      )
      .run(now, name);

    return this.getRoutineByName(name);
  }

  updateRoutineSchedule(
    routineId: string,
    nextRunAt: string | null,
    lastRunAt: string | null,
  ): void {
    this.database
      .prepare(
        `
        UPDATE routines
        SET next_run_at = ?, last_run_at = ?, updated_at = ?
        WHERE id = ?
        `,
      )
      .run(nextRunAt, lastRunAt, isoNow(), routineId);
  }

  createRun(input: CreateRunInput): RunRecord {
    const now = isoNow();
    const id = createId("run");

    this.database
      .prepare(
        `
        INSERT INTO runs (
          id, routine_id, routine_name, trigger_type, provider, model, executor_type,
          status, scheduled_at, started_at, ended_at, exit_code, summary, log_path,
          error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'local', 'queued', ?, NULL, NULL, NULL, NULL, ?, NULL, ?)
        `,
      )
      .run(
        id,
        input.routine.id,
        input.routine.name,
        input.triggerType,
        input.routine.document.provider.type,
        input.routine.document.provider.model,
        input.scheduledAt ?? null,
        input.logPath ?? null,
        now,
      );

    return this.getRun(id);
  }

  updateRun(runId: string, update: UpdateRunInput): RunRecord {
    const current = this.getRun(runId);
    this.database
      .prepare(
        `
        UPDATE runs SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          exit_code = ?,
          summary = ?,
          error_message = ?
        WHERE id = ?
        `,
      )
      .run(
        update.status ?? current.status,
        update.startedAt ?? current.startedAt,
        update.endedAt ?? current.endedAt,
        update.exitCode ?? current.exitCode,
        update.summary ?? current.summary,
        update.errorMessage ?? current.errorMessage,
        runId,
      );

    return this.getRun(runId);
  }

  getRun(runId: string): RunRecord {
    const row = this.database
      .prepare(
        `
        SELECT id, routine_id, routine_name, trigger_type, provider, model, executor_type,
               status, scheduled_at, started_at, ended_at, exit_code, summary,
               log_path, error_message, created_at
        FROM runs
        WHERE id = ?
        `,
      )
      .get(runId) as RunRow | undefined;

    if (!row) {
      throw new Error(`Run "${runId}" was not found.`);
    }

    return mapRunRow(row);
  }

  listRuns(limit = 50): RunRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT id, routine_id, routine_name, trigger_type, provider, model, executor_type,
               status, scheduled_at, started_at, ended_at, exit_code, summary,
               log_path, error_message, created_at
        FROM runs
        ORDER BY created_at DESC
        LIMIT ?
        `,
      )
      .all(limit) as unknown as RunRow[];

    return rows.map(mapRunRow);
  }

  async readRunLogs(runId: string): Promise<string> {
    const run = this.getRun(runId);
    if (!run.logPath) {
      return "";
    }
    return readFile(run.logPath, "utf8");
  }

  putProviderConnection(input: PutConnectionInput): ProviderConnectionRecord {
    const now = isoNow();
    const existing = this.database
      .prepare(
        `
        SELECT id, created_at
        FROM provider_connections
        WHERE provider = ? AND label = ?
        `,
      )
      .get(input.provider, input.label) as
      | { id: string; created_at: string }
      | undefined;

    const id = existing?.id ?? createId("conn");
    const createdAt = existing?.created_at ?? now;

    this.database
      .prepare(
        `
        INSERT INTO provider_connections (
          id, provider, label, auth_strategy, metadata_json, secret_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, label) DO UPDATE SET
          auth_strategy = excluded.auth_strategy,
          metadata_json = excluded.metadata_json,
          secret_ref = excluded.secret_ref,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        id,
        input.provider,
        input.label,
        input.authStrategy,
        JSON.stringify(input.metadata ?? {}),
        input.secretRef,
        createdAt,
        now,
      );

    return this.findProviderConnection(input.provider, input.label)!;
  }

  listProviderConnections(
    provider?: ProviderConnectionRecord["provider"],
  ): ProviderConnectionRecord[] {
    const rows = (
      provider
        ? this.database
            .prepare(
              `
              SELECT id, provider, label, auth_strategy, metadata_json, secret_ref, created_at, updated_at
              FROM provider_connections
              WHERE provider = ?
              ORDER BY provider, label
              `,
            )
            .all(provider)
        : this.database
            .prepare(
              `
              SELECT id, provider, label, auth_strategy, metadata_json, secret_ref, created_at, updated_at
              FROM provider_connections
              ORDER BY provider, label
              `,
            )
            .all()
    ) as unknown as ProviderConnectionRow[];

    return rows.map(mapProviderConnectionRow);
  }

  findProviderConnection(
    provider: ProviderConnectionRecord["provider"],
    label?: string,
  ): ProviderConnectionRecord | null {
    const row = (
      label
        ? this.database
            .prepare(
              `
              SELECT id, provider, label, auth_strategy, metadata_json, secret_ref, created_at, updated_at
              FROM provider_connections
              WHERE provider = ? AND label = ?
              `,
            )
            .get(provider, label)
        : this.database
            .prepare(
              `
              SELECT id, provider, label, auth_strategy, metadata_json, secret_ref, created_at, updated_at
              FROM provider_connections
              WHERE provider = ?
              ORDER BY created_at ASC
              LIMIT 1
              `,
            )
            .get(provider)
    ) as ProviderConnectionRow | undefined;

    return row ? mapProviderConnectionRow(row) : null;
  }

  setCloudLink(link: CloudLinkRecord): void {
    this.setState("cloud_link", JSON.stringify(link));
  }

  getCloudLink(): CloudLinkRecord | null {
    const value = this.getState("cloud_link");
    return value ? (JSON.parse(value) as CloudLinkRecord) : null;
  }

  clearCloudLink(): void {
    this.deleteState("cloud_link");
  }

  setState(key: string, value: string): void {
    this.database
      .prepare(
        `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        `,
      )
      .run(key, value, isoNow());
  }

  getState(key: string): string | null {
    const row = this.database
      .prepare("SELECT value FROM app_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteState(key: string): void {
    this.database.prepare("DELETE FROM app_state WHERE key = ?").run(key);
  }

  async writePid(pid: number): Promise<void> {
    await writeFile(this.paths.daemonPidPath, JSON.stringify({ pid }), "utf8");
  }

  async clearPid(): Promise<void> {
    await writeFile(this.paths.daemonPidPath, "", "utf8");
  }

  async updateHeartbeat(): Promise<void> {
    await writeFile(
      this.paths.daemonHeartbeatPath,
      JSON.stringify({ pid: process.pid, heartbeatAt: isoNow() }, null, 2),
      "utf8",
    );
  }

  async getDaemonStatus(): Promise<DaemonStatus> {
    let pid: number | null = null;
    let heartbeatAt: string | null = null;

    try {
      const pidPayload = JSON.parse(
        await readFile(this.paths.daemonPidPath, "utf8"),
      ) as { pid?: number };
      if (typeof pidPayload.pid === "number") {
        pid = pidPayload.pid;
      }
    } catch {
      pid = null;
    }

    try {
      const heartbeatPayload = JSON.parse(
        await readFile(this.paths.daemonHeartbeatPath, "utf8"),
      ) as { heartbeatAt?: string };
      if (typeof heartbeatPayload.heartbeatAt === "string") {
        heartbeatAt = heartbeatPayload.heartbeatAt;
      }
    } catch {
      heartbeatAt = null;
    }

    const running = pid !== null ? isProcessAlive(pid) : false;
    const stale = heartbeatAt
      ? Date.now() - new Date(heartbeatAt).getTime() > 60_000
      : false;

    return { running, pid, heartbeatAt, stale };
  }

  private initializeSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        source_path TEXT NOT NULL,
        managed_path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        routine_name TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        executor_type TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT,
        started_at TEXT,
        ended_at TEXT,
        exit_code INTEGER,
        summary TEXT,
        log_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(routine_id) REFERENCES routines(id)
      );

      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT NOT NULL,
        auth_strategy TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, label)
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
}

export function getDefaultHomeDir(): string {
  return join(homedir(), DEFAULT_HOME_DIRNAME);
}

export function buildRoutinePaths(homeDir: string): RoutinePaths {
  const resolvedHome = resolve(homeDir);
  return {
    homeDir: resolvedHome,
    dbPath: join(resolvedHome, "routines.db"),
    routinesDir: join(resolvedHome, "routines"),
    logsDir: join(resolvedHome, "logs"),
    artifactsDir: join(resolvedHome, "artifacts"),
    stateDir: join(resolvedHome, "state"),
    secretsPath: join(resolvedHome, "state", "secrets.json"),
    masterKeyPath: join(resolvedHome, "state", "master.key"),
    daemonPidPath: join(resolvedHome, "state", "daemon.pid"),
    daemonHeartbeatPath: join(resolvedHome, "state", "daemon.heartbeat.json"),
  };
}

export async function ensureWorkingDirectory(workingDir: string): Promise<string> {
  const resolvedPath = resolve(workingDir);
  await mkdir(resolvedPath, { recursive: true });
  return resolvedPath;
}

export function computeRoutineLogPath(
  paths: RoutinePaths,
  runId: string,
): string {
  return join(paths.logsDir, `${runId}.log`);
}

export function computeNextRunForRoutine(routine: StoredRoutine): string | null {
  const base = routine.nextRunAt ?? routine.lastRunAt ?? isoNow();
  return getNextRunAt(routine.document, new Date(base));
}

interface RoutineRow {
  id: string;
  name: string;
  source_path: string;
  managed_path: string;
  checksum: string;
  enabled: number;
  document_json: string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  routine_id: string;
  routine_name: string;
  trigger_type: RunRecord["triggerType"];
  provider: RunRecord["provider"];
  model: string;
  executor_type: RunRecord["executorType"];
  status: RunRecord["status"];
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
  summary: string | null;
  log_path: string | null;
  error_message: string | null;
  created_at: string;
}

interface ProviderConnectionRow {
  id: string;
  provider: ProviderConnectionRecord["provider"];
  label: string;
  auth_strategy: ProviderConnectionRecord["authStrategy"];
  metadata_json: string;
  secret_ref: string;
  created_at: string;
  updated_at: string;
}

function mapRoutineRow(row: RoutineRow): StoredRoutine {
  return {
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    managedPath: row.managed_path,
    checksum: row.checksum,
    enabled: row.enabled === 1,
    document: parseStoredRoutineDocument(row.document_json),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    routineId: row.routine_id,
    routineName: row.routine_name,
    triggerType: row.trigger_type,
    provider: row.provider,
    model: row.model,
    executorType: row.executor_type,
    status: row.status,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    summary: row.summary,
    logPath: row.log_path,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function mapProviderConnectionRow(row: ProviderConnectionRow): ProviderConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    authStrategy: row.auth_strategy,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    secretRef: row.secret_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
