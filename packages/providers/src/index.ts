import type {
  BuiltinProviderId,
  CustomProviderConfig,
  InvokeTextInput,
  InvokeTextResult,
  ProviderId,
  ProviderManifest,
  ProviderRuntimeContext,
  StoredSecret,
} from "@open-routines/core";
import {
  assertNever,
  isBuiltinProviderId,
} from "@open-routines/core";
import { isTokenExpired, refreshOAuthToken } from "@open-routines/auth";

const builtinProviderManifests: Record<BuiltinProviderId, ProviderManifest> = {
  gpt: {
    id: "gpt",
    label: "GPT",
    protocol: "openai",
    supportedAuth: ["api_key", "oauth_local_callback", "oauth_device_code"],
    localCallbackOAuth: buildGptLocalCallbackConfig(),
    deviceOAuth: buildGptDeviceConfig(),
    getCredentialEnvironment(secret) {
      const environment: Record<string, string> = {};
      if (!secret) {
        return environment;
      }

      switch (secret.kind) {
        case "api_key":
          environment.OPENAI_API_KEY = secret.value;
          return environment;
        case "oauth_token":
          environment.OPENAI_ACCESS_TOKEN = secret.value.accessToken;
          return environment;
        case "opaque_token":
          environment.OPENAI_ACCESS_TOKEN = secret.value;
          return environment;
        default:
          return assertNever(secret);
      }
    },
    async invokeText(input, context) {
      const bearerToken = getBearerToken(context.secret);
      if (!bearerToken) {
        throw new Error("GPT provider requires an API key or OAuth token.");
      }

      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          input: input.system
            ? [
                { role: "system", content: input.system },
                { role: "user", content: input.input },
              ]
            : input.input,
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`OpenAI request failed: ${JSON.stringify(payload)}`);
      }

      return {
        text: extractOpenAiResponsesText(payload),
        raw: payload,
      };
    },
  },
  claude: {
    id: "claude",
    label: "Claude",
    protocol: "anthropic",
    supportedAuth: ["api_key"],
    getCredentialEnvironment(secret) {
      const environment: Record<string, string> = {};
      if (secret?.kind === "api_key") {
        environment.ANTHROPIC_API_KEY = secret.value;
      }
      return environment;
    },
    async invokeText(input, context) {
      const apiKey = getApiKey(context.secret);
      if (!apiKey) {
        throw new Error("Claude provider requires an API key.");
      }

      return invokeAnthropicCompatible(
        {
          baseUrl: "https://api.anthropic.com/v1",
          headers: {},
          protocol: "anthropic",
        },
        input,
        apiKey,
      );
    },
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    protocol: "gemini",
    supportedAuth: ["api_key"],
    getCredentialEnvironment(secret) {
      const environment: Record<string, string> = {};
      if (secret?.kind === "api_key") {
        environment.GEMINI_API_KEY = secret.value;
      }
      return environment;
    },
    async invokeText(input, context) {
      const apiKey = getApiKey(context.secret);
      if (!apiKey) {
        throw new Error("Gemini provider requires an API key.");
      }

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        input.model,
      )}:generateContent`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: input.system
                    ? `${input.system}\n\n${input.input}`
                    : input.input,
                },
              ],
            },
          ],
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`Gemini request failed: ${JSON.stringify(payload)}`);
      }

      return {
        text: extractGeminiText(payload),
        raw: payload,
      };
    },
  },
};

export function listProviderManifests(): ProviderManifest[] {
  return Object.values(builtinProviderManifests);
}

export function getProviderManifest(
  providerId: ProviderId,
  connection: ProviderRuntimeContext["connection"] = null,
): ProviderManifest {
  if (isBuiltinProviderId(providerId)) {
    return builtinProviderManifests[providerId];
  }

  if (!connection) {
    throw new Error(
      `Provider "${providerId}" is not built in and requires a configured custom connection.`,
    );
  }

  return createCustomProviderManifest(providerId, connection);
}

export function isOAuthConfigured(providerId: ProviderId): boolean {
  if (!isBuiltinProviderId(providerId)) {
    return false;
  }

  const manifest = getProviderManifest(providerId);
  return Boolean(manifest.localCallbackOAuth || manifest.deviceOAuth);
}

export async function resolveProviderSecret(
  providerId: ProviderId,
  context: ProviderRuntimeContext,
): Promise<StoredSecret | null> {
  if (!context.secret || context.secret.kind !== "oauth_token") {
    return context.secret;
  }

  const manifest = getProviderManifest(providerId, context.connection);
  const oauthConfig =
    manifest.localCallbackOAuth ?? manifest.deviceOAuth ?? null;

  if (!oauthConfig || !isTokenExpired(context.secret.value)) {
    return context.secret;
  }

  if (!context.secret.value.refreshToken) {
    return context.secret;
  }

  return {
    kind: "oauth_token",
    value: await refreshOAuthToken(oauthConfig, context.secret.value),
  };
}

export async function invokeTextWithProvider(
  providerId: ProviderId,
  input: InvokeTextInput,
  context: ProviderRuntimeContext,
): Promise<InvokeTextResult> {
  const manifest = getProviderManifest(providerId, context.connection);
  const secret = await resolveProviderSecret(providerId, context);
  return manifest.invokeText(input, {
    connection: context.connection,
    secret,
  });
}

export function normalizeCustomProviderProtocol(
  protocol: string,
): CustomProviderConfig["protocol"] {
  if (protocol === "openai") {
    return "openai";
  }

  if (protocol === "claude" || protocol === "anthropic") {
    return "anthropic";
  }

  throw new Error(
    `Unsupported custom provider protocol "${protocol}". Expected "openai" or "claude"/"anthropic".`,
  );
}

export function parseCustomProviderConfig(
  metadata: Record<string, unknown>,
): CustomProviderConfig | null {
  const protocol =
    typeof metadata.protocol === "string"
      ? normalizeCustomProviderProtocol(metadata.protocol)
      : null;
  const baseUrl =
    typeof metadata.baseUrl === "string" ? metadata.baseUrl.trim() : "";

  if (!protocol || !baseUrl) {
    return null;
  }

  const headers: Record<string, string> = {};
  const rawHeaders =
    metadata.headers && typeof metadata.headers === "object"
      ? (metadata.headers as Record<string, unknown>)
      : {};

  for (const [key, value] of Object.entries(rawHeaders)) {
    if (typeof value === "string" && value) {
      headers[key] = value;
    }
  }

  return {
    protocol,
    baseUrl,
    headers,
  };
}

function createCustomProviderManifest(
  providerId: ProviderId,
  connection: NonNullable<ProviderRuntimeContext["connection"]>,
): ProviderManifest {
  const config = parseCustomProviderConfig(connection.metadata);
  if (!config) {
    throw new Error(
      `Custom provider "${providerId}" is missing protocol/baseUrl metadata.`,
    );
  }

  return {
    id: providerId,
    label:
      typeof connection.metadata.providerLabel === "string"
        ? connection.metadata.providerLabel
        : connection.label,
    protocol: config.protocol,
    custom: true,
    supportedAuth: ["api_key", "opaque_token"],
    getCredentialEnvironment(secret) {
      return getCustomProviderEnvironment(config, secret);
    },
    async invokeText(input, context) {
      switch (config.protocol) {
        case "openai": {
          const bearerToken = getBearerToken(context.secret);
          if (!bearerToken) {
            throw new Error(
              `Custom OpenAI-compatible provider "${providerId}" requires an API key or opaque token.`,
            );
          }
          return invokeOpenAiCompatible(config, input, bearerToken);
        }
        case "anthropic": {
          const apiKey = getApiKey(context.secret) ?? getBearerToken(context.secret);
          if (!apiKey) {
            throw new Error(
              `Custom Claude-compatible provider "${providerId}" requires an API key or opaque token.`,
            );
          }
          return invokeAnthropicCompatible(config, input, apiKey);
        }
        default:
          return assertNever(config.protocol);
      }
    },
  };
}

function getCustomProviderEnvironment(
  config: CustomProviderConfig,
  secret: StoredSecret | null,
): Record<string, string> {
  const environment: Record<string, string> = {
    OPEN_ROUTINES_PROVIDER_PROTOCOL: config.protocol,
    OPEN_ROUTINES_PROVIDER_BASE_URL: config.baseUrl,
  };

  if (Object.keys(config.headers ?? {}).length > 0) {
    environment.OPEN_ROUTINES_PROVIDER_HEADERS_JSON = JSON.stringify(
      config.headers ?? {},
    );
  }

  switch (config.protocol) {
    case "openai": {
      environment.OPENAI_BASE_URL = trimTrailingSlash(config.baseUrl);
      const token = getBearerToken(secret);
      if (token) {
        environment.OPENAI_API_KEY = token;
      }
      return environment;
    }
    case "anthropic": {
      environment.ANTHROPIC_BASE_URL = trimTrailingSlash(config.baseUrl);
      const token = getApiKey(secret) ?? getBearerToken(secret);
      if (token) {
        environment.ANTHROPIC_API_KEY = token;
      }
      return environment;
    }
    default:
      return assertNever(config.protocol);
  }
}

async function invokeOpenAiCompatible(
  config: CustomProviderConfig,
  input: InvokeTextInput,
  bearerToken: string,
): Promise<InvokeTextResult> {
  const response = await fetch(
    `${trimTrailingSlash(config.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "content-type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          ...(input.system
            ? [
                {
                  role: "system",
                  content: input.system,
                },
              ]
            : []),
          {
            role: "user",
            content: input.input,
          },
        ],
      }),
    },
  );

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `OpenAI-compatible request failed: ${JSON.stringify(payload)}`,
    );
  }

  return {
    text: extractOpenAiChatCompletionsText(payload),
    raw: payload,
  };
}

