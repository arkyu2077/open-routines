import test from "node:test";
import assert from "node:assert/strict";

import {
  getNextRunAt,
  parseRoutineYaml,
  validateRoutineDocument,
} from "./index.js";

test("parseRoutineYaml validates and normalizes defaults", () => {
  const loaded = parseRoutineYaml(
    `
version: 1
name: morning-brief
trigger:
  type: schedule
  cron: "0 9 * * *"
provider:
  type: gpt
  model: gpt-5
execution:
  type: command
  command: "node brief.js"
`,
    "/tmp/morning.yaml",
  );

  assert.equal(loaded.document.policy?.retry?.maxAttempts, 1);
  assert.equal(loaded.document.policy?.timeoutSeconds, 3600);
  assert.equal(loaded.sourcePath, "/tmp/morning.yaml");
  assert.ok(loaded.nextRunAt);
});

test("validateRoutineDocument rejects invalid cron", () => {
  assert.throws(() =>
    validateRoutineDocument({
      version: 1,
      name: "bad-routine",
      trigger: {
        type: "schedule",
        cron: "not a cron",
      },
      provider: {
        type: "gpt",
        model: "gpt-5",
      },
      execution: {
        type: "command",
        command: "echo hi",
      },
    }),
  );
});

test("getNextRunAt returns a future timestamp", () => {
  const next = getNextRunAt(
    validateRoutineDocument({
      version: 1,
      name: "future-routine",
      trigger: {
        type: "schedule",
        cron: "*/5 * * * *",
      },
      provider: {
        type: "claude",
        model: "claude-sonnet-4-5",
      },
      execution: {
        type: "command",
        command: "echo future",
      },
    }),
    new Date("2026-04-15T00:00:00.000Z"),
  );

  assert.equal(next, "2026-04-15T00:05:00.000Z");
});

test("validateRoutineDocument allows custom provider ids", () => {
  const routine = validateRoutineDocument({
    version: 1,
    name: "custom-provider-routine",
    trigger: {
      type: "schedule",
      cron: "0 * * * *",
    },
    provider: {
      type: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
    execution: {
      type: "command",
      command: "echo custom",
    },
  });

  assert.equal(routine.provider.type, "openrouter");
});
