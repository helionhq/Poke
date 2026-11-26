import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "./icons";
import { Text, type TextProps } from "./Text";
import { useTheme } from "./theme";

/** The running shimmer: a slow sweep of the label from ink towards ink-3 and back. */
export function Shimmer(props: TextProps) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 1,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 0,
          duration: 1100,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      style={{ opacity: v.interpolate({ inputRange: [0, 1], outputRange: [1, 0.42] }), flexShrink: 1 }}
    >
      <Text color="ink" {...props} />
    </Animated.View>
  );
}

function Spinner({ size, radius }: { size: number; radius: number }) {
  const c = useTheme().colors;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: -3,
        left: -3,
        width: size + 6,
        height: size + 6,
        borderRadius: radius,
        borderWidth: 1.5,
        borderColor: "transparent",
        borderTopColor: c.glow3,
        borderRightColor: c.glow3,
        transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }],
      }}
    />
  );
}

/** A tool glyph: a logo image (uri or module) or an icon element. */
export type ToolGlyph = ReactNode;

export function LogoImage({
  source,
  size = 13,
  radius = 0,
}: {
  source: string | number;
  size?: number;
  radius?: number;
}) {
  return (
    <Image
      source={typeof source === "string" ? { uri: source } : source}
      style={{ width: size, height: size, borderRadius: radius }}
      contentFit="contain"
    />
  );
}

// ── Step ───────────────────────────────────────────────────────────────────────────────────

export interface StepProps {
  state?: "done" | "running";
  label: string;
  detail?: string;
  icon?: ToolGlyph;
  /** Whether a rail runs down to the next step (false on the last one). */
  rail?: boolean;
}

/** One tool call, written as it happens. There is no pending state: Poke never lists future steps. */
export function Step({ state = "done", label, detail, icon, rail = true }: StepProps) {
  const c = useTheme().colors;
  return (
    <View style={{ flexDirection: "row", gap: 11, alignItems: "flex-start" }}>
      <View style={{ width: 22, alignItems: "center", alignSelf: "stretch" }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.card,
            boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}`,
          }}
        >
          {icon ?? <Icon name="bolt" size={13} color={c.ink2} strokeWidth={2.2} />}
          {state === "running" && <Spinner size={22} radius={9} />}
        </View>
        {rail && (
          <View
            style={{ width: 1, flex: 1, marginTop: 4, marginBottom: -10, backgroundColor: c.separator }}
          />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
        {state === "running" ? (
          <Shimmer size="subhead" lineHeight={20}>
            {label}
          </Shimmer>
        ) : (
          <Text size="subhead" color="ink2" lineHeight={20}>
            {label}
          </Text>
        )}
        {detail ? (
          <Text size="footnote" color="ink3" lineHeight={18} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Trace ──────────────────────────────────────────────────────────────────────────────────

export interface TraceProps {
  state?: "collapsed" | "expanded" | "running";
  title: string;
  meta?: string;
  mark?: ToolGlyph;
  /** The steps slot: rendered when expanded. */
  steps?: ReactNode;
  onToggle?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * A reply's tool activity, collapsed by default. running = one live line that rewrites itself;
 * done = "Used 3 tools · Calendar, Maps, Resy ›", which expands into the calls in order.
 */
export function Trace({ state = "collapsed", title, meta, mark, steps, onToggle, style }: TraceProps) {
  const c = useTheme().colors;
  const rotate = useRef(new Animated.Value(state === "expanded" ? 1 : 0)).current;
  useEffect(() => {
    Animated.spring(rotate, {
      toValue: state === "expanded" ? 1 : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 16,
    }).start();
  }, [state, rotate]);
  return (
    <View style={style}>
      <Pressable
        onPress={onToggle}
        disabled={state === "running" || !onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: state === "expanded" }}
        accessibilityLabel={meta ? `${title}, ${meta}` : title}
        style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 }}
      >
        {mark ? (
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.card,
              boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}`,
            }}
          >
            {mark}
          </View>
        ) : null}
        {state === "running" ? (
          <Shimmer size="subhead" lineHeight={20} numberOfLines={1}>
            {title}
          </Shimmer>
        ) : (
          <>
            <Text size="subhead" color="ink2" lineHeight={20} numberOfLines={1} style={{ flexShrink: 0 }}>
              {title}
            </Text>
            {meta ? (
              <Text
                size="subhead"
                color="ink3"
                lineHeight={20}
                numberOfLines={1}
                style={{ flexShrink: 1, marginLeft: -4 }}
              >
                {`· ${meta}`}
              </Text>
            ) : null}
            <Animated.View
              style={{
                marginLeft: -3,
                transform: [
                  { rotate: rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) },
                ],
              }}
            >
              <Icon name="chevronRight" size={12} color={c.ink3} strokeWidth={2.8} />
            </Animated.View>
          </>
        )}
      </Pressable>
      {state === "expanded" && steps ? (
        <View style={{ gap: 10, marginTop: 12, marginBottom: 2 }}>{steps}</View>
      ) : null}
    </View>
  );
}