async function invokeAnthropicCompatible(
  config: CustomProviderConfig,
  input: InvokeTextInput,
  apiKey: string,
): Promise<InvokeTextResult> {
  const response = await fetch(`${trimTrailingSlash(config.baseUrl)}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...config.headers,
    },
    body: JSON.stringify({
      model: input.model,
      system: input.system,
      max_tokens: 1_024,
      messages: [
        {
          role: "user",
          content: input.input,
        },
      ],
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Anthropic-compatible request failed: ${JSON.stringify(payload)}`,
    );
  }

  return {
    text: extractClaudeText(payload),
    raw: payload,
  };
}

function getApiKey(secret: StoredSecret | null): string | null {
  return secret?.kind === "api_key" ? secret.value : null;
}

function getBearerToken(secret: StoredSecret | null): string | null {
  if (!secret) {
    return null;
  }

  switch (secret.kind) {
    case "api_key":
      return secret.value;
    case "oauth_token":
      return secret.value.accessToken;
    case "opaque_token":
      return secret.value;
    default:
      return assertNever(secret);
  }
}

function buildGptLocalCallbackConfig() {
  const clientId = process.env.OPEN_ROUTINES_GPT_CLIENT_ID;
  const authorizationEndpoint =
    process.env.OPEN_ROUTINES_GPT_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = process.env.OPEN_ROUTINES_GPT_TOKEN_ENDPOINT;
  if (!clientId || !authorizationEndpoint || !tokenEndpoint) {
    return undefined;
  }

  return {
    clientId,
    authorizationEndpoint,
    tokenEndpoint,
    scopes: process.env.OPEN_ROUTINES_GPT_SCOPES?.split(/\s+/).filter(Boolean),
  };
}

