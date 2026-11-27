import { Icon, Menu, MenuItem, Text, useColors } from "@poke/ui-native";
import { Image } from "expo-image";
import * as MediaLibrary from "expo-media-library/legacy";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isScannerAvailable } from "../../modules/document-scanner";
import type { LocalFile } from "../lib/attach";

/** 05 Add menu: recent photos, then Camera, Photos, Files, Scan Document and the Library. */
export function AddMenu({
  visible,
  onClose,
  onPick,
  onLibrary,
}: {
  visible: boolean;
  onClose(): void;
  onLibrary(): void;
  onPick(source: "camera" | "photos" | "files" | "scan" | LocalFile): void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [recent, setRecent] = useState<MediaLibrary.Asset[]>([]);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void (async () => {
      const permission = await MediaLibrary.getPermissionsAsync();
      const granted =
        permission.granted ||
        (permission.canAskAgain && (await MediaLibrary.requestPermissionsAsync()).granted);
      if (!granted || !alive) return;
      const page = await MediaLibrary.getAssetsAsync({
        first: 12,
        mediaType: "photo",
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      if (alive) setRecent(page.assets);
    })().catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible]);
  const pickRecent = async (asset: MediaLibrary.Asset) => {
    const info = await MediaLibrary.getAssetInfoAsync(asset);
    onPick({
      uri: info.localUri ?? asset.uri,
      name: asset.filename,
      mime: "image/jpeg",
      kind: "image",
      width: asset.width,
      height: asset.height,
    });
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]}
        onPress={onClose}
        accessibilityLabel="Close menu"
      />
      <View
        style={{ position: "absolute", left: 16, right: 16, bottom: insets.bottom + 72, gap: 10 }}
        pointerEvents="box-none"
      >
        {recent.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {recent.map((asset) => (
              <Pressable
                key={asset.id}
                onPress={() => void pickRecent(asset)}
                accessibilityLabel="Recent photo"
              >
                <Image
                  source={{ uri: asset.uri }}
                  style={{ width: 76, height: 96, borderRadius: 14 }}
                  contentFit="cover"
                />
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Menu>
          <MenuItem
            edge="none"
            label="Camera"
            icon={(color) => <Icon name="camera" color={color} />}
            onPress={() => onPick("camera")}
          />
          <MenuItem
            label="Photos"
            icon={(color) => <Icon name="image" color={color} />}
            onPress={() => onPick("photos")}
          />
          <MenuItem
            label="Files"
            icon={(color) => <Icon name="file" color={color} />}
            onPress={() => onPick("files")}
          />
          {isScannerAvailable() && (
            <MenuItem
              label="Scan Document"
              icon={(color) => <Icon name="paperclip" color={color} />}
              onPress={() => onPick("scan")}
            />
          )}
          <MenuItem
            label="Library"
            icon={(color) => <Icon name="library" color={color} />}
            onPress={onLibrary}
          />
        </Menu>
      </View>
    </Modal>
  );
}

/** 03 Long-press on a message: Copy, Select All, Reply. */
export function MessageMenu({
  target,
  onClose,
  onCopy,
  onSelect,
  onReply,
}: {
  target?: { text: string };
  onClose(): void;
  onCopy(): void;
  onSelect(): void;
  onReply(): void;
}) {
  const c = useColors();
  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }]}
        onPress={onClose}
        accessibilityLabel="Close menu"
      />
      <View
        style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 12 }}
        pointerEvents="box-none"
      >
        {target ? (
          <View
            style={{ maxHeight: 220, maxWidth: 340, padding: 14, borderRadius: 18, backgroundColor: c.card }}
          >
            <Text size="callout" numberOfLines={8}>
              {target.text}
            </Text>
          </View>
        ) : null}
        <Menu>
          <MenuItem
            edge="none"
            label="Copy"
            icon={(color) => <Icon name="copy" color={color} />}
            onPress={onCopy}
          />
          <MenuItem
            label="Select All"
            icon={(color) => <Icon name="pencil" color={color} />}
            onPress={onSelect}
          />
          <MenuItem label="Reply" icon={(color) => <Icon name="reply" color={color} />} onPress={onReply} />
        </Menu>
      </View>
    </Modal>
  );
}

/** 03 Text selection: the whole message, selectable, in a sheet. */
export function SelectSheet({ text, onClose }: { text?: string; onClose(): void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={text !== undefined}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: c.ground, paddingBottom: insets.bottom }}>
        <View
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 }}
        >
          <Text size="callout" weight="semibold">
            Select Text
          </Text>
          <Text size="callout" weight="medium" color="link" onPress={onClose} accessibilityRole="button">
            Done
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text size="body" lineHeight={25} selectable>
            {text}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}
