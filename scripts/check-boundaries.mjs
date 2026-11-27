#!/usr/bin/env node
// Runs dependency-cruiser over every package/app source tree with the clean-architecture rules.
import { spawnSync } from "node:child_process";

const targets = ["packages", "apps/server/src", "apps/cli/src"];
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "depcruise", "--config", ".dependency-cruiser.cjs", "--output-type", "err-long", ...targets],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
