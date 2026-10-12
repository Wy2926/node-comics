// Public reader protocol: MD5(unixSeconds + "mng_ch_" + UTC yyyyMMddHH), first 16 hex characters.
// This is a request checksum, not an account credential. No downloaded JavaScript is executed.
// The protocol's ASCII message fits one MD5 block (RFC 1321).
export function chapterToken(now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000)), hour = new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, '');
  const input = timestamp + 'mng_ch_' + hour;
  if (!/^\d+mng_ch_\d{10}$/.test(input) || input.length >= 56) throw Error('MangaTaro 请求时间无效。');
  const bytes = new Uint8Array(64), view = new DataView(bytes.buffer);
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i);
  bytes[input.length] = 0x80; view.setUint32(56, input.length * 8, true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  let [a, b, c, d] = state;
  const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  for (let i = 0; i < 64; i++) {
    const round = Math.floor(i / 16), shift = shifts[round][i % 4];
    const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
    const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
    const sum = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) + view.getUint32(g * 4, true)) | 0;
    [a, b, c, d] = [d, (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0, b, c];
  }
  const result = new DataView(new ArrayBuffer(8));
  result.setUint32(0, state[0] + a, true); result.setUint32(4, state[1] + b, true);
  const token = [...new Uint8Array(result.buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
  return {_t: token, _ts: timestamp};
}
