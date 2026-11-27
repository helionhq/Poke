import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import type { WallpaperScene } from "@poke/ui-tokens";
import { type ReactNode, useEffect, useRef } from "react";
import {
  Animated,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Glass } from "./Glass";
import { Text } from "./Text";
import { mix, useTheme } from "./theme";
import { images } from "./assets";

const press = (pressed: boolean, scale: number) => (pressed ? { transform: [{ scale }] } : null);

/** The dark "Get Started" gradient used by ink buttons. */
function InkFill({ radius }: { radius: number }) {
  const c = useTheme().colors;
  return (
    <LinearGradient
      colors={[mix(c.ink, c.white, 82), c.ink]}
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: radius,
          boxShadow: `inset 0px 0px 0px 1.25px ${mix(c.ink, c.white, 80)}, inset 0px 0px 10px rgba(255,255,255,0.1)`,
        },
      ]}
    />
  );
}

// ── IconButton ─────────────────────────────────────────────────────────────────────────────

export interface IconButtonProps extends Omit<PressableProps, "children" | "style"> {
  tone?: "glass" | "ink" | "fill" | "plain" | "danger";
  size?: "regular" | "small" | "large";
  /** The icon slot: render with `useIconColor()`'s colour, or pass a function of it. */
  icon: ReactNode | ((color: string) => ReactNode);
  style?: StyleProp<ViewStyle>;
}

const iconSizes = { regular: 44, small: 30, large: 64 } as const;

/** Round icon control. glass for floating controls, ink for send/stop/end call. */
export function IconButton({ tone = "glass", size = "regular", icon, style, ...rest }: IconButtonProps) {
  const c = useTheme().colors;
  const d = iconSizes[size];
  const color = tone === "ink" ? c.onInk : tone === "plain" ? c.ink2 : tone === "danger" ? c.white : c.ink;
  const body = typeof icon === "function" ? icon(color) : icon;
  const base: ViewStyle = {
    width: d,
    height: d,
    borderRadius: d / 2,
    alignItems: "center",
    justifyContent: "center",
  };
  return (
    <Pressable accessibilityRole="button" {...rest} style={({ pressed }) => [press(pressed, 0.92), style]}>
      {tone === "glass" ? (
        <Glass interactive style={base}>
          {body}
        </Glass>
      ) : (
        <View
          style={[
            base,
            tone === "fill" && { backgroundColor: c.fill },
            tone === "danger" && { backgroundColor: c.red },
            tone === "ink" && { boxShadow: "0px 1px 3px rgba(0,0,0,0.12), 0px 4px 12px rgba(0,0,0,0.08)" },
          ]}
        >
          {tone === "ink" && <InkFill radius={d / 2} />}
          {body}
        </View>
      )}
    </Pressable>
  );
}

// ── Button ─────────────────────────────────────────────────────────────────────────────────

export interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  tone?: "ink" | "fill" | "plain" | "glass" | "danger";
  size?: "regular" | "medium" | "small";
  width?: "hug" | "fill";
  label: string;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

const buttonSizes = {
  regular: { height: 48, padding: 24, font: "callout", radius: 13 },
  medium: { height: 42, padding: 18, font: "subhead", radius: 13 },
  small: { height: 32, padding: 12, font: "footnote", radius: 10 },
} as const;

