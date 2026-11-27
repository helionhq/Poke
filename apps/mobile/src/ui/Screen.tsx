import { Button, Icon, IconButton, Text, useColors } from "@poke/ui-native";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View, type ScrollViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface ScreenProps {
  title?: string;
  subtitle?: string;
  /** Top-right glass button (e.g. "+"). */
  trailing?: ReactNode;
  /** Replaces the title block (e.g. the app logo header on integration detail). */
  header?: ReactNode;
  children?: ReactNode;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  close?: boolean;
  scroll?: ScrollViewProps;
}

/**
 * The management screens' frame (12 Routines, 13 Skills, 15 Vault, 19 Connect an app): warm
 * grouped ground, glass back button, a large display title and a quiet line under it.
 */
export function Screen({
  title,
  subtitle,
  trailing,
  header,
  children,
  loading,
  error,
  onRefresh,
  close,
  scroll,
}: ScreenProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.groundGrouped }}>
      <View
        style={{
          position: "absolute",
          top: insets.top + 8,
          left: 16,
          right: 16,
          zIndex: 2,
          flexDirection: "row",
          justifyContent: "space-between",
        }}
      >
        <IconButton
          accessibilityLabel={close ? "Close" : "Back"}
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          icon={(color) => (
            <Icon name={close ? "close" : "chevronLeft"} size={20} color={color} strokeWidth={2.2} />
          )}
        />
        {trailing}
      </View>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 64, paddingBottom: insets.bottom + 32, gap: 24 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={false} onRefresh={onRefresh} /> : undefined}
        keyboardShouldPersistTaps="handled"
        {...scroll}
      >
        {header ??
          (title ? (
            <View style={{ paddingHorizontal: 20, gap: 6 }}>
              <Text
                family="display"
                size="largeTitle"
                lineHeight={40}
                tracking={-0.022}
                accessibilityRole="header"
              >
                {title}
              </Text>
              {subtitle ? (
                <Text size="subhead" color="ink2" lineHeight={21}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : null)}
        {error ? (
          <View
            style={{
              marginHorizontal: 16,
              padding: 14,
              borderRadius: 16,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.separator,
            }}
          >
            <Text size="subhead" color="ink2">
              {error}
            </Text>
            {onRefresh ? (
              <Button
                tone="fill"
                size="small"
                label="Try again"
                onPress={onRefresh}
                style={{ alignSelf: "flex-start", marginTop: 10 }}
              />
            ) : null}
          </View>
        ) : null}
        {loading ? <ActivityIndicator style={{ marginTop: 24 }} color={c.ink3} /> : children}
      </ScrollView>
    </View>
  );
}

/** A quiet line under the last group ("To add one, just ask in the thread…"). */
export function Footnote({ children }: { children: ReactNode }) {
  return (
    <Text size="footnote" color="ink3" lineHeight={18} style={{ paddingHorizontal: 20, marginTop: -12 }}>
      {children}
    </Text>
  );
}

/** Centered note when a list is empty, or couldn't load (with a way to try again). */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={{ alignItems: "center", paddingHorizontal: 40, paddingVertical: 32, gap: 6 }}>
      <Text size="callout" weight="semibold" align="center">
        {title}
      </Text>
      {body ? (
        <Text size="subhead" color="ink2" align="center">
          {body}
        </Text>
      ) : null}
      {action ? (
        <Button
          tone="fill"
          size="small"
          label={action.label}
          onPress={action.onPress}
          style={{ marginTop: 8 }}
        />
      ) : null}
    </View>
  );
}
