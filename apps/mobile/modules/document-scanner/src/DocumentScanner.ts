import { requireOptionalNativeModule } from "expo";

export interface ScanResult {
  /** A file:// URL of a PDF with every scanned page. */
  uri: string;
  pages: number;
}

interface NativeScanner {
  isAvailable(): boolean;
  scan(): Promise<ScanResult | null>;
}

// Optional: Expo Go, tests and the simulator have no VisionKit scanner.
const native = requireOptionalNativeModule<NativeScanner>("DocumentScanner");

export function isScannerAvailable(): boolean {
  return native?.isAvailable() ?? false;
}

/** Opens VisionKit's document camera; resolves null when he cancels. */
export async function scanDocument(): Promise<ScanResult | null> {
  if (!native) return null;
  return native.scan();
}
