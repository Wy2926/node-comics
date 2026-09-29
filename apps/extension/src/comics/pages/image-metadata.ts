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
