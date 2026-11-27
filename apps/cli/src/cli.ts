import { Command, Option } from "commander";
import { createContext } from "./admin.js";
import { backupCommand, restoreCommand } from "./commands/backup.js";
import { configCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { loginCommand, modelCommand } from "./commands/models.js";
import "./commands/memory.js";
import "./commands/notifications.js";
import { logsCommand, serviceCommand } from "./commands/services.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { updateCommand } from "./commands/update.js";
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
  .option(
    "--only <step>",
    "run one step: profile, logins, models, memory, notifications, tunnel, service, pair",
  )
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

for (const action of ["start", "stop", "restart"] as const) {
  program
    .command(action)
    .description(
      action === "start"
        ? "Start Poke and its Docker services (or one service)"
        : action === "stop"
          ? "Stop Poke and its Docker services (or one service)"
          : "Restart Poke and its Docker services (or one service)",
    )
    .argument("[service]", "poke, honcho, memory, bark, tunnel, or a Docker service name")
    .action(wrap(async (service: string | undefined) => serviceCommand(ctx, action, service)));
}

program
  .command("update")
  .description("Update Poke from GitHub: build, migrate, restart, and publish the app update")
  .option("--ref <ref>", "a branch, tag or commit instead of origin/main")
  .option("--honcho", "also move Honcho to the version this release pins")
  .addOption(new Option("--nightly", "run only if update.auto is on (the timer)").hideHelp())
  .addOption(new Option("--apply <previous>", "second phase, run by the new build").hideHelp())
  .action(
    wrap(async (opts: { ref?: string; honcho?: boolean; nightly?: boolean; apply?: string }) =>
      updateCommand(ctx, opts),
    ),
  );

program
  .command("doctor")
  .description("Deep checks, with a fix offered for each problem (sends a test push)")
  .option("--fix", "run every fix without asking")
  .option("--json", "machine-readable output")
  .action(wrap(async (opts: { fix?: boolean; json?: boolean }) => doctorCommand(ctx, opts)));

program
  .command("backup")
  .description("Back up the thread, vault, master key, files and memory to one archive")
  .argument("[file]", "where to write it (default ~/poke/backups/)")
  .option("--json", "machine-readable output")
  .action(wrap(async (file: string | undefined, opts: { json?: boolean }) => backupCommand(ctx, file, opts)));

program
  .command("restore")
  .description("Restore a backup (what it replaces is moved aside)")
  .argument("<file>", "a poke backup archive")
  .option("--yes", "don't ask first")
  .option("--memory", "only load memory (Honcho), after setting it up on a new machine")
  .action(
    wrap(async (file: string, opts: { yes?: boolean; memory?: boolean }) => restoreCommand(ctx, file, opts)),
  );

program
  .command("logs")
  .description("Logs for one service or all of them")
  .argument("[service]", "poke, honcho, memory, bark, tunnel, or a Docker service name")
  .option("-f, --follow", "keep following")
  .action(
    wrap(async (service: string | undefined, opts: { follow?: boolean }) => logsCommand(ctx, service, opts)),
  );

program
  .command("help [command]")
  .description("Help for a command")
  .action((name?: string) => {
    const sub = name ? program.commands.find((c) => c.name() === name) : undefined;
    (sub ?? program).outputHelp();
  });

await program.parseAsync(process.argv);
