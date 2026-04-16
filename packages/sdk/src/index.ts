import type { ExecuteRoutineOptions } from "@open-routines/runtime";
import {
  executeRoutine,
  executeRoutineByName as executeRoutineByNameRuntime,
} from "@open-routines/runtime";
import { loadRoutineFile } from "@open-routines/spec";
import { RoutineStore } from "@open-routines/store";

export async function loadRoutine(filePath: string) {
  return loadRoutineFile(filePath);
}

export async function validateRoutine(filePath: string) {
  return loadRoutineFile(filePath);
}

export async function scheduleRoutine(filePath: string, homeDir?: string) {
  const store = new RoutineStore(homeDir);
  try {
    await store.initialize();
    const loaded = await loadRoutineFile(filePath);
    return await store.upsertRoutine(loaded);
  } finally {
    store.close();
  }
}

export async function executeRoutineFile(
  filePath: string,
  homeDir?: string,
  options: ExecuteRoutineOptions = {},
) {
  const store = new RoutineStore(homeDir);
  try {
    await store.initialize();
    const loaded = await loadRoutineFile(filePath);
    const routine = await store.upsertRoutine(loaded);
    return await executeRoutine(routine, {
      ...options,
      store,
    });
  } finally {
    store.close();
  }
}

export async function executeRoutineByName(
  routineName: string,
  homeDir?: string,
  options: ExecuteRoutineOptions = {},
) {
  const store = new RoutineStore(homeDir);
  try {
    await store.initialize();
    return await executeRoutineByNameRuntime(routineName, {
      ...options,
      store,
    });
  } finally {
    store.close();
  }
}

export async function listRuns(homeDir?: string) {
  const store = new RoutineStore(homeDir);
  try {
    return store.listRuns();
  } finally {
    store.close();
  }
}
