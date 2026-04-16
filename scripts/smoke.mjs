import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();
const cliPath = resolve(repoRoot, "packages/cli/dist/bin/routines.js");
const scratchDir = await mkdtemp(join(tmpdir(), "open-routines-smoke-"));
const homeDir = join(scratchDir, "home");
const routineFile = join(scratchDir, "smoke.yaml");
const outputFile = join(scratchDir, "smoke.txt");

await writeFile(
  routineFile,
  [
    "version: 1",
    "name: smoke-local",
    "trigger:",
    "  type: schedule",
    '  cron: "0 * * * *"',
    "provider:",
    "  type: gpt",
    "  model: gpt-5",
    "execution:",
    `  type: command`,
    `  command: "printf 'smoke ok\\n' > \\\"${escapeForYaml(outputFile)}\\\""`,
    "",
  ].join("\n"),
);

await run([
  "provider",
  "connect",
  "gpt",
  "--home",
  homeDir,
  "--api-key",
  "smoke-openai-key",
]);
const startProviderListOutput = await run(["provider", "list", "--home", homeDir]);
await run([
  "provider",
  "connect",
  "openrouter",
  "--home",
  homeDir,
  "--openai-base-url",
  "https://openrouter.ai/api/v1",
  "--api-key",
  "smoke-key",
]);
const providerListOutput = await run(["provider", "list", "--home", homeDir]);
await run(["routine", "enable", routineFile, "--home", homeDir]);
const runOutput = await run(["routine", "run", "smoke-local", "--home", homeDir]);
await run(["run", "list", "--home", homeDir, "--limit", "1"]);

const startProviderList = JSON.parse(startProviderListOutput);
assert.ok(
  startProviderList.some(
    (connection) =>
      connection.provider === "gpt" &&
      connection.authStrategy === "api_key",
  ),
);
const providerList = JSON.parse(providerListOutput);
assert.ok(
  providerList.some(
    (connection) =>
      connection.provider === "openrouter" &&
      connection.metadata?.protocol === "openai",
  ),
);
const result = JSON.parse(runOutput);
assert.equal(result.run.status, "succeeded");
assert.equal((await readFile(outputFile, "utf8")).trim(), "smoke ok");

process.stdout.write("Smoke check passed.\n");

async function run(args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    if (options.stdin) {
      child.stdin?.end(options.stdin);
    }
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Smoke command failed: routines ${args.join(" ")}\n${stderr || stdout}`,
          ),
        );
        return;
      }

      process.stdout.write(stdout);
      if (stderr.trim()) {
        process.stderr.write(stderr);
      }
      resolvePromise(stdout.trim());
    });
  });
}

function escapeForYaml(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
