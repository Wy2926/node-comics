/** Read dimensions before allocating decoded pixels. Unsupported or malformed headers are rejected. */
export async function probeImageMetadata(blob: Blob): Promise<{mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number} | undefined> {
  const read = async (at: number, length: number) => new Uint8Array(await blob.slice(at, at + length).arrayBuffer());
  const header = await read(0, 30);
  const tag = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
  const dimensions = (mime: 'image/png' | 'image/jpeg' | 'image/webp', width: number, height: number) =>
    width > 0 && height > 0 ? {mime, width, height} : undefined;
  if (header.length >= 24 && header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71 &&
      header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10 && tag(12) === 'IHDR') {
    const view = new DataView(header.buffer);
    if (view.getUint32(8) !== 13) return undefined;
    return dimensions('image/png', view.getUint32(16), view.getUint32(20));
  }
  if (header.length >= 20 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const length = new DataView(header.buffer).getUint32(16, true), kind = tag(12);
    if (20 + length + (length & 1) > blob.size) return undefined;
    if (kind === 'VP8X' && length === 10 && header.length >= 30) {
      return dimensions('image/webp', 1 + header[24] + (header[25] << 8) + (header[26] << 16),
        1 + header[27] + (header[28] << 8) + (header[29] << 16));
    }
    if (kind === 'VP8L' && length >= 5 && header.length >= 25 && header[20] === 0x2f) {
      return dimensions('image/webp', 1 + header[21] + ((header[22] & 0x3f) << 8),
        1 + (header[22] >> 6) + (header[23] << 2) + ((header[24] & 0x0f) << 10));
    }
    if (kind === 'VP8 ' && length >= 10 && header.length >= 30 &&
        (header[20] & 1) === 0 && header[23] === 0x9d && header[24] === 1 && header[25] === 0x2a) {
      const view = new DataView(header.buffer);
      return dimensions('image/webp', view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
    return undefined;
  }
  if (header[0] !== 255 || header[1] !== 0xd8) return undefined;
  // Skip metadata payloads by their declared lengths; bound work on pathological marker streams.
  for (let at = 2, segments = 0; segments < 512 && at + 4 <= blob.size; segments++) {
    const markerHeader = await read(at, 4);
    if (markerHeader.length !== 4 || markerHeader[0] !== 255) return undefined;
    const marker = markerHeader[1];
    if (marker === 255) { at++; continue; }
    if (marker === 0 || marker === 0xda || marker === 0xd9 || marker === 0xd8) return undefined;
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    const length = new DataView(markerHeader.buffer).getUint16(2);
    if (length < 2 || at + 2 + length > blob.size) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return undefined;
      const frame = await read(at + 4, 5), view = new DataView(frame.buffer);
      return dimensions('image/jpeg', view.getUint16(3), view.getUint16(1));
    }
    at += 2 + length;
  }
  return undefined;
}

/** Metadata that can make sent bytes decode differently from the browser's static sRGB page. */
export async function needsNormalization(blob: Blob): Promise<boolean> {
  if (blob.type === 'image/gif') return true;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

  if (blob.type === 'image/png') {
    for (let at = 8; at + 12 <= bytes.length;) {
      const length = view.getUint32(at);
      const name = tag(at + 4);
      if (['iCCP', 'gAMA', 'cHRM', 'eXIf', 'acTL'].includes(name)) return true;
      if (name === 'IEND' || at + length + 12 > bytes.length) break;
      at += length + 12;
    }
  } else if (blob.type === 'image/jpeg') {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at] !== 255) break;
      const marker = bytes[at + 1];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xe1 || marker === 0xe2) return true;
      if (marker === 255) { at++; continue; }
      const length = view.getUint16(at + 2);
      if (length < 2) break;
      at += length + 2;
    }
  } else if (blob.type === 'image/webp') {
    for (let at = 12; at + 8 <= bytes.length;) {
      const name = tag(at);
      const length = view.getUint32(at + 4, true);
      if (['ICCP', 'EXIF', 'ANIM', 'ANMF'].includes(name)) return true;
      if (at + length + 8 > bytes.length) break;
      at += 8 + length + (length & 1);
    }
  }
  return false;
}