// ── MessageActions ─────────────────────────────────────────────────────────────────────────

export interface MessageActionsProps {
  meta: string;
  onCopy?: () => void;
  onSpeak?: () => void;
  speaking?: boolean;
}

/** Under the latest reply only: copy, read aloud and the time. No retry, no ratings. */
export function MessageActions({ meta, onCopy, onSpeak, speaking }: MessageActionsProps) {
  const c = useTheme().colors;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const btn = {
    width: 34,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  } as const;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginLeft: -9 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy"
        style={btn}
        onPress={() => {
          onCopy?.();
          setCopied(true);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={17} color={c.ink3} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={speaking ? "Stop reading" : "Read aloud"}
        style={btn}
        onPress={onSpeak}
      >
        <Icon name={speaking ? "stop" : "speaker"} size={17} color={speaking ? c.ink2 : c.ink3} />
      </Pressable>
      <Text size="caption" color="ink3" style={{ marginLeft: 6 }}>
        {meta}
      </Text>
    </View>
  );
}

// ── MemoryNote ─────────────────────────────────────────────────────────────────────────────

export interface MemoryNoteProps {
  text: string;
  action?: string;
  onAction?: () => void;
}

/** Inline receipt when Poke saves something to memory, with an undo. */
export function MemoryNote({ text, action = "Undo", onAction }: MemoryNoteProps) {
  const c = useTheme().colors;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        paddingVertical: 7,
        paddingLeft: 10,
        paddingRight: 12,
        borderRadius: 999,
        backgroundColor: c.fill,
        maxWidth: "100%",
      }}
    >
      <Icon name="memory" size={15} color={c.ink2} strokeWidth={2} />
      <Text size="footnote" color="ink2" lineHeight={16} style={{ flexShrink: 1 }} numberOfLines={2}>
        <Text size="footnote" weight="semibold" lineHeight={16}>
          Remembered
        </Text>{" "}
        {text}
      </Text>
      {onAction ? (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          hitSlop={8}
          style={{ paddingLeft: 9, marginLeft: 2, borderLeftWidth: 1, borderLeftColor: c.separator }}
        >
          <Text size="footnote" weight="semibold" lineHeight={16}>
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ── Menu ───────────────────────────────────────────────────────────────────────────────────

export interface MenuItemProps {
  tone?: "default" | "destructive";
  edge?: "line" | "gap" | "none";
  label: string;
  icon?: ReactNode | ((color: string) => ReactNode);
  onPress?: () => void;
}

/** One row in a glass context menu. */
export function MenuItem({ tone = "default", edge = "line", label, icon, onPress }: MenuItemProps) {
  const c = useTheme().colors;
  const color = tone === "destructive" ? c.red : c.ink2;
  return (
    <Pressable
      accessibilityRole="menuitem"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        minHeight: 44,
        paddingVertical: 11,
        paddingHorizontal: 16,
        borderTopWidth: edge === "gap" ? 6 : edge === "line" ? 1 : 0,
        borderTopColor: edge === "gap" ? c.fill : c.separator,
        backgroundColor: pressed ? c.fill : "transparent",
      })}
    >
      <Text size="callout" lineHeight={22} color={tone === "destructive" ? "red" : "ink"}>
        {label}
      </Text>
      <View style={{ width: 22, alignItems: "center" }}>
        {typeof icon === "function" ? icon(color) : icon}
      </View>
    </Pressable>
  );
}

/** Liquid Glass context menu: long-press on a message, and the + menu. */
export function Menu({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const c = t.colors;
  return (
    <View
      accessibilityRole="menu"
      style={[
        {
          width: 250,
          borderRadius: 24,
          overflow: "hidden",
          boxShadow: `inset 0px 1px 0px ${c.glassEdge}, inset 0px -1px 0px ${c.glassLine}, 0px 2px 6px rgba(0,0,0,0.05), 0px 18px 50px -10px rgba(0,0,0,0.18)`,
        },
        style,
      ]}
    >
      <MenuBackdrop />
      {children}
    </View>
  );
}

function MenuBackdrop() {
  const t = useTheme();
  return (
    <>
      <BlurView
        intensity={70}
        tint={t.name === "dark" ? "systemThickMaterialDark" : "systemThickMaterialLight"}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: t.name === "dark" ? "rgba(11,11,12,0.52)" : "rgba(255,253,250,0.52)",
        }}
      />
    </>
  );
}
