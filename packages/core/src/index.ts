import { randomUUID } from "node:crypto";

export const BUILTIN_PROVIDER_IDS = ["gpt", "claude", "gemini"] as const;

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];
export type ProviderId = string;
export type ProviderProtocol = "openai" | "anthropic" | "gemini";
export type CustomProviderProtocol = "openai" | "anthropic";
export type TriggerType = "manual" | "schedule" | "webhook" | "event";
export type ExecutorType = "local" | "cloud";
export type RunStatus =
  | "queued"
  | "scheduled"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AuthStrategy =
  | "api_key"
  | "oauth_local_callback"
  | "oauth_device_code"
  | "opaque_token";

export interface ScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone?: string;
}

export interface RoutineProvider {
  type: ProviderId;
  model: string;
  connection?: string;
}

export interface CommandExecutionSpec {
  type: "command";
  command: string;
  workingDir?: string;
  shell?: string;
  env?: Record<string, string>;
}

export interface PromptExecutionSpec {
  type: "prompt";
  input: string;
  system?: string;
  outputPath?: string;
  env?: Record<string, string>;
}

export interface SkillExecutionSpec {
  type: "skill";
  tool: string;
  skill: string;
  args?: string;
  prompt?: string;
  workingDir?: string;
  env?: Record<string, string>;
}

export type ExecutionSpec = CommandExecutionSpec | PromptExecutionSpec | SkillExecutionSpec;

export interface RetryPolicy {
  maxAttempts?: number;
  backoffSeconds?: number;
}

export interface RoutinePolicy {
  retry?: RetryPolicy;
  timeoutSeconds?: number;
  concurrency?: number;
}

export interface RoutineDocument {
  version: 1;
  name: string;
  description?: string;
  trigger: ScheduleTrigger;
  provider: RoutineProvider;
  execution: ExecutionSpec;
  policy?: RoutinePolicy;
}

export interface LoadedRoutine {
  sourcePath: string;
  checksum: string;
  document: RoutineDocument;
  nextRunAt: string | null;
}

export interface StoredRoutine {
  id: string;
  name: string;
  sourcePath: string;
  managedPath: string;
  checksum: string;
  enabled: boolean;
  document: RoutineDocument;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  routineId: string;
  routineName: string;
  triggerType: TriggerType;
  provider: ProviderId;
  model: string;
  executorType: ExecutorType;
  status: RunStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  summary: string | null;
  logPath: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scope?: string;
  idToken?: string;
  raw?: unknown;
}

export type StoredSecret =
  | {
      kind: "api_key";
      value: string;
    }
  | {
      kind: "oauth_token";
      value: OAuthTokenSet;
    }
  | {
      kind: "opaque_token";
      value: string;
    };

export interface ProviderConnectionRecord {
  id: string;
  provider: ProviderId;
  label: string;
  authStrategy: AuthStrategy;
  metadata: Record<string, unknown>;
  secretRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudLinkRecord {
  endpoint: string;
  accountId: string;
  secretRef: string;
  linkedAt: string;
}

export interface OAuthAuthorizationConfig {
  clientId: string;
  scopes?: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  extraAuthorizeParams?: Record<string, string>;
}

export interface OAuthDeviceConfig {
  clientId: string;
  scopes?: string[];
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface InvokeTextInput {
  model: string;
  input: string;
  system?: string;
}

export interface InvokeTextResult {
  text: string;
  raw: unknown;
}

export interface ProviderRuntimeContext {
  connection: ProviderConnectionRecord | null;
  secret: StoredSecret | null;
}

export interface CustomProviderConfig {
  protocol: CustomProviderProtocol;
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface ProviderManifest {
  id: ProviderId;
  label: string;
  protocol: ProviderProtocol;
  custom?: boolean;
  supportedAuth: AuthStrategy[];
  localCallbackOAuth?: OAuthAuthorizationConfig;
  deviceOAuth?: OAuthDeviceConfig;
  getCredentialEnvironment(secret: StoredSecret | null): Record<string, string>;
  invokeText(
    input: InvokeTextInput,
    context: ProviderRuntimeContext,
  ): Promise<InvokeTextResult>;
}

export interface RoutinePaths {
  homeDir: string;
  dbPath: string;
  routinesDir: string;
  logsDir: string;
  artifactsDir: string;
  stateDir: string;
  secretsPath: string;
  masterKeyPath: string;
  daemonPidPath: string;
  daemonHeartbeatPath: string;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  heartbeatAt: string | null;
  stale: boolean;
}

export const DEFAULT_HOME_DIRNAME = ".routines";
export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_TIMEOUT_SECONDS = 1_800;
export const DEFAULT_RETRY_BACKOFF_SECONDS = 5;

export function isoNow(date = new Date()): string {
  return date.toISOString();
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function isBuiltinProviderId(providerId: string): providerId is BuiltinProviderId {
  return BUILTIN_PROVIDER_IDS.includes(providerId as BuiltinProviderId);
}
