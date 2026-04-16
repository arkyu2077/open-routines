import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import type { SecretStore } from "@open-routines/auth";
import { createSecretStore } from "@open-routines/auth";
import type {
  RunRecord,
  StoredRoutine,
} from "@open-routines/core";
import {
  isoNow,
  sleep,
  classifyError,
  DEFAULT_BACKOFF_SCHEDULE,
} from "@open-routines/core";
import type { ClassifiedError } from "@open-routines/core";
import { getProviderManifest, invokeTextWithProvider, resolveProviderSecret } from "@open-routines/providers";
import { RoutineStore, computeRoutineLogPath } from "@open-routines/store";

export interface ExecuteRoutineOptions {
  store?: RoutineStore;
  secretStore?: SecretStore;
  triggerType?: RunRecord["triggerType"];
}

export interface ExecuteRoutineResult {
  run: RunRecord;
  attempts: number;
}

export async function executeRoutine(
  routine: StoredRoutine,
  options: ExecuteRoutineOptions = {},
): Promise<ExecuteRoutineResult> {
  const store = options.store ?? new RoutineStore();
  const shouldCloseStore = !options.store;
  const secretStore =
    options.secretStore ?? (await createSecretStore(store.paths));
  const logPath = computeRoutineLogPath(store.paths, `${Date.now()}-${routine.name}`);
  await mkdir(dirname(logPath), { recursive: true });

  let run = store.createRun({
    routine,
    triggerType: options.triggerType ?? "manual",
    scheduledAt: routine.nextRunAt,
    logPath,
  });

  const retryPolicy = routine.document.policy?.retry;
  const maxAttempts = retryPolicy?.maxAttempts ?? 1;
  const backoffSchedule =
    retryPolicy?.backoffSchedule ??
    (retryPolicy?.backoffSeconds != null
      ? Array(maxAttempts).fill(retryPolicy.backoffSeconds)
      : DEFAULT_BACKOFF_SCHEDULE);
  let attempts = 0;
  let lastError: Error | null = null;
  let lastClassified: ClassifiedError | null = null;

  try {
    while (attempts < maxAttempts) {
      attempts += 1;
      run = store.updateRun(run.id, {
        status: "starting",
        startedAt: attempts === 1 ? isoNow() : run.startedAt ?? isoNow(),
      });

      try {
        const exitCode = await executeSingleAttempt(
          store,
          secretStore,
          routine,
          run,
          attempts,
          logPath,
        );

        if (exitCode === 0) {
          run = store.updateRun(run.id, {
            status: "succeeded",
            endedAt: isoNow(),
            exitCode,
            summary: `Completed successfully after ${attempts} attempt(s).`,
            errorMessage: null,
          });
          return { run, attempts };
        }

        lastError = new Error(`Command exited with status ${exitCode}.`);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      lastClassified = classifyError(lastError!);

      // Stop retrying on permanent errors
      if (!lastClassified.transient && attempts < maxAttempts) {
        await appendLogLine(
          logPath,
          `[runtime] permanent error (${lastClassified.kind}), skipping remaining retries`,
        );
        break;
      }

      run = store.updateRun(run.id, {
        status: "running",
      });

      if (attempts < maxAttempts) {
        const delaySec = backoffSchedule[Math.min(attempts - 1, backoffSchedule.length - 1)] ?? 5;
        await appendLogLine(
          logPath,
          `[runtime] attempt ${attempts} failed (${lastClassified.kind}), retrying in ${delaySec}s`,
        );
        await sleep(delaySec * 1_000);
      }
    }

    run = store.updateRun(run.id, {
      status: "failed",
      endedAt: isoNow(),
      exitCode: run.exitCode ?? 1,
      summary: `Failed after ${attempts} attempt(s). Error: ${lastClassified?.kind ?? "unknown"}.`,
      errorMessage: lastError?.message ?? "Unknown failure",
    });

    // Fire failure webhook if configured
    await fireFailureNotification(routine, run);

    return { run, attempts };
  } finally {
    if (shouldCloseStore) {
      store.close();
    }
  }
}

export async function executeRoutineByName(
  name: string,
  options: ExecuteRoutineOptions = {},
): Promise<ExecuteRoutineResult> {
  const store = options.store ?? new RoutineStore();
  const shouldCloseStore = !options.store;

  try {
    const routine = store.getRoutineByName(name);
    return await executeRoutine(routine, {
      ...options,
      store,
    });
  } finally {
    if (shouldCloseStore) {
      store.close();
    }
  }
}

async function executeSingleAttempt(
  store: RoutineStore,
  secretStore: SecretStore,
  routine: StoredRoutine,
  run: RunRecord,
  attempt: number,
  logPath: string,
): Promise<number> {
  const connection = store.findProviderConnection(
    routine.document.provider.type,
    routine.document.provider.connection,
  );
  const secret = connection ? await secretStore.getSecret(connection.secretRef) : null;
  const resolvedSecret = await resolveProviderSecret(routine.document.provider.type, {
    connection,
    secret,
  });

  await appendLogLine(
    logPath,
    `[runtime] attempt ${attempt} starting at ${isoNow()}`,
  );

  store.updateRun(run.id, {
    status: "running",
  });

  const execution = routine.document.execution;

  if (execution.type === "prompt") {
    return executePromptAttempt(
      routine,
      execution,
      connection,
      resolvedSecret,
      logPath,
    );
  }

  if (execution.type === "skill") {
    return executeSkillAttempt(routine, execution, logPath);
  }

  return executeCommandAttempt(
    routine,
    execution,
    run,
    connection,
    resolvedSecret,
    logPath,
  );
}

async function executePromptAttempt(
  routine: StoredRoutine,
  execution: import("@open-routines/core").PromptExecutionSpec,
  connection: import("@open-routines/core").ProviderRuntimeContext["connection"],
  secret: import("@open-routines/core").StoredSecret | null,
  logPath: string,
): Promise<number> {
  const { provider } = routine.document;

  await appendLogLine(logPath, `[runtime] invoking ${provider.type}/${provider.model}`);

  try {
    const result = await invokeTextWithProvider(
      provider.type,
      {
        model: provider.model,
        input: execution.input,
        system: execution.system,
      },
      { connection, secret },
    );

    await appendLogLine(logPath, `[ai-response]\n${result.text}`);

    if (execution.outputPath) {
      const outputDir = dirname(resolve(dirname(routine.sourcePath), execution.outputPath));
      await mkdir(outputDir, { recursive: true });
      const outputFullPath = resolve(dirname(routine.sourcePath), execution.outputPath);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputFullPath, result.text, "utf8");
      await appendLogLine(logPath, `[runtime] output written to ${outputFullPath}`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLogLine(logPath, `[runtime] prompt execution failed: ${message}`);
    throw error;
  }
}

async function executeCommandAttempt(
  routine: StoredRoutine,
  execution: import("@open-routines/core").CommandExecutionSpec,
  run: RunRecord,
  connection: import("@open-routines/core").ProviderRuntimeContext["connection"],
  secret: import("@open-routines/core").StoredSecret | null,
  logPath: string,
): Promise<number> {
  const providerManifest = getProviderManifest(
    routine.document.provider.type,
    connection,
  );
  const providerEnv = providerManifest.getCredentialEnvironment(secret);
  const runtimeEnv = {
    ...process.env,
    ...execution.env,
    ...providerEnv,
    OPEN_ROUTINES_RUN_ID: run.id,
    OPEN_ROUTINES_ROUTINE_NAME: routine.name,
    OPEN_ROUTINES_PROVIDER: routine.document.provider.type,
    OPEN_ROUTINES_MODEL: routine.document.provider.model,
    OPEN_ROUTINES_CONNECTION_LABEL: connection?.label ?? "",
  };
  const commandShell = execution.shell ?? process.env.SHELL ?? "/bin/sh";
  const workingDirectory = resolveWorkingDirectory(routine);
  await mkdir(workingDirectory, { recursive: true });

  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = spawn(execution.command, {
      cwd: workingDirectory,
      env: runtimeEnv,
      shell: commandShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutSeconds = routine.document.policy?.timeoutSeconds ?? 1800;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      void appendLogLine(
        logPath,
        `[runtime] timed out after ${timeoutSeconds} seconds`,
      );
    }, timeoutSeconds * 1_000);

    child.stdout?.on("data", (chunk) => {
      logStream.write(`[stdout] ${String(chunk)}`);
    });
    child.stderr?.on("data", (chunk) => {
      logStream.write(`[stderr] ${String(chunk)}`);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      logStream.end();
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) {
        logStream.write(`[runtime] terminated by signal ${signal}\n`);
      }
      logStream.end();
      resolvePromise(code ?? 1);
    });
  });
}

