import type { WallpaperScene } from "@poke/ui-tokens";
import { useSyncExternalStore } from "react";
import { Cache } from "./cache";

/** Small app preferences, kept in the cache database and shared live between screens. */
let cache: Cache | undefined;
const listeners = new Set<() => void>();
let wallpaper: WallpaperScene | undefined;

function db(): Cache {
  cache ??= new Cache();
  return cache;
}

export function getWallpaper(): WallpaperScene {
  wallpaper ??= db().pref<WallpaperScene>("wallpaper", "haze");
  return wallpaper;
}

export function setWallpaper(scene: WallpaperScene): void {
  wallpaper = scene;
  db().setPref("wallpaper", scene);
  for (const fn of listeners) fn();
}

export function useWallpaper(): WallpaperScene {
  return useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getWallpaper);
}
