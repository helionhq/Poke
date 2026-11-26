// Native modules Jest can't load: the scanner is a local Expo module, haptics just no-op.
jest.mock("./modules/document-scanner", () => ({
  isScannerAvailable: () => false,
  scanDocument: async () => null,
}));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));