const TOOL_COMMANDS: Record<string, (skill: string, args: string | undefined, prompt: string | undefined) => string[]> = {
  claude: (skill, args, prompt) => {
    const parts = ["-p", `/${skill}${args ? ` ${args}` : ""}`];
    if (prompt) {
      parts[1] = `${prompt}\n\n/${skill}${args ? ` ${args}` : ""}`;
    }
    return parts;
  },
  codex: (skill, args, prompt) => {
    const input = prompt
      ? `${prompt}\n\nRun /${skill}${args ? ` ${args}` : ""}`
      : `/${skill}${args ? ` ${args}` : ""}`;
    return ["exec", input];
  },
};

function buildSkillCommand(
  tool: string,
  skill: string,
  args: string | undefined,
  prompt: string | undefined,
): { bin: string; argv: string[] } {
  const builder = TOOL_COMMANDS[tool];
  if (builder) {
    return { bin: tool, argv: builder(skill, args, prompt) };
  }
  // Generic fallback: treat tool as a CLI that accepts the skill as first arg
  const argv = [skill];
  if (args) argv.push(args);
  return { bin: tool, argv };
}

async function executeSkillAttempt(
  routine: StoredRoutine,
  execution: import("@open-routines/core").SkillExecutionSpec,
  logPath: string,
): Promise<number> {
  const { tool, skill, args, prompt } = execution;
  const { bin, argv } = buildSkillCommand(tool, skill, args, prompt);

  await appendLogLine(logPath, `[runtime] skill: ${tool} /${skill}${args ? ` ${args}` : ""}`);

  const workingDirectory = execution.workingDir
    ? resolve(dirname(routine.sourcePath), execution.workingDir)
    : dirname(routine.sourcePath);
  await mkdir(workingDirectory, { recursive: true });

  const runtimeEnv = {
    ...process.env,
    ...execution.env,
    OPEN_ROUTINES_ROUTINE_NAME: routine.name,
  };

  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const logStream = createWriteStream(logPath, { flags: "a" });
    const child = spawn(bin, argv, {
      cwd: workingDirectory,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutSeconds = routine.document.policy?.timeoutSeconds ?? 1800;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      void appendLogLine(logPath, `[runtime] skill timed out after ${timeoutSeconds}s`);
    }, timeoutSeconds * 1_000);

    child.stdout?.on("data", (chunk) => {
      logStream.write(`[stdout] ${String(chunk)}`);
    });
    child.stderr?.on("data", (chunk) => {
      logStream.write(`[stderr] ${String(chunk)}`);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      logStream.end();
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) {
        logStream.write(`[runtime] terminated by signal ${signal}\n`);
      }
      logStream.end();
      resolvePromise(code ?? 1);
    });
  });
}

