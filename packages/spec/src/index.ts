import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { type CronDate, CronExpressionParser } from "cron-parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { LoadedRoutine, RoutineDocument } from "@open-routines/core";
import {
  DEFAULT_RETRY_BACKOFF_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
} from "@open-routines/core";

const routineSchema = z.object({
  version: z.literal(1),
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/),
  description: z.string().max(280).optional(),
  trigger: z.object({
    type: z.literal("schedule"),
    cron: z.string().min(1),
    timezone: z.string().min(1).optional(),
  }),
  provider: z.object({
    type: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-_]*$/),
    model: z.string().min(1),
    connection: z.string().min(1).optional(),
  }),
  execution: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("command"),
      command: z.string().min(1),
      workingDir: z.string().min(1).optional(),
      shell: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      type: z.literal("prompt"),
      input: z.string().min(1),
      system: z.string().min(1).optional(),
      outputPath: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
    z.object({
      type: z.literal("skill"),
      tool: z.string().min(1),
      skill: z.string().min(1),
      args: z.string().optional(),
      prompt: z.string().optional(),
      workingDir: z.string().min(1).optional(),
      env: z.record(z.string(), z.string()).optional(),
    }),
  ]),
  policy: z
    .object({
      retry: z
        .object({
          maxAttempts: z.number().int().min(1).max(10).optional(),
          backoffSeconds: z.number().int().min(0).max(3_600).optional(),
        })
        .optional(),
      timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
      concurrency: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
});

export function validateRoutineDocument(input: unknown): RoutineDocument {
  const parsed = routineSchema.parse(input);

  assertValidCron(parsed.trigger.cron, parsed.trigger.timezone);

  return {
    ...parsed,
    policy: {
      retry: {
        maxAttempts: parsed.policy?.retry?.maxAttempts ?? 1,
        backoffSeconds:
          parsed.policy?.retry?.backoffSeconds ??
          DEFAULT_RETRY_BACKOFF_SECONDS,
      },
      timeoutSeconds:
        parsed.policy?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      concurrency: parsed.policy?.concurrency ?? 1,
    },
  };
}

export function parseRoutineYaml(
  input: string,
  sourcePath = "<inline>",
): LoadedRoutine {
  const parsed = parseYaml(input);
  const document = validateRoutineDocument(parsed);

  return {
    sourcePath: resolve(sourcePath),
    checksum: checksumForRoutine(document),
    document,
    nextRunAt: getNextRunAt(document),
  };
}

export async function loadRoutineFile(filePath: string): Promise<LoadedRoutine> {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, "utf8");
  return parseRoutineYaml(content, absolutePath);
}

export function getNextRunAt(
  routine: RoutineDocument,
  fromDate = new Date(),
): string | null {
  const interval = CronExpressionParser.parse(routine.trigger.cron, {
    currentDate: fromDate as unknown as CronDate,
    tz: routine.trigger.timezone,
  });

  return interval.next().toDate().toISOString();
}

export function getSubsequentRunAt(
  routine: RoutineDocument,
  fromIso: string | null,
): string | null {
  const baseDate = fromIso ? new Date(fromIso) : new Date();
  return getNextRunAt(routine, new Date(baseDate.getTime() + 1_000));
}

export function checksumForRoutine(document: RoutineDocument): string {
  return createHash("sha256")
    .update(stableStringify(document))
    .digest("hex");
}

export function stringifyRoutineDocument(document: RoutineDocument): string {
  return JSON.stringify(document);
}

export function parseStoredRoutineDocument(input: string): RoutineDocument {
  return validateRoutineDocument(JSON.parse(input));
}

function assertValidCron(expression: string, timezone?: string): void {
  try {
    CronExpressionParser.parse(expression, {
      currentDate: new Date() as unknown as CronDate,
      tz: timezone,
    });
  } catch (error) {
    throw new Error(
      `Invalid schedule cron expression "${expression}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
