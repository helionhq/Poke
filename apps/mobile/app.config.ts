import type { ConfigContext, ExpoConfig } from "expo/config";
import pkg from "./package.json";

/** POKE_LIVE_ACTIVITY=0 builds without the Live Activity extension (brief section 18), e.g. if signing it ever fails. */
const LIVE_ACTIVITY = process.env.POKE_LIVE_ACTIVITY !== "0";

const MIC = "Talk to Poke: dictate messages and make voice calls.";

/**
 * Poke for iPhone. Sideloaded (SideStore), updated over the air from Poke's own server
 * (milestone 11). The bundle id and URL scheme are fixed: deep links and pairing depend on them.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Poke",
  slug: "poke",
  // The app version is apps/mobile/package.json (brief section 23); CI sets the build number.
  version: pkg.version,
  scheme: "poke",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  icon: "../../packages/ui-tokens/assets/agent-mark.jpg",
  ios: {
    bundleIdentifier: "im.arham.poke",
    supportsTablet: false,
    infoPlist: {
      NSCameraUsageDescription: "Take a photo or scan a document to send to Poke, and scan the pairing code.",
      NSPhotoLibraryUsageDescription: "Pick photos to send to Poke.",
      NSMicrophoneUsageDescription: "Talk to Poke.",
      NSSpeechRecognitionUsageDescription: "Turn what you say into text for Poke.",
      NSFaceIDUsageDescription: "Unlock your Vault.",
      ITSAppUsesNonExemptEncryption: false,
      NSSupportsLiveActivities: LIVE_ACTIVITY,
    },
  },
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: "https://poke.arham.im/v1/updates/manifest",
    // Filled in at runtime after pairing (src/lib/updates.ts); expo-updates only lets the app set
    // headers declared here.
    requestHeaders: { authorization: "", "cf-access-client-id": "", "cf-access-client-secret": "" },
    enabled: true,
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  plugins: [
    "expo-router",
    "expo-sqlite",
    ["expo-font", {}],
    "expo-image",
    ["expo-secure-store", { faceIDPermission: "Unlock your Vault." }],
    ["expo-local-authentication", { faceIDPermission: "Unlock your Vault." }],
    [
      "expo-camera",
      {
        cameraPermission: "Take a photo, scan the pairing code, or show Poke something on a call.",
        microphonePermission: MIC,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: "Pick photos to send to Poke." }],
    "expo-background-task",
    "expo-status-bar",
    [
      "expo-splash-screen",
      {
        image: "../../packages/ui-tokens/assets/agent-mark.jpg",
        imageWidth: 96,
        backgroundColor: "#FFFDFA",
        dark: { backgroundColor: "#0B0B0C" },
      },
    ],
    "expo-sharing",
    // Streaming mic and playback for dictation and calls (brief section 17). No background audio:
    // a call ends when the app leaves the screen.
    ["react-native-audio-api", { iosMicrophonePermission: MIC, iosBackgroundMode: false }],
    // The Lock Screen Live Activity (targets/live-activity), no App Group: state goes through ActivityKit.
    ...(LIVE_ACTIVITY ? ["@bacons/apple-targets"] : []),
  ],
  extra: { ...config.extra, liveActivity: LIVE_ACTIVITY },
  experiments: { typedRoutes: false },
});
