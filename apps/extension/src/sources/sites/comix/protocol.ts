// Independently implemented arithmetic; rotating public constants are read as data, never executed.
export interface ComixProtocol { version: string; data: Uint8Array; }

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** Finish SHA-256 after the protocol's precomputed 64-byte prefix. */
function digest(input: Uint8Array, stateOffset: number, protocol: ComixProtocol): Uint8Array {
  const protocolView = new DataView(protocol.data.buffer, protocol.data.byteOffset, protocol.data.byteLength);
  const state = Uint32Array.from({length: 8}, (_, index) => protocolView.getUint32(stateOffset + index * 4));
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const length = input.length + 64;
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15], y = words[index - 2];
      words[index] = words[index - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[index - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) + K[index] + words[index]) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
  }
  const output = new Uint8Array(32), outputView = new DataView(output.buffer);
  state.forEach((word, index) => outputView.setUint32(index * 4, word));
  return output;
}

export function encodeRequest(text: string, protocol: ComixProtocol): string {
  const hash = digest(digest(new TextEncoder().encode(text), 0, protocol), 32, protocol);
  return protocol.version + '.' + btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 16);
}

export function decodeResponse(text: string, protocol: ComixProtocol): string {
  const data = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  if (data.length < 3) throw Error('Comix 返回的数据格式已变化。');
  const offset = ((data[0] << 8) | data[1]) % 1024;
  for (let index = 2; index < data.length; index++) data[index] ^= protocol.data[64 + (offset + index - 2) % 1024];
  return new TextDecoder('utf-8', {fatal: true}).decode(data.subarray(2));
}
