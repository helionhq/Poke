import type { RoutineView } from "@poke/client";
import { Icon, IconButton, ListGroup, ListRow } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Alert } from "react-native";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Empty, Footnote, Screen } from "../../src/ui/Screen";

/** 12 Routines: what Poke does on a schedule. Toggle to pause; tap for details. */
export default function RoutinesScreen() {
  const { client } = usePoke();
  const list = useRemote((p) => p.client.routines(), [], ["routine.updated", "routine.deleted"]);
  const routines = list.data?.routines ?? [];
  const active = routines.filter((r) => r.enabled);
  const paused = routines.filter((r) => !r.enabled);

  const toggle = async (routine: RoutineView, enabled: boolean) => {
    void Haptics.selectionAsync();
    list.setData(
      (old) => old && { routines: old.routines.map((r) => (r.id === routine.id ? { ...r, enabled } : r)) },
    );
    try {
      await client.updateRoutine(routine.id, { enabled });
    } catch (e) {
      Alert.alert("Couldn't change that", e instanceof Error ? e.message : "");
      void list.reload();
    }
  };

  const row = (r: RoutineView) => (
    <ListRow
      key={r.id}
      tile={r.enabled ? "orange" : "gray"}
      title={r.title}
      subtitle={r.scheduleText}
      icon={(color) => <Icon name="clock" size={17} color={color} />}
      accessory={r.enabled ? "toggle-on" : "toggle-off"}
      onToggle={(on) => void toggle(r, on)}
      onPress={() => router.push({ pathname: "/routines/[id]", params: { id: r.id } })}
    />
  );

  return (
    <Screen
      title="Routines"
      subtitle="Things Poke does on a schedule, and tells you about in the thread."
      loading={list.loading && !list.data}
      {...(list.error ? { error: list.error } : {})}
      onRefresh={() => void list.reload()}
      trailing={
        <IconButton
          accessibilityLabel="Add a routine"
          onPress={() => router.dismissTo({ pathname: "/", params: { draft: "Every morning at 7:30, " } })}
          icon={(color) => <Icon name="plus" size={20} color={color} strokeWidth={2.4} />}
        />
      }
    >
      {routines.length === 0 && list.data ? (
        <Empty
          title="No routines yet"
          body="Ask Poke for one, like “every Friday at 5, tell me what's on next week.”"
        />
      ) : null}
      {active.length > 0 ? <ListGroup header="Active">{active.map(row)}</ListGroup> : null}
      {paused.length > 0 ? <ListGroup header="Paused">{paused.map(row)}</ListGroup> : null}
      <Footnote>
        To add one, just ask in the thread: “every weekday at 8, check my calendar and tell me what to prep
        for.”
      </Footnote>
    </Screen>
  );
}
