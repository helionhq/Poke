import {
  AgentMark,
  Icon,
  IconButton,
  ListGroup,
  ListRow,
  Logo,
  Text,
  images,
  useColors,
} from "@poke/ui-native";
import { wallpapers, type WallpaperScene } from "@poke/ui-tokens";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Pressable, ScrollView, View } from "react-native";
import { usePoke, useRemote } from "../src/lib/poke";
import { setWallpaper, useWallpaper } from "../src/lib/prefs";

const SCENE_NAMES: Record<WallpaperScene, string> = { haze: "Haze", dunes: "Dunes", coast: "Coast" };

function since(ms?: number): string {
  if (!ms) return "One thread, starting now";
  return `One thread since ${new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
}

/** 06 Agent sheet: who Poke is, the wallpaper, and everything he manages. */
export default function AgentSheet() {
  const c = useColors();
  const poke = usePoke();
  const scene = useWallpaper();
  const info = useRemote((p) => p.client.thread(), []);
  const routines = useRemote((p) => p.client.routines(), [], ["routine.updated", "routine.deleted"]);
  const skills = useRemote((p) => p.client.skills(), [], ["skill.updated", "skill.deleted"]);
  const apps = useRemote((p) => p.client.integrations(), [], ["integration.updated"]);

  const go = (href: Parameters<typeof router.push>[0]) => {
    router.back();
    setTimeout(() => router.push(href), 220);
  };
  const connected = (apps.data?.integrations ?? []).filter((i) =>
    i.accounts.some((a) => a.status === "connected"),
  );
  const active = routines.data?.routines.filter((r) => r.enabled).length;
  const enabledSkills = skills.data?.skills.filter((s) => s.enabled).length;

  return (
    <View style={{ flex: 1, backgroundColor: c.groundGrouped }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40, gap: 24 }}>
        <View style={{ height: 260, alignItems: "center", justifyContent: "flex-end", paddingBottom: 8 }}>
          <Image
            source={images.wallpapers[scene]}
            style={{ position: "absolute", inset: 0 }}
            contentFit="cover"
          />
          <LinearGradient
            colors={["transparent", c.groundGrouped]}
            locations={[0.35, 1]}
            style={{ position: "absolute", inset: 0 }}
          />
          <View style={{ position: "absolute", top: 16, right: 16 }}>
            <IconButton
              accessibilityLabel="Close"
              onPress={() => router.back()}
              icon={(color) => <Icon name="close" size={18} color={color} strokeWidth={2.4} />}
            />
          </View>
          <AgentMark size="xl" />
          <Text family="display" size="largeTitle" lineHeight={40} style={{ marginTop: 10 }}>
            Poke
          </Text>
          <Text size="footnote" color="ink2">
            {since(info.data?.since)}
            {info.data ? ` · ${info.data.messageCount.toLocaleString()} messages` : ""}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <Text size="footnote" weight="medium" color="ink2" style={{ paddingHorizontal: 4 }}>
            Wallpaper
          </Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {wallpapers.map((w) => {
              const selected = w === scene;
              return (
                <Pressable
                  key={w}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={SCENE_NAMES[w]}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setWallpaper(w);
                  }}
                  style={{ flex: 1, gap: 6, alignItems: "center" }}
                >
                  <View
                    style={{
                      width: "100%",
                      aspectRatio: 0.72,
                      borderRadius: 18,
                      padding: 3,
                      borderWidth: 2,
                      borderColor: selected ? c.ink : "transparent",
                    }}
                  >
                    <Image
                      source={images.wallpapers[w]}
                      style={{ flex: 1, borderRadius: 14 }}
                      contentFit="cover"
                    />
                    {selected ? (
                      <View
                        style={{
                          position: "absolute",
                          right: 8,
                          bottom: 8,
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: c.ink,
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="check" size={13} color={c.onInk} strokeWidth={3} />
                      </View>
                    ) : null}
                  </View>
                  <Text
                    size="footnote"
                    weight={selected ? "semibold" : "regular"}
                    color={selected ? "ink" : "ink2"}
                  >
                    {SCENE_NAMES[w]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <ListGroup>
          <ListRow
            tile="orange"
            title="Routines"
            {...(active !== undefined ? { value: String(active) } : {})}
            icon={(color) => <Icon name="clock" size={17} color={color} />}
            onPress={() => go("/routines")}
          />
          <ListRow
            tile="purple"
            title="Skills"
            {...(enabledSkills !== undefined ? { value: String(enabledSkills) } : {})}
            icon={(color) => <Icon name="sparkles" size={17} color={color} />}
            onPress={() => go("/skills")}
          />
          <ListRow
            tile="ink"
            title="Vault"
            {...(info.data?.vaultCount !== undefined ? { value: String(info.data.vaultCount) } : {})}
            icon={(color) => <Icon name="lock" size={16} color={color} />}
            onPress={() => go("/vault")}
          />
          <ListRow
            tile="blue"
            title="Library"
            icon={(color) => <Icon name="library" size={17} color={color} />}
            onPress={() => go("/library")}
          />
        </ListGroup>

        <ListGroup header="Can use">
          {connected.map((app) => (
            <ListRow
              key={app.id}
              tile="logo"
              title={app.name}
              value={
                app.accounts.length > 1
                  ? `${app.accounts.length} accounts`
                  : (app.accounts[0]?.identity ?? app.accounts[0]?.label ?? "")
              }
              icon={
                <Logo
                  mark={{ app: app.id, name: app.name, ...(app.icon ? { icon: app.icon } : {}) }}
                  size={20}
                  radius={5}
                />
              }
              onPress={() => go({ pathname: "/apps/[id]", params: { id: app.id } })}
            />
          ))}
          <ListRow
            tile="paper"
            title="Connect an app"
            icon={(color) => <Icon name="plus" size={16} color={color} strokeWidth={2.4} />}
            onPress={() => go("/apps")}
          />
        </ListGroup>

        <ListGroup>
          <ListRow
            tile="gray"
            title="Settings"
            icon={(color) => <Icon name="settings" size={17} color={color} />}
            onPress={() => go("/settings")}
          />
        </ListGroup>
        {poke.status !== "open" ? (
          <Text size="footnote" color="ink3" align="center">
            Not connected to your server right now. Showing what Poke last sent.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
