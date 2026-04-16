import { rm } from "node:fs/promises";

import type { SecretStore } from "@open-routines/auth";
import { createSecretStore } from "@open-routines/auth";
import type {
  DaemonStatus,
  RoutinePaths,
  StoredRoutine,
} from "@open-routines/core";
import { DEFAULT_POLL_INTERVAL_MS, isoNow, sleep } from "@open-routines/core";
import { getSubsequentRunAt } from "@open-routines/spec";
import { RoutineStore } from "@open-routines/store";
import { executeRoutine } from "@open-routines/runtime";

export interface StartDaemonOptions {
  homeDir?: string;
  pollIntervalMs?: number;
  once?: boolean;
  force?: boolean;
}

export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<void> {
  const store = new RoutineStore(options.homeDir);
  await store.initialize();
  const secretStore = await createSecretStore(store.paths);
  const status = await store.getDaemonStatus();
  if (status.running && !options.force) {
    throw new Error(
      `A daemon is already running with pid ${status.pid}. Use --force to replace it.`,
    );
  }

  await store.writePid(process.pid);

  const activeRuns = new Set<string>();
  let shuttingDown = false;

  const cleanup = async () => {
    shuttingDown = true;
    await Promise.all([
      rm(store.paths.daemonPidPath, { force: true }),
      rm(store.paths.daemonHeartbeatPath, { force: true }),
    ]);
    store.close();
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  try {
    do {
      await tickDaemon(store, secretStore, activeRuns);
      if (options.once) {
        break;
      }
      await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    } while (!shuttingDown);
  } finally {
    await cleanup();
  }
}

export async function getDaemonStatus(homeDir?: string): Promise<DaemonStatus> {
  const store = new RoutineStore(homeDir);
  try {
    return await store.getDaemonStatus();
  } finally {
    store.close();
  }
}

export async function stopDaemon(homeDir?: string): Promise<void> {
  const store = new RoutineStore(homeDir);
  try {
    const status = await store.getDaemonStatus();
    if (!status.pid || !status.running) {
      return;
    }
    process.kill(status.pid, "SIGTERM");
  } finally {
    store.close();
  }
}

async function tickDaemon(
  store: RoutineStore,
  secretStore: SecretStore,
  activeRuns: Set<string>,
): Promise<void> {
  await store.updateHeartbeat();
  const dueRoutines = store.listDueRoutines(isoNow());

  for (const routine of dueRoutines) {
    if (activeRuns.has(routine.id)) {
      continue;
    }

    activeRuns.add(routine.id);
    const nextRunAt = getSubsequentRunAt(routine.document, routine.nextRunAt);
    store.updateRoutineSchedule(routine.id, nextRunAt, isoNow());

    void executeRoutine(routine, {
      store,
      secretStore,
      triggerType: "schedule",
    }).finally(() => {
      activeRuns.delete(routine.id);
    });
  }
}
