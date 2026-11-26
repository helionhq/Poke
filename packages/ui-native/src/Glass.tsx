import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

export interface GlassProps {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Menus use denser glass so rows stay readable. */
  dense?: boolean;
  interactive?: boolean;
}

const liquid = (() => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

/**
 * Liquid Glass (brief 20.2): `GlassView` on iOS 26, else a blur with the canvas's glass fill,
 * specular rim and inner line.
 */
export function Glass({ style, children, dense, interactive }: GlassProps) {
  const t = useTheme();
  const c = t.colors;
  if (liquid) {
    return (
      <GlassView
        glassEffectStyle={dense ? "regular" : "clear"}
        isInteractive={interactive ?? false}
        colorScheme={t.name}
        style={[{ overflow: "hidden" }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        {
          overflow: "hidden",
          boxShadow: `inset 0px 1px 0px ${c.glassEdge}, inset 0px -1px 0px ${c.glassLine}, 0px 1px 3px rgba(0,0,0,0.06), 0px 8px 24px rgba(0,0,0,0.08)`,
        },
        style,
      ]}
    >
      <BlurView
        intensity={dense ? 60 : 24}
        tint={t.name === "dark" ? "systemUltraThinMaterialDark" : "systemUltraThinMaterialLight"}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: dense ? c.scrim : c.glass }]} />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: StyleSheet.flatten(style)?.borderRadius ?? 0,
            borderWidth: 0.5,
            borderColor: c.glassLine,
          },
        ]}
      />
      {children}
    </View>
  );
}
