import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

const targets = [
  "packages/auth/dist",
  "packages/cli/dist",
  "packages/core/dist",
  "packages/daemon/dist",
  "packages/providers/dist",
  "packages/runtime/dist",
  "packages/sdk/dist",
  "packages/spec/dist",
  "packages/store/dist",
  "packages/auth/tsconfig.tsbuildinfo",
  "packages/cli/tsconfig.tsbuildinfo",
  "packages/core/tsconfig.tsbuildinfo",
  "packages/daemon/tsconfig.tsbuildinfo",
  "packages/providers/tsconfig.tsbuildinfo",
  "packages/runtime/tsconfig.tsbuildinfo",
  "packages/sdk/tsconfig.tsbuildinfo",
  "packages/spec/tsconfig.tsbuildinfo",
  "packages/store/tsconfig.tsbuildinfo",
];

await Promise.all(
  targets.map((target) => rm(resolve(root, target), { recursive: true, force: true })),
);
