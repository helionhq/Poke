import {
  AttachmentService,
  DeviceService,
  EventHub,
  PresenceTracker,
  SettingsService,
  SortableIds,
  ThreadService,
} from "@poke/application";
import { type Clock, type Logger, silentLogger, systemClock } from "@poke/domain";
import { openPokeDatabase, type PokeDatabase } from "@poke/storage-sqlite";
import { NodeFileStore, nodeCrypto, nodeTimers } from "./infra/node-ports.js";
import { ensureDirs, type PokePaths } from "./infra/paths.js";

export interface KernelOptions {
  paths: PokePaths;
  clock?: Clock;
  log?: Logger;
  /** ":memory:" for tests. */
  dbPath?: string;
}

/**
 * The application core without network listeners or agent runtimes. The server builds on it; the
 * CLI uses it directly when the server isn't running (setup, login, config, model).
 */
export interface Kernel {
  paths: PokePaths;
  clock: Clock;
  log: Logger;
  db: PokeDatabase;
  ids: SortableIds;
  hub: EventHub;
  presence: PresenceTracker;
  settings: SettingsService;
  devices: DeviceService;
  thread: ThreadService;
  attachments: AttachmentService;
  crypto: typeof nodeCrypto;
  timers: typeof nodeTimers;
  close(): void;
}

export function createKernel(options: KernelOptions): Kernel {
  const { paths } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLogger;
  if (options.dbPath !== ":memory:") ensureDirs(paths);
  const db = openPokeDatabase(options.dbPath ?? paths.db);
  const ids = new SortableIds(() => clock.now());
  const hub = new EventHub(db, clock, log);
  const files = new NodeFileStore(paths.library, paths.workspace);
  return {
    paths,
    clock,
    log,
    db,
    ids,
    hub,
    presence: new PresenceTracker(clock),
    settings: new SettingsService(db.settings, hub),
    devices: new DeviceService(db.devices, nodeCrypto, ids, clock),
    thread: new ThreadService(db, hub, ids, clock),
    attachments: new AttachmentService(db.attachments, files, nodeCrypto, ids, clock),
    crypto: nodeCrypto,
    timers: nodeTimers,
    close: () => db.close(),
  };
}
