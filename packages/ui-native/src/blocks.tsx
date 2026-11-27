import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon } from "./icons";
import { Button } from "./primitives";
import { Text } from "./Text";
import { mix, useTheme } from "./theme";

/** Card surface shared by the blocks: card fill, hairline ring, layered shadow. */
export function useCardStyle(): ViewStyle {
  const c = useTheme().colors;
  return {
    backgroundColor: c.card,
    boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}, 0px 3px 8px ${c.shadow}, 0px 8px 28px ${c.shadow}`,
  };
}

/** Label/value rows (the details and known slots). */
export function KvList({
  rows,
  style,
}: {
  rows: { label: string; value: string }[];
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme().colors;
  if (rows.length === 0) return null;
  return (
    <View
      style={[
        { borderRadius: 14, backgroundColor: c.groundGrouped, borderWidth: 1, borderColor: c.separator },
        style,
      ]}
    >
      {rows.map((row, i) => (
        <View
          key={`${row.label}-${i}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            paddingVertical: 10,
            paddingHorizontal: 14,
            ...(i > 0 ? { borderTopWidth: 1, borderTopColor: c.separator } : {}),
          }}
        >
          <Text size="footnote" color="ink2" lineHeight={18}>
            {row.label}
          </Text>
          <Text
            size="footnote"
            weight="medium"
            lineHeight={18}
            align="right"
            style={{ flexShrink: 1 }}
            selectable
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The icon tile used by request blocks (36pt, card fill, hairline). */
export function BlockIcon({ children, size = 36 }: { children?: ReactNode; size?: number }) {
  const c = useTheme().colors;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.card,
        boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}`,
      }}
    >
      {children}
    </View>
  );
}

/** The small ink CTA used inside request blocks ("Save", "Connect", "Allow"). */
export function InkPill({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const c = useTheme().colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: disabled ? 0.35 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] })}
    >
      <View
        style={{
          height: 36,
          paddingHorizontal: 20,
          borderRadius: 13,
          justifyContent: "center",
          boxShadow:
            "inset 0px 1px 0px rgba(255,255,255,0.16), 0px 1px 2px rgba(0,0,0,0.18), 0px 4px 10px rgba(26,31,43,0.16)",
        }}
      >
        <LinearGradient
          colors={[mix(c.ink, "#FFFFFF", 80), c.ink]}
          style={[StyleSheet.absoluteFill, { borderRadius: 13 }]}
        />
        <Text size="subhead" weight="semibold" color="onInk">
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/** A quiet pill ("Paste", "Copy", "Not now"). */
export function QuietPill({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon?: ReactNode;
  onPress?: () => void;
}) {
  const c = useTheme().colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 28,
        paddingHorizontal: 11,
        borderRadius: 999,
        backgroundColor: c.groundGrouped,
        borderWidth: 1,
        borderColor: c.separator,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon}
      <Text size="footnote" weight="medium">
        {label}
      </Text>
    </Pressable>
  );
}

// ── ActionCard ─────────────────────────────────────────────────────────────────────────────

export interface ActionCardProps {
  kind: string;
  title: string;
  body: string;
  details?: ReactNode;
  /** The actions slot: two Buttons. */
  actions?: ReactNode;
}

/** Something Poke wants to do in the world, waiting for his OK. */
export function ActionCard({ kind, title, body, details, actions }: ActionCardProps) {
  const card = useCardStyle();
  return (
    <View style={[card, { padding: 16, borderRadius: 22 }]}>
      <Text size="caption" weight="medium" color="ink3" lineHeight={16} style={{ marginBottom: 6 }}>
        {kind}
      </Text>
      <Text family="display" size="title3" lineHeight={24} tracking={-0.01}>
        {title}
      </Text>
      <Text size="subhead" color="ink2" lineHeight={20} style={{ marginTop: 3 }}>
        {body}
      </Text>
      {details ? <View style={{ marginTop: 12 }}>{details}</View> : null}
      {actions ? <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>{actions}</View> : null}
    </View>
  );
}

// ── Choices ────────────────────────────────────────────────────────────────────────────────

export interface ChoiceProps {
  kind?: "option" | "write";
  n?: string;
  label: string;
  hint?: string;
  onPress?: () => void;
  disabled?: boolean;
}

/** One answer: a ready option, or the "Something else…" row that opens the keyboard. */
export function Choice({ kind = "option", n, label, hint, onPress, disabled }: ChoiceProps) {
  const c = useTheme().colors;
  const write = kind === "write";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hint ? `${label}, ${hint}` : label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 52,
          paddingVertical: 10,
          paddingLeft: 12,
          paddingRight: 14,
          borderRadius: 16,
          opacity: disabled ? 0.5 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        write
          ? { borderWidth: 1, borderColor: c.fill2 }
          : {
              backgroundColor: c.card,
              boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}, 0px 3px 8px ${c.shadow}`,
            },
      ]}
    >
      {!write && (
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.groundGrouped,
            borderWidth: 1,
            borderColor: c.separator,
          }}
        >
          <Text size="footnote" weight="semibold" color="ink2">
            {n}
          </Text>
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="callout"
          weight={write ? "regular" : "medium"}
          color={write ? "ink2" : "ink"}
          lineHeight={21}
        >
          {label}
        </Text>
        {hint ? (
          <Text size="footnote" color="ink2" lineHeight={18}>
            {hint}
          </Text>
        ) : null}
      </View>
      {write ? (
        <Icon name="pencil" size={16} color={c.ink2} strokeWidth={2} />
      ) : (
        <View style={{ transform: [{ rotate: "90deg" }] }}>
          <Icon name="send" size={14} color={c.ink3} strokeWidth={2.4} />
        </View>
      )}
    </Pressable>
  );
}

