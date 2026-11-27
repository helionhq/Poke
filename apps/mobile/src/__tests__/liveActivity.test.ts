import type { Step, Task } from "@poke/contracts";
import type { ActivityContent, LiveActivities } from "../../modules/poke-live-activity";
import { activityContent, TaskActivities } from "../live/tasks";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  name: "Planning Lisbon",
  goal: "",
  context: "",
  skills: [],
  status: "running",
  traceId: "tr1",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const step = (over: Partial<Step> = {}): Step => ({
  id: "s1",
  taskId: "t1",
  traceId: "tr1",
  tool: "browse",
  label: "Checking flights on Google Flights",
  status: "running",
  startedAt: 1100,
  ...over,
});

function fakeNative(running: Array<{ id: string; taskId: string }> = []) {
  const calls: Array<[string, ...unknown[]]> = [];
  let n = 0;
  const native: LiveActivities = {
    isEnabled: () => true,
    running: () => running,
    start: async (taskId, content) => {
      calls.push(["start", taskId, content]);
      return `a${++n}`;
    },
    update: async (id, content) => void calls.push(["update", id, content]),
    end: async (id, content, linger) => void calls.push(["end", id, content, linger]),
  };
  return { native, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Live Activity content", () => {
  it("shows the task, its current step and how it stands", () => {
    expect(
      activityContent({ task: task(), steps: [step({ status: "done", label: "Old" }), step()] }),
    ).toEqual({
      title: "Planning Lisbon",
      line: "Checking flights on Google Flights",
      state: "working",
      startedAt: 1000,
    });
    expect(activityContent({ task: task(), steps: [], liveLine: "Reading reviews" }).line).toBe(
      "Reading reviews",
    );
    expect(activityContent({ task: task(), steps: [] }).line).toBe("Getting started");
    const waiting = task({
      status: "waiting",
      need: { id: "n", kind: "question", question: "Window or aisle?" },
    });
    expect(activityContent({ task: waiting, steps: [] })).toMatchObject({
      state: "waiting",
      line: "Window or aisle?",
    });
    expect(
      activityContent({
        task: task({ status: "completed", result: "**Booked** TAP 1234\nmore" }),
        steps: [],
      }),
    ).toMatchObject({ state: "done", line: "Booked TAP 1234" });
    expect(activityContent({ task: task({ status: "failed" }), steps: [] })).toMatchObject({
      state: "failed",
    });
  });
});

describe("TaskActivities", () => {
  it("starts in the foreground, updates only on change, and ends with the outcome", async () => {
    const { native, calls } = fakeNative();
    const live = new TaskActivities(native);

    live.sync([{ task: task(), steps: [step()] }], false);
    expect(calls).toHaveLength(0); // backgrounded: ActivityKit can't start one

    live.sync([{ task: task(), steps: [step()] }], true);
    await flush();
    expect(calls.map((c) => c[0])).toEqual(["start"]);

    live.sync([{ task: task(), steps: [step()] }], true);
    await flush();
    expect(calls).toHaveLength(1); // nothing changed

    live.sync([{ task: task(), steps: [step({ label: "Comparing hotels" })] }], false);
    await flush();
    expect(calls[1]).toEqual(["update", "a1", expect.objectContaining({ line: "Comparing hotels" })]);

    live.sync([{ task: task({ status: "completed", result: "Done: 3 options" }), steps: [] }], false);
    await flush();
    expect(calls[2]).toEqual(["end", "a1", expect.objectContaining({ state: "done" }), 900]);

    // Not started again for the same task.
    live.sync([{ task: task(), steps: [] }], true);
    await flush();
    expect(calls).toHaveLength(3);
  });

  it("ends a cancelled task's activity right away", async () => {
    const { native, calls } = fakeNative();
    const live = new TaskActivities(native);
    live.sync([{ task: task(), steps: [] }], true);
    await flush();
    live.sync([{ task: task({ status: "cancelled" }), steps: [] }], true);
    await flush();
    expect(calls[1]).toEqual(["end", "a1", expect.objectContaining({ line: "Stopped" }), 0]);
  });

  it("picks up activities from before a relaunch and ends the ones whose task finished", async () => {
    const { native, calls } = fakeNative([
      { id: "old1", taskId: "t1" },
      { id: "old2", taskId: "t2" },
    ]);
    const live = new TaskActivities(native);
    live.reconcile(new Set(["t1"]));
    await flush();
    expect(calls).toEqual([["end", "old2", expect.objectContaining({ title: "Poke" }), 0]]);
    live.sync([{ task: task(), steps: [step()] }], true);
    await flush();
    expect(calls[1]).toEqual(["update", "old1", expect.any(Object) as ActivityContent]);
  });
});
