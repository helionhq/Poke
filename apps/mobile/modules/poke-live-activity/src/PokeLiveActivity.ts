import { requireOptionalNativeModule } from "expo";

/** What the Lock Screen shows for a task (screen 08). */
export interface ActivityContent {
  title: string;
  line: string;
  /** "working", "waiting", "done" or "failed". */
  state: "working" | "waiting" | "done" | "failed";
  /** ms since epoch; the timer counts up from here. */
  startedAt: number;
}

export interface LiveActivities {
  isEnabled(): boolean;
  running(): Array<{ id: string; taskId: string }>;
  start(taskId: string, content: ActivityContent): Promise<string>;
  update(id: string, content: ActivityContent): Promise<void>;
  end(id: string, content: ActivityContent, dismissAfterSeconds: number): Promise<void>;
}

// Optional: Expo Go, tests and builds without the extension have no module.
const native = requireOptionalNativeModule<LiveActivities>("PokeLiveActivity");

export function liveActivities(): LiveActivities | undefined {
  return native ?? undefined;
}
