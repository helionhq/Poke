import { layeredShadow, type Palette, type Theme, theme, type ThemeName } from "@poke/ui-tokens";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";

const ThemeContext = createContext<Theme>(theme("light"));

/** Dark mode follows the system (brief 20.2); `scheme` overrides it (a subtree, tests). */
export function ThemeProvider({ scheme, children }: { scheme?: ThemeName; children: ReactNode }) {
  const system = useColorScheme();
  const name: ThemeName = scheme ?? (system === "dark" ? "dark" : "light");
  const value = useMemo(() => theme(name), [name]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function useColors(): Palette {
  return useContext(ThemeContext).colors;
}

/** `color-mix(in srgb, a p%, b)` for two hex colours (the canvas uses it for gradients). */
export function mix(a: string, b: string, percentA: number): string {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [ra, ga, ba] = parse(a);
  const [rb, gb, bb] = parse(b);
  const t = percentA / 100;
  const ch = (x: number, y: number) =>
    Math.round(x * t + y * (1 - t))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(ra!, rb!)}${ch(ga!, gb!)}${ch(ba!, bb!)}`;
}

/** A hex colour at an opacity, as rgba(). */
export function alpha(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${opacity})`;
}

export function cardShadow(palette: Palette): string {
  return layeredShadow(palette);
}
