import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRoutineYaml } from "@open-routines/spec";
import { RoutineStore } from "@open-routines/store";

import { executeRoutine } from "./index.js";

test("executeRoutine runs a local command and records a successful run", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "open-routines-runtime-"));
  const sourcePath = join(homeDir, "hello.yaml");
  const outputPath = join(homeDir, "hello.txt");

  await writeFile(
    sourcePath,
    `
version: 1
name: write-hello
trigger:
  type: schedule
  cron: "0 * * * *"
provider:
  type: gpt
  model: gpt-5
execution:
  type: command
  command: "node -e \\"require('node:fs').writeFileSync('${outputPath}', 'hello')\\""
`,
  );

  const store = new RoutineStore(homeDir);
  await store.initialize();
  const routine = await store.upsertRoutine(
    parseRoutineYaml(await readFile(sourcePath, "utf8"), sourcePath),
  );

  const result = await executeRoutine(routine, { store, triggerType: "manual" });
  assert.equal(result.run.status, "succeeded");
});

test("executeRoutine injects compatibility env vars for custom providers", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "open-routines-runtime-custom-"));
  const sourcePath = join(homeDir, "custom.yaml");
  const outputPath = join(homeDir, "custom-env.txt");

  await writeFile(
    sourcePath,
    `
version: 1
name: custom-openai
trigger:
  type: schedule
  cron: "0 * * * *"
provider:
  type: openrouter
  model: openai/gpt-4.1-mini
execution:
  type: command
  command: "node -e \\"require('node:fs').writeFileSync('${outputPath}', [process.env.OPENAI_BASE_URL, process.env.OPENAI_API_KEY, process.env.OPEN_ROUTINES_PROVIDER_PROTOCOL].join('|'))\\""
  env:
    OPENAI_API_KEY: ""
`,
  );

  const store = new RoutineStore(homeDir);
  await store.initialize();
  const routine = await store.upsertRoutine(
    parseRoutineYaml(await readFile(sourcePath, "utf8"), sourcePath),
  );
  store.putProviderConnection({
    provider: "openrouter",
    label: "openrouter",
    authStrategy: "api_key",
    metadata: {
      protocol: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://routines.one",
      },
    },
    secretRef: "provider:openrouter:openrouter",
  });

  const result = await executeRoutine(routine, { store, triggerType: "manual" });
  assert.equal(result.run.status, "succeeded");
  const [baseUrl, apiKey, protocol] = (
    await readFile(outputPath, "utf8")
  )
    .trim()
    .split("|");
  assert.equal(baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(protocol, "openai");
  assert.equal(typeof apiKey, "string");
});
