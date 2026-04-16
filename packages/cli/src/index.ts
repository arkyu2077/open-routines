import {
  createInterface,
  type Interface as PromptInterface,
} from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Command } from "commander";

import {
  createSecretStore,
  runDeviceCodeOAuth,
  runLocalCallbackOAuth,
} from "@open-routines/auth";
import {
  startDaemon,
  getDaemonStatus as fetchDaemonStatus,
  stopDaemon,
} from "@open-routines/daemon";
import type {
  AuthStrategy,
  BuiltinProviderId,
  CloudLinkRecord,
  ProviderId,
  StoredSecret,
} from "@open-routines/core";
import {
  createId,
  isBuiltinProviderId,
  isoNow,
} from "@open-routines/core";
import {
  getProviderManifest,
  listProviderManifests,
  normalizeCustomProviderProtocol,
} from "@open-routines/providers";
import {
  executeRoutineByName,
  loadRoutine,
  scheduleRoutine,
} from "@open-routines/sdk";
import { RoutineStore } from "@open-routines/store";

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram();
  await program.parseAsync(argv);
}

export function createProgram(): Command {
  const program = new Command();
  program.name("routines").description("Open Routines CLI").version("0.1.0");

  program
    .command("start")
    .description("Interactive first-run setup")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const rl = createInterface({
        input,
        output,
        terminal: Boolean(input.isTTY && output.isTTY),
      });
      try {
        await runStartWizard(rl, options.home);
      } finally {
        rl.close();
      }
    });

  program
    .command("init")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        await store.initialize();
        console.log(`Initialized Open Routines at ${store.paths.homeDir}`);
      } finally {
        store.close();
      }
    });

  const daemon = program.command("daemon").description("Manage the local daemon");
  daemon
    .command("start")
    .option("--home <path>", "override the routines home directory")
    .option("--foreground", "run in the foreground")
    .option("--once", "process due routines once and exit")
    .option("--interval <ms>", "poll interval in milliseconds", parseInteger)
    .option("--force", "replace a stale pid lock")
    .action(
      async (options: {
        home?: string;
        foreground?: boolean;
        once?: boolean;
        interval?: number;
        force?: boolean;
      }) => {
        if (options.foreground || options.once) {
          await startDaemon({
            homeDir: options.home,
            pollIntervalMs: options.interval,
            once: options.once,
            force: options.force,
          });
          return;
        }

        const child = spawnDetachedDaemon(options);
        console.log(`Daemon started with pid ${child.pid}.`);
      },
    );

  daemon
    .command("status")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const status = await fetchDaemonStatus(options.home);
      console.log(JSON.stringify(status, null, 2));
    });

  daemon
    .command("stop")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      await stopDaemon(options.home);
      console.log("Daemon stop signal sent.");
    });

  const provider = program.command("provider").description("Manage provider connections");
  provider
    .command("connect")
    .argument("<provider>", "provider id, built-in or custom")
    .option("--home <path>", "override the routines home directory")
    .option("--label <label>", "connection label")
    .option("--api-key <key>", "API key value")
    .option("--api-key-env <env>", "read the API key from an environment variable")
    .option("--oauth <mode>", "oauth mode for GPT: local or device")
    .option(
      "--protocol <protocol>",
      'custom compatibility protocol: "openai", "claude", or "anthropic"',
    )
    .option(
      "--base-url <url>",
      "custom provider base URL ending at the API root",
    )
    .option(
      "--openai-base-url <url>",
      "shorthand for a custom OpenAI-compatible provider",
    )
    .option(
      "--claude-base-url <url>",
      "shorthand for a custom Claude-compatible provider",
    )
    .option(
      "--header <key=value>",
      "additional static request header, can be passed multiple times",
      collectOption,
      [],
    )
    .action(
      async (
        providerId: string,
        options: {
          home?: string;
          label?: string;
          apiKey?: string;
          apiKeyEnv?: string;
          oauth?: "local" | "device";
          protocol?: string;
          baseUrl?: string;
          openaiBaseUrl?: string;
          claudeBaseUrl?: string;
          header?: string[];
        },
      ) => {
        await connectProvider(providerId, options);
      },
    );

  provider
    .command("connect-custom")
    .argument("<provider>", "custom provider id, for example openrouter or local-claude")
    .requiredOption(
      "--protocol <protocol>",
      'compatibility protocol: "openai", "claude", or "anthropic"',
    )
    .requiredOption(
      "--base-url <url>",
      "base URL ending at the API root, for example https://openrouter.ai/api/v1",
    )
    .option("--home <path>", "override the routines home directory")
    .option("--label <label>", "connection label")
    .option("--api-key <key>", "API key value")
    .option("--api-key-env <env>", "read the API key from an environment variable")
    .option(
      "--header <key=value>",
      "additional static request header, can be passed multiple times",
      collectOption,
      [],
    )
    .action(
      async (
        providerId: string,
        options: {
          protocol: string;
          baseUrl: string;
          home?: string;
          label?: string;
          apiKey?: string;
          apiKeyEnv?: string;
          header?: string[];
        },
      ) => {
        await connectProvider(providerId, options);
      },
    );

  provider
    .command("list")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        const connections = store.listProviderConnections();
        if (connections.length === 0) {
          console.log("No provider connections configured.");
          return;
        }
        console.log(JSON.stringify(connections, null, 2));
      } finally {
        store.close();
      }
    });

  provider
    .command("catalog")
    .description("List built-in provider manifests")
    .action(() => {
      console.log(JSON.stringify(listProviderManifests(), null, 2));
    });

  const routine = program.command("routine").description("Manage routines");
  routine
    .command("validate")
    .argument("<file>", "path to a routine yaml file")
    .action(async (filePath: string) => {
      const loaded = await loadRoutine(filePath);
      console.log(JSON.stringify(loaded, null, 2));
    });

  routine
    .command("enable")
    .argument("<file>", "path to a routine yaml file")
    .option("--home <path>", "override the routines home directory")
    .action(async (filePath: string, options: { home?: string }) => {
      const saved = await scheduleRoutine(resolve(filePath), options.home);
      console.log(
        `Enabled routine "${saved.name}" with next run at ${saved.nextRunAt ?? "n/a"}.`,
      );
    });

  routine
    .command("disable")
    .argument("<name>", "routine name")
    .option("--home <path>", "override the routines home directory")
    .action(async (name: string, options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        const routineRecord = store.disableRoutine(name);
        console.log(`Disabled routine "${routineRecord.name}".`);
      } finally {
        store.close();
      }
    });

  routine
    .command("list")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        console.log(JSON.stringify(store.listRoutines(), null, 2));
      } finally {
        store.close();
      }
    });

  routine
    .command("run")
    .argument("<name>", "routine name")
    .option("--home <path>", "override the routines home directory")
    .action(async (name: string, options: { home?: string }) => {
      const result = await executeRoutineByName(name, options.home, {
        triggerType: "manual",
      });
      console.log(JSON.stringify(result, null, 2));
    });

  const run = program.command("run").description("Inspect run history");
  run
    .command("list")
    .option("--home <path>", "override the routines home directory")
    .option("--limit <n>", "maximum number of runs", parseInteger)
    .action(async (options: { home?: string; limit?: number }) => {
      const store = new RoutineStore(options.home);
      try {
        console.log(JSON.stringify(store.listRuns(options.limit ?? 50), null, 2));
      } finally {
        store.close();
      }
    });

  run
    .command("show")
    .argument("<runId>", "run id")
    .option("--home <path>", "override the routines home directory")
    .action(async (runId: string, options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        console.log(JSON.stringify(store.getRun(runId), null, 2));
      } finally {
        store.close();
      }
    });

  program
    .command("logs")
    .argument("<runId>", "run id")
    .option("--home <path>", "override the routines home directory")
    .action(async (runId: string, options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      try {
        output.write(await store.readRunLogs(runId));
      } finally {
        store.close();
      }
    });

  program
    .command("login")
    .option("--home <path>", "override the routines home directory")
    .option("--endpoint <url>", "cloud endpoint", "https://routines.one")
    .option("--account-id <id>", "account identifier")
    .option("--token <token>", "cloud token")
    .action(
      async (options: {
        home?: string;
        endpoint?: string;
        accountId?: string;
        token?: string;
      }) => {
        const store = new RoutineStore(options.home);
        await store.initialize();
        const secretStore = await createSecretStore(store.paths);

        try {
          const token =
            options.token ?? (await promptForSecret("Cloud access token"));
          if (!token) {
            throw new Error("A cloud token is required.");
          }

          const accountId =
            options.accountId ?? `local-${createId("account").slice(-12)}`;
          const secretRef = "cloud:default";
          await secretStore.setSecret(secretRef, {
            kind: "opaque_token",
            value: token,
          });

          const link: CloudLinkRecord = {
            endpoint: options.endpoint ?? "https://routines.one",
            accountId,
            secretRef,
            linkedAt: isoNow(),
          };
          store.setCloudLink(link);
          console.log(`Linked this instance to ${link.endpoint} as ${link.accountId}.`);
        } finally {
          store.close();
        }
      },
    );

  program
    .command("logout")
    .option("--home <path>", "override the routines home directory")
    .action(async (options: { home?: string }) => {
      const store = new RoutineStore(options.home);
      await store.initialize();
      const secretStore = await createSecretStore(store.paths);

      try {
        const link = store.getCloudLink();
        if (link) {
          await secretStore.deleteSecret(link.secretRef);
          store.clearCloudLink();
        }
        console.log("Cleared the cloud link.");
      } finally {
        store.close();
      }
    });

  program
    .command("_daemon-run")
    .allowUnknownOption(true)
    .option("--home <path>", "override the routines home directory")
    .option("--interval <ms>", "poll interval in milliseconds", parseInteger)
    .option("--once", "process due routines once and exit")
    .option("--force", "replace a stale pid lock")
    .action(
      async (options: {
        home?: string;
        interval?: number;
        once?: boolean;
        force?: boolean;
      }) => {
        await startDaemon({
          homeDir: options.home,
          pollIntervalMs: options.interval,
          once: options.once,
          force: options.force,
        });
      },
    );

  return program;
}

