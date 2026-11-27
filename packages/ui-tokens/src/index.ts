/**
 * Poke's design tokens, from the Doop canvas "Poke One" (9otpvbAiXq), `get_tokens` json.
 * Values are as the canvas defines them; sizes are points. Refresh by re-reading the canvas's
 * tokens and updating this file (names stay the canvas's, without `--`).
 */

export type ThemeName = "light" | "dark";

const light = {
  ground: "#FFFDFA",
  groundGrouped: "#F5F3F0",
  surface: "#FFFFFF",
  card: "#FFFFFF",
  bubble: "#76838F",
  ink: "#1A1F2B",
  ink2: "rgba(0,0,0,0.55)",
  ink3: "rgba(0,0,0,0.38)",
  onInk: "#FFFFFF",
  fill: "rgba(0,0,0,0.04)",
  fill2: "rgba(0,0,0,0.08)",
  separator: "#EEEDEB",
  glass: "rgba(255,255,255,0.26)",
  glassEdge: "rgba(255,255,255,0.95)",
  glassLine: "rgba(255,255,255,0.55)",
  shadow: "rgba(0,0,0,0.045)",
  scrim: "rgba(255,255,255,0.5)",
  gray: "#8E8E93",
  red: "#FF3B30",
  orange: "#FF9500",
  yellow: "#FFCC00",
  green: "#34C759",
  teal: "#30B0C7",
  blue: "#007AFF",
  indigo: "#5856D6",
  purple: "#AF52DE",
  pink: "#FF2D55",
  glow1: "#CFE2F2",
  glow2: "#A9CBEA",
  glow3: "#6E9FCC",
  glow4: "#F3E7D3",
  white: "#FFFFFF",
  black: "#000000",
  sky: "#DDE9F3",
  link: "#4281AF",
  onBubble: "#FFFFFF",
  wash: "rgba(255,253,250,0.5)",
} as const;

export type ColorName = keyof typeof light;
export type Palette = { readonly [K in ColorName]: string };

const dark: Palette = {
  ...light,
  ground: "#0B0B0C",
  groundGrouped: "#0B0B0C",
  surface: "#171717",
  card: "#171717",
  bubble: "#3A4552",
  ink: "#F5F3F0",
  ink2: "rgba(255,253,250,0.6)",
  ink3: "rgba(255,253,250,0.36)",
  onInk: "#0B0B0C",
  fill: "rgba(255,255,255,0.07)",
  fill2: "rgba(255,255,255,0.14)",
  separator: "rgba(255,255,255,0.08)",
  glass: "rgba(255,255,255,0.07)",
  glassEdge: "rgba(255,255,255,0.38)",
  glassLine: "rgba(255,255,255,0.12)",
  shadow: "rgba(0,0,0,0.5)",
  scrim: "rgba(0,0,0,0.5)",
  red: "#FF453A",
  orange: "#FF9F0A",
  yellow: "#FFD60A",
  green: "#30D158",
  teal: "#40C8E0",
  blue: "#0A84FF",
  indigo: "#5E5CE6",
  purple: "#BF5AF2",
  pink: "#FF375F",
  sky: "#13223A",
  link: "#7FB0D8",
  wash: "rgba(11,11,12,0.74)",
};

export const colors: { readonly [T in ThemeName]: Palette } = { light, dark };

export const radius = {
  xs: 7,
  sm: 12,
  md: 16,
  bubble: 20,
  lg: 22,
  xl: 26,
  "2xl": 38,
  full: 999,
  button: 13,
} as const;

export const spacing = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;
export type FontWeight = keyof typeof fontWeight;

export const fontSize = {
  caption2: 11,
  caption: 12,
  footnote: 13,
  subhead: 15,
  callout: 16,
  body: 17,
  title3: 20,
  title2: 22,
  title1: 28,
  largeTitle: 34,
} as const;
export type TextSize = keyof typeof fontSize;

/** Line heights as multiples of the font size. */
export const leading = { tight: 1.18, snug: 1.3, body: 1.45 } as const;

/** Letter spacing in em (multiply by the font size for points). */
export const tracking = { display: -0.022, title: -0.017, body: -0.012, caption: 0 } as const;

/**
 * Font families. Native apps load one file per weight under these names (see `fontFiles` in
 * `@poke/ui-native`); the web uses the CSS stacks.
 */
export const fonts = {
  sans: {
    regular: "OpenRunde-Regular",
    medium: "OpenRunde-Medium",
    semibold: "OpenRunde-Semibold",
    bold: "OpenRunde-Bold",
  },
  /** Exposure VAR at its default EXPO axis: titles, day headers, the voice transcript. */
  display: "Exposure-Regular",
  /** Tool names and code. */
  mono: "JetBrainsMono_400Regular",
  /** Stand-in for New York (the canvas uses Source Serif 4): iOS's own serif. */
  serif: "New York",
} as const;

export const cssFontStacks = {
  sans: '"Open Runde", -apple-system, BlinkMacSystemFont, sans-serif',
  serif: '"Source Serif 4", ui-serif, Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
  display: '"Exposure VAR", "Open Runde", sans-serif',
} as const;

/** poke.com's layered shadow (three steps of the shadow colour). */
export function layeredShadow(palette: Palette): string {
  return `0px 1px 2px ${palette.shadow}, 0px 3px 8px ${palette.shadow}, 0px 8px 28px ${palette.shadow}`;
}

export const wallpapers = ["haze", "dunes", "coast"] as const;
export type WallpaperScene = (typeof wallpapers)[number];

export interface Theme {
  name: ThemeName;
  colors: Palette;
  radius: typeof radius;
  spacing: typeof spacing;
  fontSize: typeof fontSize;
  leading: typeof leading;
  tracking: typeof tracking;
  fonts: typeof fonts;
}

export function theme(name: ThemeName): Theme {
  return { name, colors: colors[name], radius, spacing, fontSize, leading, tracking, fonts };
}
