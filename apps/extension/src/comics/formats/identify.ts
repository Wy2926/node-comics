import type {ComicFormat} from './contracts';
export function detectFormat(name: string, prefix?: Uint8Array): ComicFormat | undefined {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const format: ComicFormat | undefined = ({zip: 'cbz', cbz: 'cbz', rar: 'cbr', cbr: 'cbr', pdf: 'pdf', mobi: 'mobi'} as Record<string, ComicFormat>)[extension ?? ''];
  if (!prefix) return format;
  const ascii = (offset: number, size: number) => String.fromCharCode(...prefix.subarray(offset, offset + size));
  if (format === 'cbz' && ascii(0, 2) === 'PK') return format;
  if (format === 'cbr' && ascii(0, 4) === 'Rar!') return format;
  if (format === 'pdf' && ascii(0, 5) === '%PDF-') return format;
  if (format === 'mobi' && ascii(60, 8) === 'BOOKMOBI') return format;
  return undefined;
}
export function imageMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'GIF8') return 'image/gif';
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}
