import { Command } from "commander";
import { createContext } from "./admin.js";
import { configCommand } from "./commands/config.js";
import { loginCommand, modelCommand } from "./commands/models.js";
import "./commands/memory.js";
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
      await ctx.close();
    }
  };

program
  .command("setup")
  .description("First-run wizard (idempotent; every step after preflight can be skipped)")
  .option("--preflight", "only run the preflight checks")
  .option("--only <step>", "run one step: profile, logins, models, memory, pair")
  .action(
    wrap(async (opts: { preflight?: boolean; only?: string }) =>
      setupCommand(ctx, {
        preflightOnly: Boolean(opts.preflight),
        ...(opts.only ? { only: opts.only } : {}),
      }),
    ),
  );

program
  .command("login")
  .description("Log in to a model provider: anthropic, qwen, qwen-cn, voyage")
  .argument("[provider]", "login id")
  .option("--logout", "remove the saved credential")
  .option("--stdin", "read the key or token from stdin instead of prompting")
  .option("--json", "machine-readable output")
  .action(
    wrap(async (provider: string | undefined, opts: { logout?: boolean; stdin?: boolean; json?: boolean }) =>
      loginCommand(ctx, provider, opts),
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
  .option("--stdin", "read a service key from stdin instead of prompting")
  .option("--json", "machine-readable output")
  .action(
    wrap(
      async (
        key: string | undefined,
        value: string | undefined,
        rest: string[],
        opts: { list?: boolean; unset?: boolean; json?: boolean; stdin?: boolean },
      ) => configCommand(ctx, key, value, rest, opts),
    ),
  );

program
  .command("model")
  .description("Pick the provider, model and reasoning level for each role")
  .argument("[action]", "`set` or `unset`")
  .argument("[args...]", "set: <role> <provider>/<model>; unset: <role>")
  .option("--reasoning <level>", "reasoning level (set)")
  .option("--voice-reasoning <level>", "reasoning level for voice calls (set, Poke role)")
  .option("--json", "machine-readable output")
  .action(
    wrap(
      async (
        action: string | undefined,
        args: string[],
        opts: { reasoning?: string; voiceReasoning?: string; json?: boolean },
      ) => modelCommand(ctx, action, args, opts),
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
