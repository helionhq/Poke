import * as p from "@clack/prompts";
import pc from "picocolors";
import qrcode from "qrcode-terminal";

export { p, pc };

export const ok = (text: string) => `${pc.green("✓")} ${text}`;
export const warn = (text: string) => `${pc.yellow("!")} ${text}`;
export const bad = (text: string) => `${pc.red("✗")} ${text}`;
export const dim = (text: string) => pc.dim(text);
export const cmd = (text: string) => pc.cyan(text);

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function qr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, (out) => resolve(out)));
}

/** Exit cleanly when the user presses Ctrl-C / Esc in a prompt. */
export function unwrap<T>(value: T | symbol): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(130);
  }
  return value as Exclude<T, symbol>;
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell).length)));
  return rows
    .map((row) => row.map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - visible(cell).length)).join("  "))
    .join("\n");
}

function visible(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function ago(at: number | undefined, now = Date.now()): string {
  if (at === undefined) return "never";
  const s = Math.round((now - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
