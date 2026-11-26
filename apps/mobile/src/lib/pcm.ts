/** Pure audio helpers (no native code), so Jest can test them. */

/** Float samples (-1…1) to mono PCM16 little-endian, resampled to `toRate` when they differ. */
export function floatToPcm16(samples: Float32Array, fromRate: number, toRate = fromRate): Uint8Array {
  const input = fromRate === toRate ? samples : resample(samples, fromRate, toRate);
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Mono PCM16 little-endian to float samples. An odd trailing byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** Linear resampling: plenty for speech going to a recognizer. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const at = i * step;
    const a = Math.floor(at);
    const b = Math.min(a + 1, samples.length - 1);
    const t = at - a;
    out[i] = samples[a]! * (1 - t) + samples[b]! * t;
  }
  return out;
}

/** A 0…1 loudness for the waveform pill (RMS, scaled so normal speech fills most of it). */
export function level(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/**
 * The composer's text while dictating: what was there before, the finished stretches, and the
 * stretch still being heard.
 */
export function dictationText(before: string, finals: string[], partial: string): string {
  const spoken = [...finals, partial.trim()].filter(Boolean).join(" ");
  if (!spoken) return before;
  if (!before.trim()) return spoken;
  return /\s$/.test(before) ? before + spoken : `${before} ${spoken}`;
}