/** Quick answers to a question Poke asked (the question is the reply text above). */
export function Choices({ children }: { children: ReactNode }) {
  return <View style={{ gap: 8 }}>{children}</View>;
}

// ── Draft ──────────────────────────────────────────────────────────────────────────────────

export interface DraftProps {
  state?: "idle" | "editing";
  kind: string;
  meta?: string;
  body: string;
  /** Editing: the body in place. Called with the new text when he's done. */
  onEdit?: (body: string) => void;
  onCopy?: () => void;
  onStateChange?: (state: "idle" | "editing") => void;
  /** The actions slot ("Send from Gmail"). */
  actions?: ReactNode;
  readOnly?: boolean;
}

/** Writing he'll send on (email, text, post): a paper sheet he can edit in place, with Copy. */
export function Draft({
  state = "idle",
  kind,
  meta,
  body,
  onEdit,
  onCopy,
  onStateChange,
  actions,
  readOnly,
}: DraftProps) {
  const c = useTheme().colors;
  const card = useCardStyle();
  const [text, setText] = useState(body);
  const input = useRef<TextInputInstance>(null);
  useEffect(() => setText(body), [body]);
  useEffect(() => {
    if (state === "editing") input.current?.focus();
  }, [state]);
  const editing = state === "editing";
  const finish = () => {
    onStateChange?.("idle");
    if (text !== body && text.trim()) onEdit?.(text);
  };
  return (
    <View
      style={[
        card,
        { paddingTop: 14, paddingHorizontal: 16, paddingBottom: 16, borderRadius: 20 },
        editing && {
          boxShadow: `0px 0px 0px 2px ${c.glow2}, 0px 1px 2px ${c.shadow}, 0px 8px 28px ${c.shadow}`,
        },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text size="caption" weight="medium" color="ink3" lineHeight={16}>
          {kind}
        </Text>
        <View style={{ marginVertical: -4, marginRight: -6 }}>
          <QuietPill
            label="Copy"
            icon={<Icon name="copy" size={15} color={c.ink} strokeWidth={2} />}
            onPress={onCopy}
          />
        </View>
      </View>
      {meta ? (
        <Text
          size="footnote"
          color="ink2"
          lineHeight={18}
          style={{ marginTop: 8, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: c.separator }}
        >
          {meta}
        </Text>
      ) : null}
      {editing ? (
        <TextInput
          ref={input}
          value={text}
          onChangeText={setText}
          onBlur={finish}
          multiline
          scrollEnabled={false}
          selectionColor={c.link}
          accessibilityLabel={`${kind} text`}
          style={{
            marginTop: 10,
            fontFamily: "OpenRunde-Regular",
            fontSize: 16,
            lineHeight: 23,
            color: c.ink,
            padding: 0,
          }}
        />
      ) : (
        <Pressable
          disabled={readOnly || !onStateChange}
          onPress={() => onStateChange?.("editing")}
          accessibilityHint={readOnly ? undefined : "Edit"}
          style={{ marginTop: 10, gap: 10 }}
        >
          {text.split(/\n{2,}/).map((para, i) => (
            <Text key={i} size="callout" lineHeight={23} selectable>
              {para}
            </Text>
          ))}
        </Pressable>
      )}
      {actions ? <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>{actions}</View> : null}
    </View>
  );
}

// ── SecretRequest ──────────────────────────────────────────────────────────────────────────

export interface SecretRequestProps {
  state?: "pending" | "filled" | "saved" | "expired";
  title: string;
  note: string;
  done?: string;
  field: string;
  placeholder?: string;
  fine?: string;
  cta?: string;
  icon?: ReactNode;
  known?: { label: string; value: string }[];
  /** One-time codes use a number pad and show the digits. */
  secretType?: "password" | "api_key" | "code" | "card" | "text";
  /**
   * Called with the value when he taps Save. The value goes straight to the server's vault
   * endpoint; it is never kept in component state after Save, never logged and never echoed.
   */
  onSave?: (value: string) => Promise<void> | void;
  onPaste?: () => Promise<string | undefined>;
}

/** Poke asks for a secret it needs. It goes straight into the vault; the model never sees it. */
export function SecretRequest({
  state: given = "pending",
  title,
  note,
  done = "Saved to your Vault",
  field,
  placeholder,
  fine = "Poke uses it without seeing it.",
  cta = "Save",
  icon,
  known = [],
  secretType = "password",
  onSave,
  onPaste,
}: SecretRequestProps) {
  const c = useTheme().colors;
  const card = useCardStyle();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state = given === "pending" && value ? "filled" : given;
  const collapsed = state === "saved" || state === "expired";
  const save = async () => {
    if (!value || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave?.(value);
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };
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
        <BlockIcon>{icon ?? <Icon name="key" size={18} color={c.ink2} />}</BlockIcon>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text size="callout" weight="semibold" lineHeight={21}>
            {title}
          </Text>
          {collapsed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              {state === "saved" && <Icon name="check" size={13} color={c.ink2} strokeWidth={3} />}
              <Text size="footnote" color="ink2" lineHeight={18}>
                {state === "saved" ? done : "No longer needed"}
              </Text>
            </View>
          ) : (
            <Text size="footnote" color="ink2" lineHeight={18}>
              {note}
            </Text>
          )}
        </View>
        <Icon name="lock" size={16} color={c.ink3} strokeWidth={2} />
      </View>
      {!collapsed && (
        <>
          {known.length > 0 && <KvList rows={known} style={{ marginTop: 14 }} />}
          <View
            style={{
              marginTop: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 58,
              paddingVertical: 9,
              paddingLeft: 14,
              paddingRight: 10,
              borderRadius: 14,
              backgroundColor: c.card,
              ...(state === "filled"
                ? { boxShadow: `0px 0px 0px 2px ${c.glow2}` }
                : { borderWidth: 1, borderColor: c.fill2 }),
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size="caption" color="ink3" lineHeight={16}>
                {field}
              </Text>
              <TextInput
                value={value}
                onChangeText={setValue}
                placeholder={placeholder}
                placeholderTextColor={c.ink3}
                secureTextEntry={secretType !== "code" && secretType !== "text"}
                keyboardType={
                  secretType === "code" ? "number-pad" : secretType === "card" ? "number-pad" : "default"
                }
                textContentType={
                  secretType === "code" ? "oneTimeCode" : secretType === "password" ? "password" : "none"
                }
                autoComplete={
                  secretType === "code"
                    ? "one-time-code"
                    : secretType === "password"
                      ? "current-password"
                      : "off"
                }
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                contextMenuHidden={false}
                importantForAutofill="yes"
                selectionColor={c.link}
                accessibilityLabel={field}
                onSubmitEditing={save}
                editable={!busy}
                style={{
                  fontFamily: "OpenRunde-Regular",
                  fontSize: 16,
                  lineHeight: 22,
                  color: c.ink,
                  padding: 0,
                }}
              />
            </View>
            {!value && onPaste && (
              <QuietPill
                label="Paste"
                onPress={async () => {
                  const pasted = await onPaste();
                  if (pasted) setValue(pasted.trim());
                }}
              />
            )}
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 12,
              paddingLeft: 2,
            }}
          >
            <Text size="caption" color={error ? "red" : "ink3"} lineHeight={16} style={{ flex: 1 }}>
              {error ?? fine}
            </Text>
            <InkPill label={cta} disabled={!value} busy={busy} onPress={save} />
          </View>
        </>
      )}
    </View>
  );
}

export { Button };