function spawnDetachedDaemon(options: {
  home?: string;
  interval?: number;
  once?: boolean;
  force?: boolean;
}) {
  const binPath = fileURLToPath(new URL("./bin/routines.js", import.meta.url));
  const args = [binPath, "_daemon-run"];

  if (options.home) {
    args.push("--home", options.home);
  }
  if (typeof options.interval === "number") {
    args.push("--interval", String(options.interval));
  }
  if (options.force) {
    args.push("--force");
  }
  if (options.once) {
    args.push("--once");
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function promptForSecret(label: string): Promise<string> {
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  try {
    return (await rl.question(`${label}: `)).trim();
  } finally {
    rl.close();
  }
}

async function runStartWizard(
  rl: PromptInterface,
  homeDir?: string,
): Promise<void> {
  console.log("Open Routines setup");
  console.log("");

  const providerSelection = await promptChoice(rl, "Choose a provider", [
    { label: "OpenAI", value: "gpt" as const },
    { label: "Claude", value: "claude" as const },
    { label: "Gemini", value: "gemini" as const },
    { label: "Custom OpenAI-compatible", value: "custom-openai" as const },
    { label: "Custom Claude-compatible", value: "custom-claude" as const },
  ]);

  switch (providerSelection) {
    case "gpt":
      await runBuiltinProviderWizard(rl, "gpt", homeDir);
      break;
    case "claude":
      await runBuiltinProviderWizard(rl, "claude", homeDir);
      break;
    case "gemini":
      await runBuiltinProviderWizard(rl, "gemini", homeDir);
      break;
    case "custom-openai":
      await runCustomProviderWizard(rl, "openai", homeDir);
      break;
    case "custom-claude":
      await runCustomProviderWizard(rl, "anthropic", homeDir);
      break;
    default:
      throw new Error(`Unsupported provider selection "${providerSelection}".`);
  }

  console.log("");
  console.log("Next:");
  console.log("  routines routine enable examples/hello.yaml");
  console.log("  routines routine run hello-world");
}

function assertBuiltinProvider(providerId: string): asserts providerId is BuiltinProviderId {
  if (!isBuiltinProviderId(providerId)) {
    throw new Error(
      `Unsupported built-in provider "${providerId}". Use "routines provider connect-custom" for compatible third-party providers.`,
    );
  }
}

function assertCustomProvider(providerId: string): asserts providerId is ProviderId {
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(providerId)) {
    throw new Error(
      `Invalid custom provider id "${providerId}". Use lowercase letters, numbers, dashes, or underscores.`,
    );
  }

  if (isBuiltinProviderId(providerId)) {
    throw new Error(
      `Custom provider id "${providerId}" conflicts with a built-in provider. Use "routines provider connect ${providerId}" without custom flags.`,
    );
  }
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid header "${value}". Expected the form key=value.`,
      );
    }

    const key = value.slice(0, separatorIndex).trim();
    const headerValue = value.slice(separatorIndex + 1).trim();
    if (!key || !headerValue) {
      throw new Error(
        `Invalid header "${value}". Expected the form key=value.`,
      );
    }

    headers[key] = headerValue;
  }

  return headers;
}

async function runBuiltinProviderWizard(
  rl: PromptInterface,
  providerId: BuiltinProviderId,
  homeDir?: string,
): Promise<void> {
  const manifest = getProviderManifest(providerId);

  if (providerId === "gpt") {
    const authSelection = await promptChoice(
      rl,
      "How do you want to connect OpenAI?",
      [
        { label: "API key", value: "api_key" as const },
        { label: "OAuth in browser", value: "oauth_local" as const },
        { label: "OAuth device code", value: "oauth_device" as const },
      ],
    );

    if (authSelection === "oauth_local") {
      if (!manifest.localCallbackOAuth) {
        console.log("");
        console.log(
          "OAuth in browser is not configured on this machine yet. Missing OPEN_ROUTINES_GPT_CLIENT_ID / OPEN_ROUTINES_GPT_AUTHORIZATION_ENDPOINT / OPEN_ROUTINES_GPT_TOKEN_ENDPOINT.",
        );
        console.log("Falling back to API key setup.");
        console.log("");
      } else {
        await connectBuiltinProvider(providerId, {
          home: homeDir,
          oauth: "local",
        });
        return;
      }
    }

    if (authSelection === "oauth_device") {
      if (!manifest.deviceOAuth) {
        console.log("");
        console.log(
          "OAuth device code is not configured on this machine yet. Missing OPEN_ROUTINES_GPT_CLIENT_ID / OPEN_ROUTINES_GPT_DEVICE_AUTHORIZATION_ENDPOINT / OPEN_ROUTINES_GPT_TOKEN_ENDPOINT.",
        );
        console.log("Falling back to API key setup.");
        console.log("");
      } else {
        await connectBuiltinProvider(providerId, {
          home: homeDir,
          oauth: "device",
        });
        return;
      }
    }
  }

  const inferredEnvVar = getDefaultApiKeyEnvVar(providerId);
  if (inferredEnvVar && process.env[inferredEnvVar]) {
    const useEnvVar = await promptYesNo(
      rl,
      `Use ${inferredEnvVar} from your current shell?`,
      true,
    );
    if (useEnvVar) {
      await connectBuiltinProvider(providerId, {
        home: homeDir,
        apiKeyEnv: inferredEnvVar,
      });
      return;
    }
  }

  const apiKey = await promptRequiredText(rl, `${manifest.label} API key`);
  await connectBuiltinProvider(providerId, {
    home: homeDir,
    apiKey,
  });
}

async function runCustomProviderWizard(
  rl: PromptInterface,
  protocol: "openai" | "anthropic",
  homeDir?: string,
): Promise<void> {
  const suggestedProviderId =
    protocol === "openai" ? "openrouter" : "custom-claude";
  const providerId = await promptRequiredText(
    rl,
    "Provider id",
    suggestedProviderId,
  );
  const baseUrl = await promptRequiredText(
    rl,
    protocol === "openai"
      ? "OpenAI-compatible base URL"
      : "Claude-compatible base URL",
  );
  const apiKey = await promptRequiredText(rl, "API key");

  await connectCustomProvider(providerId, {
    home: homeDir,
    apiKey,
    protocol,
    baseUrl,
  });
}

async function connectProvider(
  providerId: string,
  options: {
    home?: string;
    label?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    oauth?: "local" | "device";
    protocol?: string;
    baseUrl?: string;
    openaiBaseUrl?: string;
    claudeBaseUrl?: string;
    header?: string[];
  },
): Promise<void> {
  const customMode = hasCustomProviderOptions(providerId, options);

  if (customMode) {
    await connectCustomProvider(providerId, options);
    return;
  }

  assertBuiltinProvider(providerId);
  await connectBuiltinProvider(providerId, options);
}

async function connectBuiltinProvider(
  providerId: BuiltinProviderId,
  options: {
    home?: string;
    label?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    oauth?: "local" | "device";
  },
): Promise<void> {
  const store = new RoutineStore(options.home);
  await store.initialize();
  const secretStore = await createSecretStore(store.paths);

  try {
    const manifest = getProviderManifest(providerId);
    const label = options.label ?? providerId;
    let authStrategy: AuthStrategy;
    let secret: StoredSecret;

    if (options.apiKey || options.apiKeyEnv) {
      const apiKey =
        options.apiKey ??
        process.env[options.apiKeyEnv ?? ""] ??
        (await promptForSecret(`${providerId} API key`));
      if (!apiKey) {
        throw new Error("No API key was provided.");
      }
      authStrategy = "api_key";
      secret = { kind: "api_key", value: apiKey };
    } else if (providerId === "gpt" && options.oauth === "local") {
      if (!manifest.localCallbackOAuth) {
        throw new Error(
          "GPT local OAuth is not configured. Set OPEN_ROUTINES_GPT_CLIENT_ID, OPEN_ROUTINES_GPT_AUTHORIZATION_ENDPOINT, and OPEN_ROUTINES_GPT_TOKEN_ENDPOINT.",
        );
      }
      const result = await runLocalCallbackOAuth(manifest.localCallbackOAuth);
      console.log(`Opened browser for OAuth authorization: ${result.authorizationUrl}`);
      authStrategy = "oauth_local_callback";
      secret = { kind: "oauth_token", value: result.tokenSet };
    } else if (providerId === "gpt" && options.oauth === "device") {
      if (!manifest.deviceOAuth) {
        throw new Error(
          "GPT device OAuth is not configured. Set OPEN_ROUTINES_GPT_CLIENT_ID, OPEN_ROUTINES_GPT_DEVICE_AUTHORIZATION_ENDPOINT, and OPEN_ROUTINES_GPT_TOKEN_ENDPOINT.",
        );
      }
      const result = await runDeviceCodeOAuth(
        manifest.deviceOAuth,
        (info) => {
          console.log(
            `Approve device login at ${info.verificationUriComplete ?? info.verificationUri} using code ${info.userCode}`,
          );
        },
      );
      authStrategy = "oauth_device_code";
      secret = { kind: "oauth_token", value: result.tokenSet };
    } else {
      throw new Error(
        `Unsupported connection mode for ${providerId}. Use --api-key/--api-key-env, or for GPT use --oauth local|device.`,
      );
    }

    const secretRef = `provider:${providerId}:${label}`;
    await secretStore.setSecret(secretRef, secret);
    const record = store.putProviderConnection({
      provider: providerId,
      label,
      authStrategy,
      metadata: {
        connectedAt: isoNow(),
        providerLabel: manifest.label,
      },
      secretRef,
    });

    console.log(
      `Connected ${providerId} as "${record.label}" using ${record.authStrategy}.`,
    );
  } finally {
    store.close();
  }
}

async function connectCustomProvider(
  providerId: string,
  options: {
    home?: string;
    label?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    protocol?: string;
    baseUrl?: string;
    openaiBaseUrl?: string;
    claudeBaseUrl?: string;
    header?: string[];
  },
): Promise<void> {
  assertCustomProvider(providerId);
  const resolvedProtocol =
    typeof options.openaiBaseUrl === "string"
      ? "openai"
      : typeof options.claudeBaseUrl === "string"
        ? "anthropic"
        : options.protocol;
  const resolvedBaseUrl =
    options.openaiBaseUrl ?? options.claudeBaseUrl ?? options.baseUrl;

  if (!resolvedProtocol || !resolvedBaseUrl) {
    throw new Error(
      `Custom provider "${providerId}" requires either --openai-base-url, --claude-base-url, or both --protocol and --base-url.`,
    );
  }

  const store = new RoutineStore(options.home);
  await store.initialize();
  const secretStore = await createSecretStore(store.paths);

  try {
    const apiKey =
      options.apiKey ??
      process.env[options.apiKeyEnv ?? ""] ??
      (await promptForSecret(`${providerId} API key`));
    if (!apiKey) {
      throw new Error("No API key was provided.");
    }

    const protocol = normalizeCustomProviderProtocol(resolvedProtocol);
    const headers = parseHeaders(options.header ?? []);
    const label = options.label ?? providerId;
    const secretRef = `provider:${providerId}:${label}`;
    await secretStore.setSecret(secretRef, {
      kind: "api_key",
      value: apiKey,
    });

    const record = store.putProviderConnection({
      provider: providerId,
      label,
      authStrategy: "api_key",
      metadata: {
        connectedAt: isoNow(),
        providerLabel: label,
        protocol,
        baseUrl: resolvedBaseUrl,
        headers,
        custom: true,
      },
      secretRef,
    });

    console.log(
      `Connected custom provider "${record.provider}" as "${record.label}" using ${protocol} compatibility at ${resolvedBaseUrl}.`,
    );
  } finally {
    store.close();
  }
}

function hasCustomProviderOptions(
  providerId: string,
  options: {
    protocol?: string;
    baseUrl?: string;
    openaiBaseUrl?: string;
    claudeBaseUrl?: string;
    header?: string[];
  },
): boolean {
  return (
    !isBuiltinProviderId(providerId) ||
    Boolean(options.protocol) ||
    Boolean(options.baseUrl) ||
    Boolean(options.openaiBaseUrl) ||
    Boolean(options.claudeBaseUrl) ||
    Boolean(options.header?.length)
  );
}

async function promptChoice<T extends string>(
  rl: PromptInterface,
  label: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  console.log(label);
  for (const [index, option] of options.entries()) {
    console.log(`  ${index + 1}. ${option.label}`);
  }

  while (true) {
    const answer = (await rl.question("> ")).trim();
    const numericIndex = Number.parseInt(answer, 10);
    if (!Number.isNaN(numericIndex) && numericIndex >= 1 && numericIndex <= options.length) {
      return options[numericIndex - 1]!.value;
    }
    console.log(`Enter a number between 1 and ${options.length}.`);
  }
}

async function promptRequiredText(
  rl: PromptInterface,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const resolved = answer || defaultValue || "";
    if (resolved) {
      return resolved;
    }
    console.log(`${label} is required.`);
  }
}

async function promptYesNo(
  rl: PromptInterface,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await rl.question(`${label} ${hint} `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (["y", "yes"].includes(answer)) {
      return true;
    }
    if (["n", "no"].includes(answer)) {
      return false;
    }
    console.log("Enter y or n.");
  }
}

function getDefaultApiKeyEnvVar(
  providerId: BuiltinProviderId,
): string | null {
  switch (providerId) {
    case "gpt":
      return "OPENAI_API_KEY";
    case "claude":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    default:
      return null;
  }
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer, received "${value}".`);
  }
  return parsed;
}

export async function main(): Promise<void> {
  try {
    await runCli(process.argv);
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
