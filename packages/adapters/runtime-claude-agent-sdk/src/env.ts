/**
 * The Agent SDK's `env` option replaces the child's environment entirely. Poke builds it from a
 * short allowlist so no provider key (ANTHROPIC_API_KEY above all, which would bill the API
 * instead of the subscription) or other secret from Poke's own environment reaches Claude Code.
 */
const PASS_THROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  // Windows (development machines)
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramData",
  "ProgramFiles",
  "CLAUDE_CODE_GIT_BASH_PATH",
] as const;

/** Never passed, even if a caller adds them to `extra`. */
const FORBIDDEN = /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|GOOGLE_|AZURE_|OPENAI_|VOYAGE_|DASHSCOPE_|QWEN_)/;

export interface ClaudeEnvOptions {
  /** CLAUDE_CODE_OAUTH_TOKEN from `poke login anthropic` (vault system namespace). */
  token: string;
  /** Poke's own Claude Code config directory, so sessions never mix with a personal install. */
  configDir: string;
  base?: NodeJS.ProcessEnv;
  extra?: Record<string, string>;
}

export function claudeEnv(options: ClaudeEnvOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (!FORBIDDEN.test(key)) env[key] = value;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = options.token;
  env.CLAUDE_CONFIG_DIR = options.configDir;
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}
