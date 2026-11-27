import { PokeClient } from "@poke/client";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { liveActivities } from "../../modules/poke-live-activity";
import { loadSession } from "../lib/session";
import { liveActivitiesAvailable } from "./index";
import { activityContent } from "./tasks";

const TASK = "poke.live-activity-sync";

/**
 * Best effort (brief section 18): when iOS gives Poke background time (rarely, and never on a
 * schedule), bring the Lock Screen activities up to date and end the ones whose task finished.
 * Must be defined at module load, before the app renders.
 */
TaskManager.defineTask(TASK, async () => {
  const native = liveActivities();
  if (!native) return BackgroundTask.BackgroundTaskResult.Success;
  try {
    const running = native.running();
    if (running.length === 0) return BackgroundTask.BackgroundTaskResult.Success;
    const session = await loadSession();
    if (!session) return BackgroundTask.BackgroundTaskResult.Success;
    const client = new PokeClient({
      baseUrl: session.url,
      token: session.token,
      ...(session.headers ? { headers: session.headers } : {}),
    });
    for (const { id, taskId } of running) {
      const { task, steps } = await client.task(taskId);
      const content = activityContent({ task, steps });
      if (task.status === "running" || task.status === "waiting") await native.update(id, content);
      else await native.end(id, content, task.status === "cancelled" ? 0 : 15 * 60);
    }
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  if (!liveActivitiesAvailable()) return;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!(await TaskManager.isTaskRegisteredAsync(TASK))) {
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
    }
  } catch {
    // Not available in Expo Go or the simulator.
  }
}
