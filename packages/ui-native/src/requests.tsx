import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View } from "react-native";
import { BlockIcon, KvList, useCardStyle } from "./blocks";
import { Icon } from "./icons";
import { Text } from "./Text";
import { alpha, mix, useTheme } from "./theme";

function InkButton({
  label,
  onPress,
  busy,
  waiting,
}: {
  label: string;
  onPress?: () => void;
  busy?: boolean;
  waiting?: string;
}) {
  const c = useTheme().colors;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!busy) return;
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, spin]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={busy ? (waiting ?? label) : label}
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
        opacity: busy ? 0.8 : 1,
      })}
    >
      <View
        style={{
          height: 44,
          borderRadius: 13,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          boxShadow:
            "inset 0px 1px 0px rgba(255,255,255,0.16), 0px 1px 2px rgba(0,0,0,0.18), 0px 4px 10px rgba(26,31,43,0.16)",
        }}
      >
        <LinearGradient
          colors={[mix(c.ink, "#FFFFFF", 80), c.ink]}
          style={[StyleSheet.absoluteFill, { borderRadius: 13 }]}
        />
        {busy && (
          <Animated.View
            style={{
              width: 15,
              height: 15,
              borderRadius: 8,
              borderWidth: 2,
              borderColor: alpha(c.onInk, 0.35),
              borderTopColor: c.onInk,
              transform: [
                { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) },
              ],
            }}
          />
        )}
        <Text size="callout" weight="semibold" color="onInk">
          {busy ? (waiting ?? label) : label}
        </Text>
      </View>
    </Pressable>
  );
}

