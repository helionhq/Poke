import { Icon, ListGroup, ListRow, Text, useColors } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, View } from "react-native";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Screen } from "../../src/ui/Screen";

/** One skill: what it's for, where it came from, its instructions. */
export default function SkillScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const { client } = usePoke();
  const c = useColors();
  const detail = useRemote((p) => p.client.skill(name), [name], ["skill.updated"]);
  const skill = detail.data?.skill;

  const setEnabled = async (enabled: boolean) => {
    void Haptics.selectionAsync();
    try {
      const res = await client.setSkillEnabled(name, enabled);
      detail.setData((old) => old && { skill: { ...old.skill, ...res.skill } });
    } catch (e) {
      Alert.alert("Couldn't change that", e instanceof Error ? e.message : "");
    }
  };

  const remove = () =>
    Alert.alert(`Remove ${name}?`, "Poke forgets this skill. You can install it again any time.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await client.deleteSkill(name);
            router.back();
          } catch (e) {
            Alert.alert("Couldn't remove it", e instanceof Error ? e.message : "");
          }
        },
      },
    ]);

  const source = skill?.source;
  return (
    <Screen
      {...(skill ? { title: skill.name, subtitle: skill.description } : {})}
      loading={detail.loading && !detail.data}
      {...(detail.error ? { error: detail.error } : {})}
      onRefresh={() => void detail.reload()}
    >
      {skill ? (
        <>
          <ListGroup>
            <ListRow
              tile="purple"
              title="On"
              icon={(color) => <Icon name="sparkles" size={17} color={color} />}
              accessory={skill.enabled ? "toggle-on" : "toggle-off"}
              onToggle={(on) => void setEnabled(on)}
            />
          </ListGroup>
          {skill.warnings.length > 0 ? (
            <ListGroup header="Worth knowing">
              {skill.warnings.map((w, i) => (
                <ListRow
                  key={i}
                  tile="yellow"
                  title={w}
                  icon={(color) => <Icon name="shield" size={16} color={color} />}
                  accessory="none"
                />
              ))}
            </ListGroup>
          ) : null}
          <ListGroup header="About">
            {source ? (
              <ListRow
                tile="none"
                title="Source"
                value={source.replace(/^https?:\/\//, "")}
                {...(/^https:\/\//.test(source)
                  ? { onPress: () => void WebBrowser.openBrowserAsync(source) }
                  : { accessory: "none" as const })}
              />
            ) : null}
            {skill.license ? (
              <ListRow tile="none" title="License" value={skill.license} accessory="none" />
            ) : null}
            {skill.allowedTools?.length ? (
              <ListRow
                tile="none"
                title="Tools it uses"
                subtitle={skill.allowedTools.join(", ")}
                accessory="none"
              />
            ) : null}
            <ListRow
              tile="none"
              title="Installed"
              value={new Date(skill.installedAt).toLocaleDateString()}
              accessory="none"
            />
          </ListGroup>
          {skill.body ? (
            <View
              style={{
                marginHorizontal: 16,
                padding: 16,
                borderRadius: 20,
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.separator,
              }}
            >
              <Text family="mono" size="footnote" lineHeight={19} color="ink2" selectable>
                {skill.body.length > 12_000 ? `${skill.body.slice(0, 12_000)}\n…` : skill.body}
              </Text>
            </View>
          ) : null}
          <ListGroup>
            <ListRow tile="none" title="Remove skill" accessory="none" destructive onPress={remove} />
          </ListGroup>
        </>
      ) : null}
    </Screen>
  );
}
