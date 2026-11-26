import { clock, dayLabel, type RoutineRun } from "@poke/client";
import { Button, Icon, ListGroup, ListRow } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Field } from "../../src/ui/Field";
import { Footnote, Screen } from "../../src/ui/Screen";

const RUN_LABEL: Record<RoutineRun["status"], string> = {
  running: "Running now",
  delivered: "Told you",
  quiet: "Nothing worth saying",
  failed: "Didn't work",
};

/** One routine (deep link poke://routines/:id): what it does, when, and its recent runs. */
export default function RoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client } = usePoke();
  const detail = useRemote((p) => p.client.routine(id), [id], ["routine.updated", "routine.deleted"]);
  const routine = detail.data?.routine;
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!routine) return;
    setTitle(routine.title);
    setInstructions(routine.instructions);
  }, [routine]);

  const dirty = !!routine && (title.trim() !== routine.title || instructions.trim() !== routine.instructions);
  const patch = async (body: Parameters<typeof client.updateRoutine>[1]) => {
    try {
      const res = await client.updateRoutine(id, body);
      detail.setData((old) => old && { ...old, routine: res.routine });
      void Haptics.selectionAsync();
    } catch (e) {
      Alert.alert("Couldn't save that", e instanceof Error ? e.message : "");
    }
  };

  const save = async () => {
    setSaving(true);
    await patch({ title: title.trim(), instructions: instructions.trim() });
    setSaving(false);
  };

  const remove = () =>
    Alert.alert("Delete this routine?", "Poke stops running it. You can always ask for it again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await client.deleteRoutine(id);
            router.back();
          } catch (e) {
            Alert.alert("Couldn't delete it", e instanceof Error ? e.message : "");
          }
        },
      },
    ]);

  const runNow = async () => {
    try {
      await client.runRoutine(id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void detail.reload();
    } catch (e) {
      Alert.alert("Couldn't run it", e instanceof Error ? e.message : "");
    }
  };

  return (
    <Screen
      {...(routine ? { title: routine.title, subtitle: routine.scheduleText } : {})}
      loading={detail.loading && !detail.data}
      {...(detail.error ? { error: detail.error } : {})}
    >
      {routine ? (
        <>
          <ListGroup>
            <ListRow
              tile="orange"
              title="On"
              icon={(color) => <Icon name="clock" size={17} color={color} />}
              accessory={routine.enabled ? "toggle-on" : "toggle-off"}
              onToggle={(enabled) => void patch({ enabled })}
            />
            <ListRow
              tile="blue"
              title="Only when it matters"
              subtitle="Stay quiet when there's nothing worth telling you"
              icon={(color) => <Icon name="bell" size={17} color={color} />}
              accessory={routine.deliver === "only_if_notable" ? "toggle-on" : "toggle-off"}
              onToggle={(on) => void patch({ deliver: on ? "only_if_notable" : "always" })}
            />
          </ListGroup>
          <Field label="Name" value={title} onChangeText={setTitle} maxLength={80} />
          <Field
            label="What Poke does"
            value={instructions}
            onChangeText={setInstructions}
            multiline
            maxLength={4000}
          />
          <Footnote>To change when it runs, ask Poke in the thread.</Footnote>
          {dirty ? (
            <View style={{ paddingHorizontal: 16 }}>
              <Button
                tone="ink"
                width="fill"
                label={saving ? "Saving…" : "Save"}
                disabled={saving}
                onPress={() => void save()}
              />
            </View>
          ) : null}
          {detail.data && detail.data.runs.length > 0 ? (
            <ListGroup header="Recent runs">
              {detail.data.runs.slice(0, 10).map((run) => (
                <ListRow
                  key={run.id}
                  tile="none"
                  title={`${dayLabel(run.startedAt)} · ${clock(run.startedAt)}`}
                  subtitle={run.summary ?? RUN_LABEL[run.status] + (run.late ? " · ran late" : "")}
                  accessory={run.messageId ? "chevron" : "none"}
                  {...(run.messageId
                    ? {
                        onPress: () =>
                          router.dismissTo({ pathname: "/", params: { message: run.messageId! } }),
                      }
                    : {})}
                />
              ))}
            </ListGroup>
          ) : null}
          <ListGroup>
            <ListRow tile="none" title="Run now" accessory="none" onPress={() => void runNow()} />
            <ListRow tile="none" title="Delete routine" accessory="none" destructive onPress={remove} />
          </ListGroup>
        </>
      ) : null}
    </Screen>
  );
}
