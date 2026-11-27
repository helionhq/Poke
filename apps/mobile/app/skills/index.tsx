import type { Skill } from "@poke/client";
import { Icon, IconButton, ListGroup, ListRow } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Alert } from "react-native";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Empty, Footnote, Screen } from "../../src/ui/Screen";

/** 13 Skills: know-how Poke and his agents load when a task calls for it. */
export default function SkillsScreen() {
  const { client } = usePoke();
  const list = useRemote((p) => p.client.skills(), [], ["skill.updated", "skill.deleted"]);
  const skills = list.data?.skills ?? [];

  const toggle = async (skill: Skill, enabled: boolean) => {
    void Haptics.selectionAsync();
    list.setData(
      (old) => old && { skills: old.skills.map((s) => (s.name === skill.name ? { ...s, enabled } : s)) },
    );
    try {
      await client.setSkillEnabled(skill.name, enabled);
    } catch (e) {
      Alert.alert("Couldn't change that", e instanceof Error ? e.message : "");
      void list.reload();
    }
  };

  const row = (s: Skill) => (
    <ListRow
      key={s.name}
      tile={s.enabled ? "purple" : "gray"}
      title={s.name}
      subtitle={s.warnings.length ? `Needs a look · ${s.description}` : s.description}
      icon={(color) => <Icon name="sparkles" size={17} color={color} />}
      accessory={s.enabled ? "toggle-on" : "toggle-off"}
      onToggle={(on) => void toggle(s, on)}
      onPress={() => router.push({ pathname: "/skills/[name]", params: { name: s.name } })}
    />
  );

  const on = skills.filter((s) => s.enabled);
  const off = skills.filter((s) => !s.enabled);
  return (
    <Screen
      title="Skills"
      subtitle="Know-how Poke picks up when a task calls for it."
      loading={list.loading && !list.data}
      {...(list.error ? { error: list.error } : {})}
      onRefresh={() => void list.reload()}
      trailing={
        <IconButton
          accessibilityLabel="Add a skill"
          onPress={() => router.dismissTo({ pathname: "/", params: { draft: "Install the skill at " } })}
          icon={(color) => <Icon name="plus" size={20} color={color} strokeWidth={2.4} />}
        />
      }
    >
      {skills.length === 0 && list.data ? (
        <Empty title="No skills yet" body="Send Poke a link to a skill on GitHub and he'll install it." />
      ) : null}
      {on.length > 0 ? <ListGroup header="On">{on.map(row)}</ListGroup> : null}
      {off.length > 0 ? <ListGroup header="Off">{off.map(row)}</ListGroup> : null}
      <Footnote>
        To add one, send Poke a link: “install the skill at github.com/…”. He reads it first and tells you
        what it does.
      </Footnote>
    </Screen>
  );
}
