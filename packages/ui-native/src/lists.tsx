import { type ColorName } from "@poke/ui-tokens";
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode, cloneElement } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "./icons";
import { Text } from "./Text";
import { useTheme } from "./theme";

// ── ListRow ────────────────────────────────────────────────────────────────────────────────

export type ListTile =
  | "paper"
  | "logo"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "gray"
  | "ink"
  | "none";

export interface ListRowProps {
  tile?: ListTile;
  accessory?: "chevron" | "toggle-on" | "toggle-off" | "check" | "connect" | "none";
  title: string;
  subtitle?: string;
  value?: string;
  /** The icon slot. A function gets the tile's foreground colour. */
  icon?: ReactNode | ((color: string) => ReactNode);
  onPress?: () => void;
  /** Toggle rows: called with the new value. With `onPress` too, the row opens and only the switch toggles. */
  onToggle?: (on: boolean) => void;
  onConnect?: () => void;
  /** Set by ListGroup on its last row. */
  last?: boolean;
  disabled?: boolean;
  destructive?: boolean;
}

/** Grouped list row. Toggles are Poke ink, not iOS green. */
export function ListRow({
  tile = "paper",
  accessory = "chevron",
  title,
  subtitle,
  value,
  icon,
  onPress,
  onToggle,
  onConnect,
  last,
  disabled,
  destructive,
}: ListRowProps) {
  const c = useTheme().colors;
  const fg = tile === "paper" || tile === "logo" ? c.ink : tile === "ink" ? c.onInk : c.white;
  const tileBg =
    tile === "paper"
      ? c.groundGrouped
      : tile === "logo"
        ? c.card
        : tile === "ink"
          ? c.ink
          : tile === "none"
            ? "transparent"
            : c[tile as ColorName];
  const toggle = accessory === "toggle-on" || accessory === "toggle-off";
  const on = accessory === "toggle-on";
  const split = toggle && !!onPress;
  const press = toggle && !split ? () => onToggle?.(!on) : onPress;
  return (
    <Pressable
      onPress={press}
      disabled={disabled || (!press && !onConnect)}
      accessibilityRole={toggle && !split ? "switch" : "button"}
      accessibilityState={
        toggle && !split ? { checked: on, disabled } : { disabled, selected: accessory === "check" }
      }
      accessibilityLabel={[title, subtitle, value].filter(Boolean).join(", ")}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 13,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 16,
        backgroundColor: pressed && (!toggle || split) ? c.fill : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {tile !== "none" && (
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            backgroundColor: tileBg,
            padding: tile === "logo" ? 5 : 0,
            ...(tile === "paper" || tile === "logo" ? { borderWidth: 1, borderColor: c.separator } : {}),
          }}
        >
          {typeof icon === "function" ? icon(fg) : icon}
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="callout"
          weight="medium"
          lineHeight={21}
          color={destructive ? "red" : "ink"}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text size="footnote" color="ink2" lineHeight={18} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text size="callout" color="ink2" numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory === "chevron" && <Icon name="chevronRight" size={14} color={c.ink3} strokeWidth={2.8} />}
      {accessory === "check" && <Icon name="check" size={18} color={c.ink} strokeWidth={2.6} />}
      {toggle &&
        (split ? (
          <Pressable
            accessibilityRole="switch"
            accessibilityLabel={title}
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            hitSlop={8}
            onPress={() => onToggle?.(!on)}
          >
            <Toggle on={on} />
          </Pressable>
        ) : (
          <Toggle on={on} />
        ))}
      {accessory === "connect" && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Connect ${title}`}
          onPress={onConnect ?? onPress}
          style={{
            height: 30,
            paddingHorizontal: 13,
            borderRadius: 999,
            justifyContent: "center",
            backgroundColor: c.groundGrouped,
            borderWidth: 1,
            borderColor: c.separator,
          }}
        >
          <Text size="footnote" weight="semibold" lineHeight={16}>
            Connect
          </Text>
        </Pressable>
      )}
      {!last && (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: tile === "none" ? 16 : 59,
            right: 0,
            bottom: 0,
            height: 1,
            backgroundColor: c.separator,
          }}
        />
      )}
    </Pressable>
  );
}

function Toggle({ on }: { on: boolean }) {
  const c = useTheme().colors;
  return (
    <View style={{ width: 48, height: 29, borderRadius: 999, backgroundColor: on ? c.ink : c.fill2 }}>
      <View
        style={{
          position: "absolute",
          top: 2,
          left: on ? 21 : 2,
          width: 25,
          height: 25,
          borderRadius: 13,
          backgroundColor: c.white,
          boxShadow: "0px 2px 6px rgba(0,0,0,0.15), 0px 1px 1px rgba(0,0,0,0.06)",
        }}
      />
    </View>
  );
}

// ── ListGroup ──────────────────────────────────────────────────────────────────────────────

export interface ListGroupProps {
  header?: string;
  footer?: string;
  /** The rows slot: ListRows (the last one loses its separator). */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Inset grouped section: header, rows, footer. */
export function ListGroup({ header, footer, children, style }: ListGroupProps) {
  const c = useTheme().colors;
  const rows = flatten(children);
  return (
    <View style={[{ paddingHorizontal: 16 }, style]}>
      {header ? (
        <Text
          size="footnote"
          weight="medium"
          color="ink2"
          lineHeight={18}
          style={{ paddingHorizontal: 4, paddingBottom: 8 }}
        >
          {header}
        </Text>
      ) : null}
      {rows.length > 0 && (
        <View
          style={{
            backgroundColor: c.card,
            borderRadius: 20,
            overflow: "hidden",
            boxShadow: `0px 0px 0px 1px ${c.separator}, 0px 1px 2px ${c.shadow}, 0px 3px 8px ${c.shadow}`,
          }}
        >
          {rows.map((row, i) =>
            i === rows.length - 1 && isValidElement(row) && row.type === ListRow
              ? cloneElement(row as ReactElement<ListRowProps>, { last: true })
              : row,
          )}
        </View>
      )}
      {footer ? (
        <Text size="footnote" color="ink3" lineHeight={18} style={{ paddingHorizontal: 4, paddingTop: 8 }}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

function flatten(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment)
      out.push(...flatten(child.props.children));
    else if (child !== null && child !== undefined && child !== false) out.push(child);
  });
  return out;
}

// ── SearchResult ───────────────────────────────────────────────────────────────────────────

export interface SearchResultProps {
  who: string;
  when: string;
  /** The snippet: «marked» spans are highlighted, else `match` wherever it appears. */
  snippet: string;
  match?: string;
  onPress?: () => void;
}

/** One hit when searching the thread. Tapping jumps to that moment. */
export function SearchResult({ who, when, snippet, match, onPress }: SearchResultProps) {
  const c = useTheme().colors;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingTop: 12,
        paddingBottom: 13,
        borderBottomWidth: 1,
        borderBottomColor: c.separator,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <Text size="footnote" weight="semibold" lineHeight={18}>
          {who}
        </Text>
        <Text size="footnote" color="ink3" lineHeight={18} style={{ flex: 1 }}>
          {when}
        </Text>
        <Icon name="chevronRight" size={12} color={c.ink3} strokeWidth={3} />
      </View>
      <Text size="subhead" color="ink2" lineHeight={20} numberOfLines={2}>
        {highlight(snippet, match).map((part, i) =>
          part.hit ? (
            <Text
              key={i}
              size="subhead"
              lineHeight={20}
              style={{ backgroundColor: c.glow1, color: "#1A1F2B" }}
            >
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        )}
      </Text>
    </Pressable>
  );
}

/**
 * Splits text around matches: the server's «marked» spans when present, else case-insensitive
 * matches of `query`.
 */
export function highlight(text: string, query?: string): { text: string; hit: boolean }[] {
  if (text.includes("«")) {
    return text
      .split(/(«[^»]*»)/)
      .filter(Boolean)
      .map((part) =>
        part.startsWith("«") ? { text: part.slice(1, -1), hit: true } : { text: part, hit: false },
      );
  }
  const q = query?.trim();
  if (!q) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false });
    out.push({ text: text.slice(i, i + q.length), hit: true });
    at = i + q.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
