import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRoutineYaml } from "@open-routines/spec";

import { RoutineStore } from "./index.js";

test("RoutineStore can persist routines and runs", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "open-routines-store-"));
  const sourcePath = join(homeDir, "example.yaml");
  await writeFile(
    sourcePath,
    `
version: 1
name: daily-sync
trigger:
  type: schedule
  cron: "0 * * * *"
provider:
  type: gpt
  model: gpt-5
execution:
  type: command
  command: "echo sync"
`,
  );

  const store = new RoutineStore(homeDir);
  await store.initialize();
  const routine = await store.upsertRoutine(
    parseRoutineYaml(await readFile(sourcePath, "utf8"), sourcePath),
  );
  const run = store.createRun({
    routine,
    triggerType: "manual",
  });

  assert.equal(store.listRoutines().length, 1);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.getRun(run.id).routineName, "daily-sync");

  store.close();
});