function buildGptDeviceConfig() {
  const clientId = process.env.OPEN_ROUTINES_GPT_CLIENT_ID;
  const deviceAuthorizationEndpoint =
    process.env.OPEN_ROUTINES_GPT_DEVICE_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = process.env.OPEN_ROUTINES_GPT_TOKEN_ENDPOINT;
  if (!clientId || !deviceAuthorizationEndpoint || !tokenEndpoint) {
    return undefined;
  }

  return {
    clientId,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
    scopes: process.env.OPEN_ROUTINES_GPT_SCOPES?.split(/\s+/).filter(Boolean),
  };
}

function extractOpenAiResponsesText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts = output.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? ((item as { content?: unknown[] }).content ?? [])
      : [];
    return content
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : null,
      )
      .filter((value): value is string => Boolean(value));
  });

  return texts.join("\n");
}

function extractOpenAiChatCompletionsText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  return choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") {
        return "";
      }

      const message = (choice as { message?: Record<string, unknown> }).message;
      return typeof message?.content === "string" ? message.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractClaudeText(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((item) =>
      item &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function extractGeminiText(payload: Record<string, unknown>): string {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const texts = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }

    const content = (candidate as { content?: Record<string, unknown> }).content;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : null,
      )
      .filter((value): value is string => Boolean(value));
  });

  return texts.join("\n");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
