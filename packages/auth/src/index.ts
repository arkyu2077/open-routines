import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { platform } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  OAuthAuthorizationConfig,
  OAuthDeviceConfig,
  OAuthTokenSet,
  RoutinePaths,
  StoredSecret,
} from "@open-routines/core";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "open-routines";

export interface SecretStore {
  kind: "keychain" | "file";
  setSecret(reference: string, value: StoredSecret): Promise<void>;
  getSecret(reference: string): Promise<StoredSecret | null>;
  deleteSecret(reference: string): Promise<void>;
}

interface EncryptedSecretRecord {
  iv: string;
  tag: string;
  cipherText: string;
}

export interface LocalCallbackResult {
  authorizationUrl: string;
  tokenSet: OAuthTokenSet;
}

export interface DeviceCodeFlowResult {
  tokenSet: OAuthTokenSet;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
}

export async function createSecretStore(paths: RoutinePaths): Promise<SecretStore> {
  if (platform === "darwin") {
    try {
      const store = new MacOsKeychainSecretStore();
      await store.selfCheck();
      return store;
    } catch {
      // Fall back to the encrypted file store.
    }
  }

  return new FileSecretStore(paths);
}

export async function runLocalCallbackOAuth(
  config: OAuthAuthorizationConfig,
): Promise<LocalCallbackResult> {
  const state = randomBytes(16).toString("hex");
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(await digestSha256(verifier));

  const authCode = await new Promise<{
    code: string;
    redirectUri: string;
    authorizationUrl: string;
  }>((resolve, reject) => {
    const server = createServer((request, response) => {
      const requestUrl = request.url
        ? new URL(request.url, `http://${request.headers.host}`)
        : null;

      if (!requestUrl) {
        response.statusCode = 400;
        response.end("Invalid callback request.");
        return;
      }

      const returnedState = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        response.statusCode = 400;
        response.end(`OAuth failed: ${error}`);
        reject(new Error(`OAuth failed: ${error}`));
        server.close();
        return;
      }

      if (!code || returnedState !== state) {
        response.statusCode = 400;
        response.end("Invalid OAuth callback.");
        reject(new Error("Invalid OAuth callback."));
        server.close();
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("Open Routines authentication complete. You can return to the terminal.");

      resolve({
        code,
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        authorizationUrl,
      });
      server.close();
    });

    let address: { port: number };
    let authorizationUrl = "";

    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const serverAddress = server.address();
      if (!serverAddress || typeof serverAddress === "string") {
        reject(new Error("Failed to bind a local OAuth callback server."));
        server.close();
        return;
      }

      address = { port: serverAddress.port };
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;

      const url = new URL(config.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");

      if (config.scopes?.length) {
        url.searchParams.set("scope", config.scopes.join(" "));
      }

      for (const [key, value] of Object.entries(
        config.extraAuthorizeParams ?? {},
      )) {
        url.searchParams.set(key, value);
      }

      authorizationUrl = url.toString();
      await openBrowser(authorizationUrl);
    });
  });

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", authCode.code);
  form.set("client_id", config.clientId);
  form.set("redirect_uri", authCode.redirectUri);
  form.set("code_verifier", verifier);

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Token exchange failed: ${
        typeof payload.error_description === "string"
          ? payload.error_description
          : JSON.stringify(payload)
      }`,
    );
  }

  return {
    authorizationUrl: authCode.authorizationUrl,
    tokenSet: normalizeTokenPayload(payload),
  };
}

export async function runDeviceCodeOAuth(
  config: OAuthDeviceConfig,
  onVerificationReady?: (info: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    intervalSeconds: number;
  }) => void,
): Promise<DeviceCodeFlowResult> {
  const requestBody = new URLSearchParams();
  requestBody.set("client_id", config.clientId);
  if (config.scopes?.length) {
    requestBody.set("scope", config.scopes.join(" "));
  }

  const deviceResponse = await fetch(config.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: requestBody.toString(),
  });
  const devicePayload = (await deviceResponse.json()) as Record<string, unknown>;

  if (!deviceResponse.ok) {
    throw new Error(
      `Device authorization failed: ${
        typeof devicePayload.error_description === "string"
          ? devicePayload.error_description
          : JSON.stringify(devicePayload)
      }`,
    );
  }

  const deviceCode = getRequiredString(devicePayload, "device_code");
  const userCode = getRequiredString(devicePayload, "user_code");
  const verificationUri = getRequiredString(devicePayload, "verification_uri");
  const verificationUriComplete =
    typeof devicePayload.verification_uri_complete === "string"
      ? devicePayload.verification_uri_complete
      : undefined;
  const intervalSeconds =
    typeof devicePayload.interval === "number" ? devicePayload.interval : 5;
  onVerificationReady?.({
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds,
  });

  const startedAt = Date.now();
  const expiresInSeconds =
    typeof devicePayload.expires_in === "number" ? devicePayload.expires_in : 900;

  let currentInterval = intervalSeconds;

  while (Date.now() - startedAt < expiresInSeconds * 1_000) {
    await sleep(currentInterval * 1_000);

    const tokenBody = new URLSearchParams();
    tokenBody.set(
      "grant_type",
      "urn:ietf:params:oauth:grant-type:device_code",
    );
    tokenBody.set("device_code", deviceCode);
    tokenBody.set("client_id", config.clientId);

    const tokenResponse = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    });
    const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;

    if (tokenResponse.ok) {
      return {
        tokenSet: normalizeTokenPayload(tokenPayload),
        userCode,
        verificationUri,
        verificationUriComplete,
        intervalSeconds: currentInterval,
      };
    }

    const error = typeof tokenPayload.error === "string" ? tokenPayload.error : "";
    if (error === "authorization_pending") {
      continue;
    }

    if (error === "slow_down") {
      currentInterval += 5;
      continue;
    }

    throw new Error(
      `Device token polling failed: ${
        typeof tokenPayload.error_description === "string"
          ? tokenPayload.error_description
          : JSON.stringify(tokenPayload)
      }`,
    );
  }

  throw new Error("Device code flow expired before authorization completed.");
}

export function normalizeTokenPayload(payload: Record<string, unknown>): OAuthTokenSet {
  const expiresAt =
    typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1_000).toISOString()
      : undefined;

  return {
    accessToken: getRequiredString(payload, "access_token"),
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    tokenType:
      typeof payload.token_type === "string" ? payload.token_type : undefined,
    expiresAt,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    idToken: typeof payload.id_token === "string" ? payload.id_token : undefined,
    raw: payload,
  };
}

export async function refreshOAuthToken(
  config: OAuthAuthorizationConfig | OAuthDeviceConfig,
  tokenSet: OAuthTokenSet,
): Promise<OAuthTokenSet> {
  if (!tokenSet.refreshToken) {
    return tokenSet;
  }

  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", tokenSet.refreshToken);
  form.set("client_id", config.clientId);

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const payload = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      `Token refresh failed: ${
        typeof payload.error_description === "string"
          ? payload.error_description
          : JSON.stringify(payload)
      }`,
    );
  }

  return normalizeTokenPayload({
    ...payload,
    refresh_token: payload.refresh_token ?? tokenSet.refreshToken,
  });
}

export function isTokenExpired(tokenSet: OAuthTokenSet, skewSeconds = 60): boolean {
  if (!tokenSet.expiresAt) {
    return false;
  }

  return Date.now() >= new Date(tokenSet.expiresAt).getTime() - skewSeconds * 1_000;
}

class MacOsKeychainSecretStore implements SecretStore {
  readonly kind = "keychain" as const;

  async selfCheck(): Promise<void> {
    await execFileAsync("security", ["list-keychains"]);
  }

  async setSecret(reference: string, value: StoredSecret): Promise<void> {
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      reference,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
      JSON.stringify(value),
    ]);
  }

  async getSecret(reference: string): Promise<StoredSecret | null> {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-a",
        reference,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      return JSON.parse(stdout) as StoredSecret;
    } catch {
      return null;
    }
  }

  async deleteSecret(reference: string): Promise<void> {
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-a",
        reference,
        "-s",
        KEYCHAIN_SERVICE,
      ]);
    } catch {
      // Ignore missing secrets.
    }
  }
}

class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;

  constructor(private readonly paths: RoutinePaths) {}

  async setSecret(reference: string, value: StoredSecret): Promise<void> {
    const [secrets, key] = await Promise.all([
      this.readSecrets(),
      this.readOrCreateMasterKey(),
    ]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const cipherText = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    secrets[reference] = {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      cipherText: cipherText.toString("base64"),
    };

    await this.writeSecrets(secrets);
  }

  async getSecret(reference: string): Promise<StoredSecret | null> {
    const [secrets, key] = await Promise.all([
      this.readSecrets(),
      this.readOrCreateMasterKey(),
    ]);
    const record = secrets[reference];
    if (!record) {
      return null;
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const value = Buffer.concat([
      decipher.update(Buffer.from(record.cipherText, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(value) as StoredSecret;
  }

  async deleteSecret(reference: string): Promise<void> {
    const secrets = await this.readSecrets();
    delete secrets[reference];
    await this.writeSecrets(secrets);
  }

  private async readOrCreateMasterKey(): Promise<Buffer> {
    try {
      const encoded = await readFile(this.paths.masterKeyPath, "utf8");
      return Buffer.from(encoded.trim(), "base64");
    } catch {
      const key = randomBytes(32);
      await mkdir(dirname(this.paths.masterKeyPath), { recursive: true });
      await writeFile(this.paths.masterKeyPath, key.toString("base64"), {
        mode: 0o600,
      });
      return key;
    }
  }

  private async readSecrets(): Promise<Record<string, EncryptedSecretRecord>> {
    try {
      const content = await readFile(this.paths.secretsPath, "utf8");
      return JSON.parse(content) as Record<string, EncryptedSecretRecord>;
    } catch {
      return {};
    }
  }

  private async writeSecrets(
    secrets: Record<string, EncryptedSecretRecord>,
  ): Promise<void> {
    await mkdir(dirname(this.paths.secretsPath), { recursive: true });
    await writeFile(this.paths.secretsPath, JSON.stringify(secrets, null, 2), {
      mode: 0o600,
    });
  }
}

async function digestSha256(value: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Buffer.from(digest);
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function openBrowser(url: string): Promise<void> {
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";

  if (command === "start") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  await execFileAsync(command, [url]);
}

function getRequiredString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected a string "${key}" in OAuth response.`);
  }
  return value;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function clearSecretStoreFiles(paths: RoutinePaths): Promise<void> {
  await rm(paths.secretsPath, { force: true });
  await rm(paths.masterKeyPath, { force: true });
}
