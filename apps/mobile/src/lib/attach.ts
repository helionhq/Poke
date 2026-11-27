import type { Attachment, PokeClient } from "@poke/client";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { scanDocument } from "../../modules/document-scanner";

/** A file on the phone, ready to upload. */
export interface LocalFile {
  uri: string;
  name: string;
  mime: string;
  kind?: "image" | "file" | "scan";
  width?: number;
  height?: number;
}

const fromAsset = (a: ImagePicker.ImagePickerAsset): LocalFile => ({
  uri: a.uri,
  name: a.fileName ?? `photo-${Date.now()}.jpg`,
  mime: a.mimeType ?? "image/jpeg",
  kind: "image",
  width: a.width,
  height: a.height,
});

export async function pickPhotos(): Promise<LocalFile[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: 10,
    quality: 0.85,
  });
  return res.canceled ? [] : res.assets.map(fromAsset);
}

export async function takePhoto(): Promise<LocalFile[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return [];
  const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return res.canceled ? [] : res.assets.map(fromAsset);
}

export async function pickFiles(): Promise<LocalFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  return res.canceled
    ? []
    : res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        mime: a.mimeType ?? "application/octet-stream",
        kind: "file" as const,
      }));
}

/** VisionKit's document scanner: one PDF of every page. */
export async function scan(): Promise<LocalFile[]> {
  const result = await scanDocument();
  return result
    ? [
        {
          uri: result.uri,
          name: `Scan ${new Date().toLocaleDateString()}.pdf`,
          mime: "application/pdf",
          kind: "scan",
        },
      ]
    : [];
}

/** Uploads one file (multipart `file`, with the kind hint first so the server sees it). */
export async function upload(client: PokeClient, file: LocalFile): Promise<Attachment> {
  const form = new FormData();
  if (file.kind) form.append("kind", file.kind);
  // React Native's FormData takes {uri, name, type} for files.
  form.append("file", { uri: file.uri, name: file.name, type: file.mime } as unknown as Blob);
  const { attachment } = await client.upload(form);
  return attachment;
}
