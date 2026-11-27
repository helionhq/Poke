import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { claudeEnv } from "./env.js";

/**
 * The Claude Code binary the Agent SDK ships in its platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`). Nothing has to be installed.
 */
export function bundledClaudeExecutable(): string | undefined {
  const require = createRequire(import.meta.url);
  let sdk: string;
  try {
    sdk = require.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    return undefined;
  }
  const fromSdk = createRequire(sdk);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  for (const name of [base, `${base}-musl`]) {
    try {
      const path = join(dirname(fromSdk.resolve(`${name}/package.json`)), binary);
      if (existsSync(path)) return path;
    } catch {
      // not installed for this platform
    }
  }
  return undefined;
}

/**
 * Runs `claude setup-token` in the terminal: Claude Code opens a browser to sign in with the
 * Claude account and prints a long-lived token for the subscription. The environment is the same
 * allowlist the runtime uses, so an ANTHROPIC_API_KEY in the shell can't change what it does.
 */
export async function runClaudeSetupToken(options: {
  configDir: string;
  executable?: string;
}): Promise<number> {
  const executable = options.executable ?? bundledClaudeExecutable();
  if (!executable)
    throw new Error("Claude Code isn't installed with Poke (the Agent SDK's platform package is missing)");
  const env = claudeEnv({ token: "", configDir: options.configDir });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["setup-token"], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
