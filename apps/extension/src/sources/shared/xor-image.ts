/** Both Shueisha viewers use the same repeating 64-byte image key. */
export async function decodeXorImage(blob:Blob, hex:string, signal?:AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-f\d]{128}$/i.test(hex)) throw Error('图片还原参数无效。');
  const key = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
  const data = new Uint8Array(await blob.arrayBuffer()); signal?.throwIfAborted();
  for (let i = 0; i < data.length; i++) data[i] ^= key[i % key.length];
  const mime = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'image/jpeg'
    : data[0] === 0x89 && String.fromCharCode(...data.subarray(1, 8)) === 'PNG\r\n\x1a\n' ? 'image/png'
    : String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP' ? 'image/webp' : '';
  if (!mime) throw Error('图片还原失败。');
  signal?.throwIfAborted(); return new Blob([data], {type:mime});
}