function resolveWorkingDirectory(routine: StoredRoutine): string {
  const execution = routine.document.execution;
  const configuredWorkingDir =
    (execution.type === "command" || execution.type === "skill") ? execution.workingDir : undefined;
  if (!configuredWorkingDir) {
    return dirname(routine.sourcePath);
  }

  return resolve(dirname(routine.sourcePath), configuredWorkingDir);
}

async function fireFailureNotification(
  routine: StoredRoutine,
  run: RunRecord,
): Promise<void> {
  const notify = routine.document.policy?.notify;
  if (!notify) return;

  try {
    if (notify.type === "desktop") {
      await sendDesktopNotification(routine, run);
    } else if (notify.type === "webhook") {
      await sendWebhookNotification(routine, run, notify);
    }
  } catch {
    // Swallow notification errors — don't fail the run because of notification
  }
}

async function sendDesktopNotification(
  routine: StoredRoutine,
  run: RunRecord,
): Promise<void> {
  const title = "Open Routines";
  const message = `"${routine.name}" failed: ${run.errorMessage?.slice(0, 200) ?? "unknown error"}`;

  if (process.platform === "darwin") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Basso"`,
    ]);
  } else if (process.platform === "linux") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("notify-send", [title, message]).catch(() => {
      // notify-send not available
    });
  }
  // Windows: could use powershell toast, skip for now
}

async function sendWebhookNotification(
  routine: StoredRoutine,
  run: RunRecord,
  notify: import("@open-routines/core").WebhookNotify,
): Promise<void> {
  const response = await fetch(notify.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...notify.headers,
    },
    body: JSON.stringify({
      event: "routine.failed",
      routine: { name: routine.name, id: routine.id },
      run: {
        id: run.id,
        status: run.status,
        errorMessage: run.errorMessage,
        summary: run.summary,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      },
      timestamp: isoNow(),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    console.error(`[notify] webhook returned ${response.status}`);
  }
}

async function appendLogLine(logPath: string, line: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a" });
  await new Promise<void>((resolve, reject) => {
    stream.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      stream.end(resolve);
    });
  });
}
