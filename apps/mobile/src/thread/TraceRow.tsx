import { traceLine, traceSummary } from "@poke/client";
import { Logo, Step, Trace } from "@poke/ui-native";
import { useState } from "react";
import { usePoke, useThread } from "../lib/poke";

/**
 * A reply's tool activity. Running: one live line with the current tool's mark. Done: "Used 3
 * tools · …", which expands into the calls in order (fetched the first time it opens).
 */
export function TraceRow({ traceId }: { traceId: string }) {
  const store = useThread();
  const { client } = usePoke();
  const [open, setOpen] = useState(false);
  const trace = store.trace(traceId);
  if (!trace) return null;
  const steps = store.steps(traceId);
  if (trace.status === "running") {
    const running = [...steps].reverse().find((s) => s.status === "running");
    const app = running?.app ?? trace.lineApp;
    return (
      <Trace
        state="running"
        title={traceLine(trace, steps, store.liveLine(traceId))}
        {...(app
          ? {
              mark: (
                <Logo
                  mark={{ app: app.id, name: app.name, ...(app.icon ? { icon: app.icon } : {}) }}
                  size={12}
                  radius={3}
                />
              ),
            }
          : {})}
      />
    );
  }
  const { title, meta } = traceSummary(trace);
  const toggle = () => {
    if (!open && steps.length === 0) {
      void client.trace(traceId).then(
        (detail) => store.setSteps(traceId, detail.steps, detail.tasks),
        () => {},
      );
    }
    setOpen(!open);
  };
  return (
    <Trace
      state={open ? "expanded" : "collapsed"}
      title={title}
      {...(meta ? { meta } : {})}
      onToggle={toggle}
      steps={steps.map((step, i) => (
        <Step
          key={step.id}
          state={step.status === "running" ? "running" : "done"}
          label={step.status === "error" ? `${step.label} (didn't work)` : step.label}
          {...(step.detail ? { detail: step.detail } : {})}
          rail={i < steps.length - 1}
          {...(step.app
            ? {
                icon: (
                  <Logo
                    mark={{
                      app: step.app.id,
                      name: step.app.name,
                      ...(step.app.icon ? { icon: step.app.icon } : {}),
                    }}
                    size={13}
                    radius={3}
                  />
                ),
              }
            : {})}
        />
      ))}
    />
  );
}