function PlainButton({ label, onPress, flex }: { label: string; onPress?: () => void; flex?: boolean }) {
  const c = useTheme().colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        ...(flex ? { flex: 1 } : { paddingHorizontal: 16 }),
        height: 44,
        borderRadius: 13,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: flex ? c.card : c.groundGrouped,
        borderWidth: 1,
        borderColor: flex ? c.fill2 : c.separator,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Text size="callout" weight={flex ? "semibold" : "medium"} color={flex ? "ink" : "ink2"}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── ConnectRequest ─────────────────────────────────────────────────────────────────────────

export interface ConnectRequestProps {
  kind?: "app" | "custom";
  state?: "pending" | "connecting" | "connected" | "dismissed" | "expired";
  title: string;
  note: string;
  done?: string;
  source?: string;
  cta?: string;
  waiting?: string;
  icon?: ReactNode;
  caps?: string[];
  /** The last sign-in didn't finish. */
  error?: string;
  onConnect?: () => void;
  onDismiss?: () => void;
}

/** Poke asks to connect an app it needs; one tap, without leaving the thread. */
export function ConnectRequest({
  kind = "app",
  state = "pending",
  title,
  note,
  done = "Connected",
  source,
  cta = "Connect",
  waiting = "Finishing sign-in…",
  icon,
  caps = [],
  error,
  onConnect,
  onDismiss,
}: ConnectRequestProps) {
  const c = useTheme().colors;
  const card = useCardStyle();
  const collapsed = state === "connected" || state === "dismissed" || state === "expired";
  const doneText = state === "connected" ? done : state === "dismissed" ? "Not now" : "No longer needed";
  return (
    <View
      style={[
        card,
        collapsed
          ? { paddingVertical: 12, paddingLeft: 12, paddingRight: 14, borderRadius: 18 }
          : { padding: 14, borderRadius: 20 },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 2 }}>
        <BlockIcon size={collapsed ? 36 : 40}>
          {icon ?? <Icon name="apps" size={20} color={c.ink2} />}
        </BlockIcon>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size="callout" weight="semibold" lineHeight={21}>
            {title}
          </Text>
          {collapsed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {state === "connected" && <Icon name="check" size={13} color={c.ink2} strokeWidth={3} />}
              <Text size="footnote" color="ink2" lineHeight={18}>
                {doneText}
              </Text>
            </View>
          ) : (
            <Text size="footnote" color="ink2" lineHeight={18}>
              {note}
            </Text>
          )}
        </View>
      </View>
      {!collapsed && (
        <>
          {kind === "custom" && source ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                marginTop: 12,
                marginHorizontal: 2,
              }}
            >
              <Icon name="sparkles" size={13} color={c.ink3} strokeWidth={2} />
              <Text size="caption" color="ink2" lineHeight={16} style={{ flexShrink: 1 }}>
                {source}
              </Text>
            </View>
          ) : null}
          {caps.length > 0 && (
            <View
              style={{
                marginTop: 12,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 14,
                backgroundColor: c.groundGrouped,
                borderWidth: 1,
                borderColor: c.separator,
                gap: 6,
              }}
            >
              {caps.map((cap, i) => (
                <View key={i} style={{ flexDirection: "row", gap: 9 }}>
                  <View
                    style={{ width: 5, height: 5, borderRadius: 3, marginTop: 7, backgroundColor: c.ink3 }}
                  />
                  <Text size="footnote" color="ink2" lineHeight={18} style={{ flex: 1 }}>
                    {cap}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {error ? (
            <Text size="footnote" color="red" lineHeight={18} style={{ marginTop: 10, marginHorizontal: 2 }}>
              {error}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <InkButton label={cta} waiting={waiting} busy={state === "connecting"} onPress={onConnect} />
            {state !== "connecting" && <PlainButton label="Not now" onPress={onDismiss} />}
          </View>
        </>
      )}
    </View>
  );
}

// ── ToolApproval ───────────────────────────────────────────────────────────────────────────

export interface ToolApprovalProps {
  state?: "pending" | "allowed" | "denied" | "expired";
  app: string;
  tool: string;
  action: string;
  reason?: string;
  cta?: string;
  always?: string;
  result?: string;
  icon?: ReactNode;
  details?: { label: string; value: string }[];
  onAllow?: (always: boolean) => void;
  onDeny?: () => void;
}

/** A connected tool needs his OK before it runs. */
export function ToolApproval({
  state = "pending",
  app,
  tool,
  action,
  reason,
  cta = "Allow",
  always,
  result,
  icon,
  details = [],
  onAllow,
  onDeny,
}: ToolApprovalProps) {
  const c = useTheme().colors;
  const card = useCardStyle();
  const header = (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.separator,
        }}
      >
        {icon ?? (
          <Text size={13} weight="semibold">
            {app.slice(0, 1).toUpperCase()}
          </Text>
        )}
      </View>
      <Text size="footnote" weight="semibold" lineHeight={18}>
        {app}
      </Text>
      <Text family="mono" size={12} color="ink3" lineHeight={18} numberOfLines={1} style={{ flexShrink: 1 }}>
        {tool}
      </Text>
    </View>
  );
  if (state !== "pending") {
    const ok = state === "allowed";
    return (
      <View
        style={[
          card,
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 18,
          },
        ]}
      >
        {header}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          {state !== "expired" && (
            <Icon name={ok ? "check" : "close"} size={ok ? 13 : 12} color={c.ink2} strokeWidth={3} />
          )}
          <Text size="footnote" color="ink2" lineHeight={18}>
            {result ?? (ok ? "Allowed" : state === "denied" ? "Denied" : "Expired")}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={[card, { padding: 14, borderRadius: 20 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 }}>
        {header}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            height: 22,
            paddingLeft: 7,
            paddingRight: 8,
            borderRadius: 999,
            backgroundColor: c.glow4,
          }}
        >
          <Icon name="shield" size={12} color="#1A1F2B" strokeWidth={2.4} />
          <Text size="caption" weight="semibold" style={{ color: "#1A1F2B" }}>
            Needs OK
          </Text>
        </View>
      </View>
      <Text
        family="display"
        size={21}
        lineHeight={26}
        tracking={-0.005}
        style={{ marginTop: 12, marginHorizontal: 2 }}
      >
        {action}
      </Text>
      {details.length > 0 && <KvList rows={details} style={{ marginTop: 12 }} />}
      {reason ? (
        <Text size="footnote" color="ink2" lineHeight={18} style={{ marginTop: 10, marginHorizontal: 2 }}>
          {reason}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
        <PlainButton flex label="Deny" onPress={onDeny} />
        <InkButton label={cta} onPress={() => onAllow?.(false)} />
      </View>
      {always ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onAllow?.(true)}
          hitSlop={8}
          style={{ marginTop: 10 }}
        >
          <Text size="footnote" weight="medium" color="ink2" lineHeight={18} align="center">
            {always}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
