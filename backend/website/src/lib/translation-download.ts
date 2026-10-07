export function translationFilename(name: string, language: string, type: string) {
  const stem = name.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'image';
  const suffix = language.replace(/[^a-zA-Z0-9-]/g, '') || 'translated';
  const extension = type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : 'png';
  return `${stem}-${suffix}.${extension}`;
}

/** Read and store one result at a time. Images are already compressed. */
export async function translationArchive<T>(
  records: readonly T[],
  readResult: (record: T) => Promise<{ name: string; blob: Blob }>,
) {
  if (!records.length) throw Error('INPUT_MISSING');
  const { BlobReader, BlobWriter, ZipWriter } = await import('@zip.js/zip.js/index-native.js');
  const zip = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, level: 0 });
  for (const [index, record] of records.entries()) {
    const { name, blob } = await readResult(record);
    // Stable prefixes preserve list order and prevent duplicate filenames overwriting.
    await zip.add(`${String(index + 1).padStart(3, '0')}-${name}`, new BlobReader(blob));
  }
  return zip.close();
}

export function saveDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
