import type { WallpaperScene } from "@poke/ui-tokens";

/* Images from the Doop canvas, committed in @poke/ui-tokens/assets (Metro bundles them). */
export const images = {
  agentMark: require("@poke/ui-tokens/assets/agent-mark.jpg") as number,
  grain: require("@poke/ui-tokens/assets/grain.webp") as number,
  traceMark: require("@poke/ui-tokens/assets/trace-mark.png") as number,
  wallpapers: {
    haze: require("@poke/ui-tokens/assets/wallpaper-haze.webp") as number,
    dunes: require("@poke/ui-tokens/assets/wallpaper-dunes.webp") as number,
    coast: require("@poke/ui-tokens/assets/wallpaper-coast.jpg") as number,
  } satisfies Record<WallpaperScene, number>,
};

/** Font files by the family names `@poke/ui-tokens` uses; load with expo-font's useFonts. */
export const fontFiles = {
  "OpenRunde-Regular": require("@poke/ui-tokens/fonts/OpenRunde-Regular.otf") as number,
  "OpenRunde-Medium": require("@poke/ui-tokens/fonts/OpenRunde-Medium.otf") as number,
  "OpenRunde-Semibold": require("@poke/ui-tokens/fonts/OpenRunde-Semibold.otf") as number,
  "OpenRunde-Bold": require("@poke/ui-tokens/fonts/OpenRunde-Bold.otf") as number,
  "Exposure-Regular": require("@poke/ui-tokens/fonts/Exposure-Regular.ttf") as number,
};
