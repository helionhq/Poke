import type { VoiceOption } from "@poke/contracts";
import { ListGroup, ListRow } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";
import { usePoke, useRemote } from "../src/lib/poke";
import { Empty, Footnote, Screen } from "../src/ui/Screen";

/** Poke's voice for read aloud and calls (AssemblyAI's voices, grouped by language). */
export default function VoicesScreen() {
  const { client } = usePoke();
  const info = useRemote((p) => p.client.voice(), [], ["settings.updated"]);
  const voices = info.data?.voices ?? [];

  const pick = async (voice: VoiceOption) => {
    void Haptics.selectionAsync();
    info.setData((old) => old && { ...old, voice: voice.id });
    try {
      await client.updateSettings({ voice: voice.id });
    } catch (e) {
      Alert.alert("Couldn't change the voice", e instanceof Error ? e.message : "");
      void info.reload();
    }
  };

  const groups = new Map<string, VoiceOption[]>();
  for (const v of voices) {
    const language = v.language ?? "Other";
    groups.set(language, [...(groups.get(language) ?? []), v]);
  }

  return (
    <Screen title="Voice">
      {info.data && !info.data.configured ? (
        <Footnote>
          Voice needs an AssemblyAI key on your server. Until then the iPhone reads aloud in its own voice.
        </Footnote>
      ) : null}
      {[...groups].map(([language, list]) => (
        <ListGroup key={language} header={language}>
          {list.map((v) => (
            <ListRow
              key={v.id}
              tile="none"
              title={v.name}
              {...(v.description ? { subtitle: v.description } : {})}
              accessory={info.data?.voice === v.id ? "check" : "none"}
              onPress={() => void pick(v)}
            />
          ))}
        </ListGroup>
      ))}
      {info.data ? (
        <Footnote>You'll hear the new voice the next time Poke reads aloud or picks up a call.</Footnote>
      ) : info.error ? (
        <Empty
          title="Couldn’t load the voices"
          body={info.error}
          action={{ label: "Try again", onPress: () => void info.reload() }}
        />
      ) : null}
    </Screen>
  );
}
