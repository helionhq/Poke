import { type ReactNode } from "react";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useColors } from "./theme";

/**
 * Line icons in the canvas's style (24-unit grid, round caps and joins). The canvas's own paths
 * are used where a component defines them; the rest follow the same stroke language.
 */
const glyphs = {
  plus: <Path d="M12 5v14M5 12h14" />,
  arrowUp: <Path d="M12 19V5M6 11l6-6 6 6" />,
  stop: <Rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />,
  mic: (
    <>
      <Rect x="9" y="3" width="6" height="11" rx="3" />
      <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  camera: (
    <>
      <Path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.7l1.4-2h4.8l1.4 2h1.7A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z" />
      <Circle cx="12" cy="12.5" r="3.5" />
    </>
  ),
  phoneDown: (
    <Path d="M3.5 13.5c4.7-4 12.3-4 17 0l-1.6 2.4a1.5 1.5 0 0 1-1.9.5l-2.2-1a1.5 1.5 0 0 1-.9-1.4v-1.3a11 11 0 0 0-3.8 0V14a1.5 1.5 0 0 1-.9 1.4l-2.2 1a1.5 1.5 0 0 1-1.9-.5Z" />
  ),
  copy: (
    <>
      <Rect x="8" y="8" width="12" height="12" rx="2.5" />
      <Path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
    </>
  ),
  speaker: (
    <>
      <Path d="M11 5 6.5 8.5H4v7h2.5L11 19V5Z" />
      <Path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  search: (
    <>
      <Circle cx="11" cy="11" r="6.5" />
      <Path d="m20 20-4.2-4.2" />
    </>
  ),
  chevronRight: <Path d="m9 6 6 6-6 6" />,
  chevronLeft: <Path d="m15 6-6 6 6 6" />,
  chevronDown: <Path d="m6 9 6 6 6-6" />,
  close: <Path d="M6 6l12 12M18 6 6 18" />,
  check: <Path d="m5 12.5 4.5 4.5L19 7.5" />,
  memory: (
    <>
      <Path d="M18 21l-6-3.6L6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z" />
      <Path d="m9.5 10 2 2 3.5-3.5" />
    </>
  ),
  lock: (
    <>
      <Rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  key: (
    <>
      <Circle cx="8" cy="15" r="4" />
      <Path d="m10.8 12.2 8.2-8.2M16 7l2.5 2.5M14 9l2 2" />
    </>
  ),
  shield: <Path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6Z" />,
  globe: (
    <>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z" />
    </>
  ),
  calendar: (
    <>
      <Rect x="4" y="5" width="16" height="15" rx="2.5" />
      <Path d="M4 10h16M8.5 3v4M15.5 3v4" />
    </>
  ),
  clock: (
    <>
      <Circle cx="12" cy="12" r="8.5" />
      <Path d="M12 7.5V12l3 2" />
    </>
  ),
  mail: (
    <>
      <Rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <Path d="m4 7 8 6 8-6" />
    </>
  ),
  paperclip: (
    <Path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
  ),
  image: (
    <>
      <Rect x="4" y="4.5" width="16" height="15" rx="2.5" />
      <Circle cx="9" cy="9.5" r="1.5" />
      <Path d="m20 15.5-4.5-4.5L6 19.5" />
    </>
  ),
  file: (
    <>
      <Path d="M14 3.5H7.5A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V8.5Z" />
      <Path d="M14 3.5v5h5" />
    </>
  ),
  sparkles: (
    <Path d="M12 4.5 13.6 9l4.4 1.5-4.4 1.6L12 16.5l-1.6-4.4L6 10.5 10.4 9ZM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
  ),
  trash: (
    <>
      <Path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
      <Path d="M6.5 7l.8 11.5A2 2 0 0 0 9.3 20.5h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    </>
  ),
  pencil: (
    <Path d="M14.5 5.5l4 4M4.5 19.5l1-4.5L16 4.5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5Z" />
  ),
  more: (
    <>
      <Circle cx="6" cy="12" r="1.2" fill="currentColor" />
      <Circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <Circle cx="18" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  link: (
    <Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  settings: (
    <>
      <Circle cx="12" cy="12" r="3" />
      <Path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
    </>
  ),
  library: (
    <>
      <Path d="M5 4.5v15M9.5 4.5v15" />
      <Path d="m14 5.2 3.9-1 3.6 14.5-3.9 1Z" />
    </>
  ),
  bell: (
    <>
      <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" />
      <Path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  play: <Path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" />,
  refresh: <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  bolt: <Path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12Z" />,
  terminal: (
    <>
      <Rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <Path d="m7.5 10 3 2.5-3 2.5M12.5 15.5h4" />
    </>
  ),
  user: (
    <>
      <Circle cx="12" cy="8.5" r="3.5" />
      <Path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  eye: (
    <>
      <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <Circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <Path d="M3.5 3.5l17 17M10 6a9.6 9.6 0 0 1 2-.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.3M6.4 7.4C3.9 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.4-1.1M10 10a3 3 0 0 0 4.1 4.1" />
  ),
  faceId: (
    <>
      <Path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16" />
      <Path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0" />
    </>
  ),
  share: (
    <>
      <Path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <Path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </>
  ),
  reply: <Path d="M9.5 7.5 4.5 12l5 4.5M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19" />,
  server: (
    <>
      <Rect x="4" y="4" width="16" height="7" rx="2" />
      <Rect x="4" y="13" width="16" height="7" rx="2" />
      <Path d="M8 7.5h.01M8 16.5h.01" />
    </>
  ),
  apps: (
    <>
      <Rect x="4" y="4" width="7" height="7" rx="2" />
      <Rect x="13" y="4" width="7" height="7" rx="2" />
      <Rect x="4" y="13" width="7" height="7" rx="2" />
      <Rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  sideChat: (
    <Path
      strokeDasharray="3.4 2.6"
      d="M12 3.6c4.7 0 8.5 3.4 8.5 7.5s-3.8 7.5-8.5 7.5c-1.1 0-2.2-.2-3.2-.5L4 19.9l1.3-3.9C4.2 14.7 3.5 13 3.5 11.1c0-4.1 3.8-7.5 8.5-7.5Z"
    />
  ),
  waveform: <Path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3" />,
  send: <Path d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5" />,
  bubble: (
    <Path d="M12 3.6c4.7 0 8.5 3.4 8.5 7.5s-3.8 7.5-8.5 7.5c-1.1 0-2.2-.2-3.2-.5L4 19.9l1.3-3.9C4.2 14.7 3.5 13 3.5 11.1c0-4.1 3.8-7.5 8.5-7.5Z" />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof glyphs;
export const iconNames = Object.keys(glyphs) as IconName[];

export interface IconProps {
  name: IconName;
  size?: number;
  /** A colour value; defaults to ink. */
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 20, color, strokeWidth = 1.8 }: IconProps) {
  const c = useColors();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? c.ink}
      color={color ?? c.ink}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyphs[name]}
    </Svg>
  );
}
