import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { forwardRef, type ReactNode, useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextInputProps,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { images } from "./assets";
import { Glass } from "./Glass";
import { Icon } from "./icons";
import { AgentMark, IconButton } from "./primitives";
import { Text } from "./Text";
import { alpha, mix, useTheme } from "./theme";

// ── NavBar ─────────────────────────────────────────────────────────────────────────────────

export interface NavBarProps {
  backdrop?: "clear" | "sky" | "plain";
  title?: string;
  subtitle?: string;
  leading?: ReactNode;
  /** The mark slot; defaults to Poke's mark (lg). */
  mark?: ReactNode;
  trailing?: ReactNode;
  onTitlePress?: () => void;
  /** Top inset (safe area). */
  inset?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Top of the thread: glass search (leading) and side chat (trailing), Poke's mark with a glass
 * name pill. `clear` lets the wallpaper run under it with a progressive blur. Progress never
 * shows here: it lives in the thread.
 */
export function NavBar({
  backdrop = "clear",
  title = "Poke",
  subtitle,
  leading,
  mark,
  trailing,
  onTitlePress,
  inset = 0,
  style,
}: NavBarProps) {
  const t = useTheme();
  const c = t.colors;
  return (
    <View style={[{ paddingTop: inset, paddingBottom: 40 }, style]}>
      {backdrop === "clear" ? (
        <>
          <BlurView
            intensity={18}
            tint={t.name === "dark" ? "dark" : "light"}
            style={[StyleSheet.absoluteFill, { bottom: "38%" }]}
          />
          <LinearGradient
            colors={[c.wash, c.wash, "transparent"]}
            locations={[0, 0.55, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        </>
      ) : backdrop === "plain" ? (
        <LinearGradient
          colors={[
            c.sky,
            mixColor(c.sky, c.ground, 45),
            c.ground,
            alpha(hexOf(c.ground), 0.75),
            alpha(hexOf(c.ground), 0),
          ]}
          locations={[0, 0.45, 0.72, 0.86, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : (
        <>
          <LinearGradient
            colors={[c.ground, c.ground, alpha(hexOf(c.ground), 0.75), alpha(hexOf(c.ground), 0)]}
            locations={[0, 0.74, 0.86, 1]}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <Image
            source={images.wallpapers.coast}
            contentFit="cover"
            contentPosition="top"
            style={[StyleSheet.absoluteFill, { opacity: 0.85 }]}
          />
        </>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 16 }}>
        <View style={{ flex: 1, flexDirection: "row", gap: 8, paddingTop: 4 }}>{leading}</View>
        <Pressable
          onPress={onTitlePress}
          disabled={!onTitlePress}
          accessibilityRole="button"
          accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
          style={{ alignItems: "center" }}
        >
          <View
            style={{
              borderRadius: 44 * 0.24,
              boxShadow: "0px 1px 2px rgba(0,0,0,0.08), 0px 6px 18px rgba(26,31,43,0.16)",
            }}
          >
            {mark ?? <AgentMark size="lg" />}
          </View>
          <Glass dense style={{ marginTop: -6, borderRadius: 999 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 3,
                paddingVertical: 3,
                paddingLeft: 10,
                paddingRight: 9,
              }}
            >
              <Text size="caption" weight="semibold" lineHeight={16}>
                {title}
              </Text>
              <Icon name="chevronRight" size={9} color={c.ink3} strokeWidth={3.6} />
            </View>
          </Glass>
        </Pressable>
        <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          {trailing}
        </View>
      </View>
    </View>
  );
}

/** The palette's ground is a hex in both themes; other entries may be rgba. */
function hexOf(color: string): string {
  return color.startsWith("#") ? color : "#000000";
}
function mixColor(a: string, b: string, p: number): string {
  return a.startsWith("#") && b.startsWith("#") ? mix(a, b, p) : a;
}

/** The standard nav buttons: search (leading) and side chat (trailing). */
export function NavSearchButton({ onPress }: { onPress?: () => void }) {
  return (
    <IconButton
      accessibilityLabel="Search"
      onPress={onPress}
      icon={(color) => <Icon name="search" size={19} color={color} strokeWidth={2} />}
    />
  );
}
export function NavSideChatButton({ onPress }: { onPress?: () => void }) {
  return (
    <IconButton
      accessibilityLabel="Side chat"
      onPress={onPress}
      icon={(color) => <Icon name="sideChat" size={20} color={color} strokeWidth={1.9} />}
    />
  );
}

// ── Composer ───────────────────────────────────────────────────────────────────────────────

export interface ComposerProps extends Omit<TextInputProps, "style" | "onChangeText" | "value"> {
  /** idle = voice, typing = send, working = stop with a sky glow. Derived when omitted. */
  state?: "idle" | "typing" | "working";
  text: string;
  onChangeText: (text: string) => void;
  working?: boolean;
  /** Dictation is on: the mic stays visible and lit, and tapping it stops. */
  dictating?: boolean;
  onPlus?: () => void;
  onMic?: () => void;
  onVoice?: () => void;
  onSend?: () => void;
  onStop?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * The one input, in Liquid Glass: +, a glass field with dictation, and a trailing ink circle.
 * He can still type while Poke works; the circle turns to send as soon as there's text.
 */
export const Composer = forwardRef<TextInputInstance, ComposerProps>(function Composer(
  {
    state,
    text,
    onChangeText,
    working,
    dictating = false,
    onPlus,
    onMic,
    onVoice,
    onSend,
    onStop,
    placeholder = "Add to this…",
    style,
    ...input
  },
  ref,
) {
  const c = useTheme().colors;
  const mode = state ?? (text.trim() ? "typing" : working ? "working" : "idle");
  const glowing = mode === "working" || (working ?? false);
  const flow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!glowing) return;
    const loop = Animated.loop(
      Animated.timing(flow, { toValue: 1, duration: 5000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [glowing, flow]);
  const go = mode === "typing" ? onSend : mode === "working" ? onStop : onVoice;
  return (
    <View style={[{ flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 16 }, style]}>
      <IconButton
        accessibilityLabel="Add"
        onPress={onPlus}
        style={{ transform: [{ scale: 48 / 44 }], marginBottom: 2 }}
        icon={(color) => <Icon name="plus" size={20} color={color} strokeWidth={2} />}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        {glowing && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: -3,
              bottom: -3,
              left: 3,
              right: 3,
              borderRadius: 27,
              opacity: flow.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 0.8, 0.55] }),
              boxShadow: `0px 0px 18px 2px ${c.glow2}, 0px 0px 10px 0px ${c.glow4}`,
              borderWidth: 1.5,
              borderColor: c.glow3,
            }}
          />
        )}
        <Glass interactive style={{ borderRadius: 24 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 4,
              minHeight: 48,
              padding: 6,
              paddingLeft: 18,
            }}
          >
            <TextInput
              ref={ref}
              value={text}
              onChangeText={onChangeText}
              placeholder={placeholder}
              placeholderTextColor={c.ink2}
              multiline
              accessibilityLabel="Message"
              style={{
                flex: 1,
                minWidth: 0,
                paddingVertical: 7,
                maxHeight: 140,
                fontFamily: "OpenRunde-Regular",
                fontSize: 16,
                lineHeight: 22,
                color: c.ink,
              }}
              {...input}
            />
            {(mode !== "typing" || dictating) && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={dictating ? "Stop dictating" : "Dictate"}
                accessibilityState={{ selected: dictating }}
                onPress={onMic}
                style={{ width: 34, height: 36, alignItems: "center", justifyContent: "center" }}
              >
                <Icon
                  name="mic"
                  size={20}
                  color={dictating ? c.red : c.ink2}
                  strokeWidth={dictating ? 2.2 : 1.9}
                />
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mode === "typing" ? "Send" : mode === "working" ? "Stop" : "Talk to Poke"}
              onPress={go}
              style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.92 : 1 }] })}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: "0px 1px 3px rgba(0,0,0,0.12)",
                }}
              >
                <LinearGradient
                  colors={[mix(c.ink, c.white, 82), c.ink]}
                  style={[
                    StyleSheet.absoluteFill,
                    { borderRadius: 18, boxShadow: `inset 0px 0px 0px 1.25px ${mix(c.ink, c.white, 80)}` },
                  ]}
                />
                {mode === "typing" ? (
                  <Icon name="send" size={18} color={c.onInk} strokeWidth={2.6} />
                ) : mode === "working" ? (
                  <Icon name="stop" size={14} color={c.onInk} />
                ) : (
                  <Icon name="waveform" size={18} color={c.onInk} strokeWidth={2.4} />
                )}
              </View>
            </Pressable>
          </View>
        </Glass>
      </View>
    </View>
  );
});
