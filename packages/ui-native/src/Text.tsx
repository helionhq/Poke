import { type ColorName, fontSize as sizes, type FontWeight, type TextSize } from "@poke/ui-tokens";
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { useTheme } from "./theme";

export interface TextProps extends RNTextProps {
  size?: TextSize | number;
  weight?: FontWeight;
  color?: ColorName;
  family?: "sans" | "display" | "mono" | "serif";
  /** Line height in points (the canvas mostly gives them in px). */
  lineHeight?: number;
  /** Letter spacing in em. */
  tracking?: number;
  align?: TextStyle["textAlign"];
}

/** Text in Poke's faces. Weights map to the Open Runde file for that weight. */
export function Text({
  size = "body",
  weight = "regular",
  color = "ink",
  family = "sans",
  lineHeight,
  tracking,
  align,
  style,
  ...rest
}: TextProps) {
  const t = useTheme();
  const px = typeof size === "number" ? size : sizes[size];
  const fontFamily =
    family === "sans"
      ? t.fonts.sans[weight]
      : family === "display"
        ? t.fonts.display
        : family === "mono"
          ? t.fonts.mono
          : t.fonts.serif;
  return (
    <RNText
      {...rest}
      style={[
        {
          fontFamily,
          fontSize: px,
          color: t.colors[color],
          ...(lineHeight ? { lineHeight } : {}),
          ...(tracking !== undefined ? { letterSpacing: tracking * px } : {}),
          ...(align ? { textAlign: align } : {}),
        },
        style,
      ]}
    />
  );
}
