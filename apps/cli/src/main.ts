#!/usr/bin/env node
import { Command } from "commander";
import { createContext } from "./admin.js";
import { configCommand } from "./commands/config.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { bad } from "./ui.js";

const program = new Command()
  .name("poke")
  .description("Poke's machine: set up, log in, configure, pick models, and keep it running.")
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: false });

const ctx = createContext();
const wrap =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(bad((error as Error).message));
      process.exitCode = 1;
    } finally {
      ctx.close();
    }
  };

program
  .command("setup")
  .description("First-run wizard (idempotent; every step after preflight can be skipped)")
  .option("--preflight", "only run the preflight checks")
  .action(
    wrap(async (opts: { preflight?: boolean }) =>
      setupCommand(ctx, { preflightOnly: Boolean(opts.preflight) }),
    ),
  );

program
  .command("config")
  .description("Service keys, devices and settings")
  .argument("[key]", "setting or key, or `devices`")
  .argument("[value]", "new value")
  .argument("[rest...]")
  .option("--list", "list everything")
  .option("--unset", "remove the value")
  .option("--json", "machine-readable output")
  .action(
    wrap(
      async (
        key: string | undefined,
        value: string | undefined,
        rest: string[],
        opts: { list?: boolean; unset?: boolean; json?: boolean },
      ) => configCommand(ctx, key, value, rest, opts),
    ),
  );

program
  .command("status")
  .description("Services, logins, models, context, usage, tasks and routines")
  .option("--json", "machine-readable output")
  .action(wrap(async (opts: { json?: boolean }) => statusCommand(ctx, opts)));

program
  .command("help [command]")
  .description("Help for a command")
  .action((name?: string) => {
    const sub = name ? program.commands.find((c) => c.name() === name) : undefined;
    (sub ?? program).outputHelp();
  });

await program.parseAsync(process.argv);