/** poke.com's button: a soft rectangle. */
export function Button({
  tone = "ink",
  size = "regular",
  width = "hug",
  label,
  icon,
  style,
  disabled,
  ...rest
}: ButtonProps) {
  const c = useTheme().colors;
  const s = buttonSizes[size];
  const textColor = tone === "ink" ? "onInk" : tone === "danger" ? "red" : "ink";
  const frame: ViewStyle = {
    height: s.height,
    paddingHorizontal: s.padding,
    borderRadius: s.radius,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    ...(width === "fill" ? { alignSelf: "stretch" } : { alignSelf: "flex-start" }),
  };
  const label_ = (
    <>
      {icon}
      <Text size={s.font} weight="medium" color={textColor} tracking={-0.005} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      {...rest}
      style={({ pressed }) => [
        press(pressed, 0.97),
        disabled && { opacity: 0.45 },
        width === "fill" && { alignSelf: "stretch" },
        style,
      ]}
    >
      {tone === "glass" ? (
        <Glass style={frame}>{label_}</Glass>
      ) : (
        <View
          style={[
            frame,
            tone === "ink" && {
              boxShadow:
                "0px 0.5px 1px rgba(0,0,0,0.08), 0px 1px 3px rgba(0,0,0,0.1), 0px 4px 12px rgba(0,0,0,0.08)",
            },
            (tone === "fill" || tone === "danger") && {
              backgroundColor: c.card,
              boxShadow:
                tone === "fill"
                  ? `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}, 0px 3px 8px ${c.shadow}`
                  : `0px 0px 0px 1px ${c.separator}`,
            },
          ]}
        >
          {tone === "ink" && <InkFill radius={s.radius} />}
          {label_}
        </View>
      )}
    </Pressable>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────────────────

export interface ChipProps extends Omit<PressableProps, "children" | "style"> {
  state?: "default" | "selected" | "outline" | "glass";
  label: string;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Pill chip (filters, tags). */
export function Chip({ state = "default", label, icon, style, ...rest }: ChipProps) {
  const c = useTheme().colors;
  const frame: ViewStyle = {
    height: 32,
    paddingHorizontal: 13,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  };
  const content = (
    <>
      {icon ? <View style={{ marginLeft: -2 }}>{icon}</View> : null}
      <Text size="footnote" weight="medium" color={state === "selected" ? "onInk" : "ink"} numberOfLines={1}>
        {label}
      </Text>
    </>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: state === "selected" }}
      {...rest}
      style={style}
    >
      {state === "glass" ? (
        <Glass style={frame}>{content}</Glass>
      ) : (
        <View
          style={[
            frame,
            state === "default" && {
              backgroundColor: c.card,
              boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}`,
            },
            state === "selected" && { backgroundColor: c.ink, boxShadow: "0px 1px 3px rgba(0,0,0,0.12)" },
            state === "outline" && { borderWidth: 1, borderColor: c.separator },
          ]}
        >
          {content}
        </View>
      )}
    </Pressable>
  );
}

// ── AgentMark ──────────────────────────────────────────────────────────────────────────────

const markSizes = { xs: 18, sm: 22, md: 32, lg: 44, xl: 64 } as const;

export interface AgentMarkProps {
  size?: keyof typeof markSizes;
  state?: "idle" | "active";
  style?: StyleProp<ViewStyle>;
}

/** Poke's mark: the palm on sky tile. `active` breathes a soft sky halo while Poke works. */
export function AgentMark({ size = "sm", state = "idle", style }: AgentMarkProps) {
  const c = useTheme().colors;
  const d = markSizes[size];
  const breathe = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state !== "active") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, breathe]);
  return (
    <View
      accessibilityLabel="Poke"
      style={[
        {
          width: d,
          height: d,
          borderRadius: d * 0.24,
          boxShadow:
            size === "xl"
              ? `0px 0px 0px 0.5px ${c.glassLine}, 0px 10px 30px -10px ${c.glow3}`
              : `0px 0px 0px 0.5px ${c.glassLine}`,
        },
        style,
      ]}
    >
      {state === "active" && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -4,
            left: -4,
            right: -4,
            bottom: -4,
            borderRadius: (d + 8) * 0.3,
            boxShadow: `0px 0px 0px 2px ${c.glow2}, 0px 0px 14px 2px ${c.glow1}`,
            opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 0.35] }),
            transform: [{ scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }],
          }}
        />
      )}
      <Image
        source={images.agentMark}
        style={{ width: d, height: d, borderRadius: d * 0.24 }}
        contentFit="cover"
      />
    </View>
  );
}

// ── DayDivider ─────────────────────────────────────────────────────────────────────────────

/** Centered day + time: placed at each new day or after a long gap. */
export function DayDivider({ day, time }: { day: string; time: string }) {
  return (
    <View
      style={{ flexDirection: "row", justifyContent: "center", gap: 4, paddingVertical: 4 }}
      accessibilityRole="header"
    >
      <Text size="caption" weight="medium" color="ink2" lineHeight={16}>
        {day}
      </Text>
      <Text size="caption" weight="medium" color="ink3" lineHeight={16}>
        {time}
      </Text>
    </View>
  );
}

// ── UserMessage ────────────────────────────────────────────────────────────────────────────

export interface UserMessageProps {
  text: string;
  attachment?: ReactNode;
  /** A quoted message this one replies to. */
  quote?: ReactNode;
}

/** His message: the slate bubble, right-aligned. Poke's replies are never bubbles. */
export function UserMessage({ text, attachment, quote }: UserMessageProps) {
  const c = useTheme().colors;
  return (
    <View style={{ alignItems: "flex-end", gap: 4, paddingLeft: 64 }}>
      {attachment ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>{attachment}</View>
      ) : null}
      {quote}
      {text ? (
        <View
          style={{
            backgroundColor: c.bubble,
            paddingTop: 9,
            paddingBottom: 10,
            paddingHorizontal: 14,
            borderRadius: 20,
          }}
        >
          <Text size="callout" color="onBubble" lineHeight={21} tracking={-0.005} selectable>
            {text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Wallpaper & Grain ──────────────────────────────────────────────────────────────────────

/** The thread's wallpaper with its paper wash (night in dark mode). Place first, behind everything. */
export function Wallpaper({ scene = "haze" }: { scene?: WallpaperScene }) {
  const c = useTheme().colors;
  const fit =
    scene === "haze"
      ? { contentPosition: { left: "62%", top: "50%" } as const, scale: 1.15, blur: 0 }
      : scene === "dunes"
        ? { contentPosition: { left: "50%", top: "40%" } as const, scale: 1, blur: 0 }
        : { contentPosition: { left: "70%", top: "50%" } as const, scale: 1.04, blur: 2 };
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: c.ground, overflow: "hidden" }]}
    >
      <Image
        source={images.wallpapers[scene]}
        contentFit="cover"
        contentPosition={fit.contentPosition}
        blurRadius={fit.blur}
        style={[StyleSheet.absoluteFill, { transform: [{ scale: fit.scale }] }]}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.wash }]} />
    </View>
  );
}

/** poke.com's film grain over the whole screen (4%, difference blend). Place last. */
export function Grain() {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { opacity: 0.04, mixBlendMode: "difference" }]}
    >
      <Image source={images.grain} contentFit="none" style={StyleSheet.absoluteFill} />
    </View>
  );
}
