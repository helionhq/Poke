import { Image } from "expo-image";
import { createContext, type ReactNode, useContext } from "react";
import { View } from "react-native";
import { Text } from "./Text";
import { useTheme } from "./theme";

/** An app or site mark: an Executor app id / well-known name, or a domain. */
export interface MarkRef {
  app?: string;
  domain?: string;
  /** A display name, for the letter fallback. */
  name?: string;
  /** A server-provided icon path (AppRef.icon). */
  icon?: string;
}

/**
 * How the app turns a mark into an image. The phone never fetches third-party images directly:
 * the app's resolver points at the server's logo/image proxy.
 */
export type MarkResolver = (mark: MarkRef) => { uri: string; headers?: Record<string, string> } | undefined;

const MarkContext = createContext<MarkResolver>(() => undefined);

export function MarkProvider({ resolve, children }: { resolve: MarkResolver; children: ReactNode }) {
  return <MarkContext.Provider value={resolve}>{children}</MarkContext.Provider>;
}

export function useMarkResolver(): MarkResolver {
  return useContext(MarkContext);
}

/** A logo for a mark, or the first letter of its name on a quiet tile. */
export function Logo({ mark, size = 22, radius }: { mark?: MarkRef; size?: number; radius?: number }) {
  const resolve = useContext(MarkContext);
  const c = useTheme().colors;
  const source = mark ? resolve(mark) : undefined;
  if (source) {
    return (
      <Image
        source={source}
        style={{ width: size, height: size, borderRadius: radius ?? size * 0.22 }}
        contentFit="contain"
        accessibilityIgnoresInvertColors
      />
    );
  }
  const letter = (mark?.name ?? mark?.app ?? mark?.domain ?? "?")
    .replace(/^www\./, "")
    .slice(0, 1)
    .toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? size * 0.22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.fill,
      }}
    >
      <Text size={Math.round(size * 0.55)} weight="semibold" color="ink2">
        {letter}
      </Text>
    </View>
  );
}
