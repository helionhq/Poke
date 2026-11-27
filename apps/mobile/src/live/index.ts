import type { PokeClient, ThreadStore } from "@poke/client";
import Constants from "expo-constants";
import { AppState } from "react-native";
import { liveActivities } from "../../modules/poke-live-activity";
import { TaskActivities } from "./tasks";

/** Off when the build left the extension out (POKE_LIVE_ACTIVITY=0) or there's no native module. */
export function liveActivitiesAvailable(): boolean {
  return Constants.expoConfig?.extra?.liveActivity !== false && liveActivities() !== undefined;
}

/**
 * Drives the Lock Screen activities from the thread store while the app runs. Returns a cleanup.
 */
export function followTasks(client: PokeClient, store: ThreadStore): () => void {
  const native = liveActivities();
  if (!native || !liveActivitiesAvailable()) return () => {};
  const activities = new TaskActivities(native);
  const sync = () =>
    activities.sync(
      store.tasks().map((task) => ({
        task,
        steps: store.steps(task.traceId),
        ...(store.liveLine(task.traceId) ? { liveLine: store.liveLine(task.traceId)! } : {}),
      })),
      AppState.currentState === "active",
    );
  // Activities left from before a relaunch end if their task finished meanwhile.
  void client
    .tasks()
    .then(({ tasks }) =>
      activities.reconcile(
        new Set(tasks.filter((t) => t.status === "running" || t.status === "waiting").map((t) => t.id)),
      ),
    )
    .catch(() => {});
  let frame: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = store.subscribe(() => {
    // Deltas arrive many times a second; one sync per burst is enough.
    if (frame) return;
    frame = setTimeout(() => {
      frame = undefined;
      sync();
    }, 500);
  });
  const app = AppState.addEventListener("change", (next) => {
    if (next === "active") sync();
  });
  sync();
  return () => {
    if (frame) clearTimeout(frame);
    unsubscribe();
    app.remove();
  };
}
