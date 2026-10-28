// Retired public qo4 constants, retained only for fixed regression vectors.
export const protocolData = Uint8Array.from(atob(
  "/JvpcDFpJPI1h0tOc+F8/yrcxMI/I6eZxo6wCzReHIE386jEhcPYLymv1p5ZTs6spw5zfbGdypzytYrgsSptA0D/+uj/VlQF" +
  "CpjVKClP18RiM/4wjXYCwFyjpFUbhjUbdWhD93jufFk5PCra01uwsPs14lSrRT4zCPUvgQ5Wd5MNc69XKtEaMSyGilXQXwTV" +
  "lA0kMjkHQM2fiM22oBd9iUnh5FC2r9Ih7o6f5oYN2OYakFZrN7wUt0HzEVgOGIa2eK9QVRZ1R8fPnnZ5VKegmnc5pIeMyatB" +
  "u0otMkR1DgfFaxnDsXWH9tuguh5MmRTykvgXThlgKBu+DR3GuCwD8jkv23fMbFBR49qAqMCP0KBb2KzEZkZSb7Nok/YLR01y" +
  "BNxy5hntBtZlsUjI0QYnX0xoZZ+ssfFPZiNwcW65rV+cFJvXUYGDKl7cm9nirU5UVnQ7i7qIRMi52li6VqXA9lyf62SYozqr" +
  "Gdv618oPP08XVu55zB+SH92Bn4bme/C6sCrTsSZBuP6HYTBB+7Kfuby5+ojRbsS6sfU044fcPG6qG3GmRK7E6/iFmtW/LqlU" +
  "WwWkRGtizP1peAi2ottPuyIMxe2KMsro1+QwwoGoD+MpA3dhg0awqzQExrcNCPur1PoE5Vi0UIVupNHQ9Fh5eqBD/Y1ldXoM" +
  "ul/bnjS2mKK6s3fspBnim3R4Z2KD4UpS8QO8whAjEljCk/akLd1j4P8trSPeOE8O+voUWnT0qqKdkEawuZJDTNcxpJultG4u" +
  "X+GtSTj/s8JaQOo13QbZD08tJXR/5ApCDzwn5+sjohImCM1fYkY4Zzthnwa+ObUj0p0tTVunk0ufkOOsXqnrVlYWAl6fB+6H" +
  "vAK0B+GQsaoarVOV4Y/ZzZLPaHYuyCpky//OSpp8WyUebax6paXT5ayxsNAQzt+pq/mcFtUZkdGZloqZNbFMLAGstZSKwjcd" +
  "kDsFt2bBgLdRu+ARpdmXnv47rCLq8+yrgRe6Roc3W0BoTaSnOevjZb6w/otJPIGle3Ts2M3Up/ya6vgelbFQjaWe4jVM1iCN" +
  "PtnXCyJ4+gPYS6iww54jHQvzRhjxQHv4Lb3W1ddxqvIDKlXdVlO7Jlib5PgMnG15/uAtxVY6yW0w+vnHCuCVRxoNq9MzAu7M" +
  "YJKM2zeHqZBPjbIgqSVCO5ajONt0/HHTWwdm3APN324h0CbFugeUEBOoSaC9l5/391sUzZZmsMgkEGqFuwu7XeIKCQo3DWmt" +
  "2xH2/AFwTs3qr40sUjYwb7SvD2zqu0RPPA1aSbf5Bhwlhv5wOSH9fJSb4fN+HiBQten+I8ZEBZe/5GeSkTqaA1pW0MRRrkee" +
  "bDZeGJ5HGM0Lfg+WuUMl5BufXWAlUEc/GTg8I4x4gQGVpW0rpmH5b+cs5Pdvc0T3BW4Delw5Nte2rWSqt8r9rdSX1l9jym5u" +
  "eOo8UlvYaqo="
), character => character.charCodeAt(0));

export const fixtureProtocol = {version: 'qo4', data: protocolData};

/** Synthetic bundle layout, no upstream program or user content. The parser must not execute it. */
export function fixtureSource(version = 'qo4', data = protocolData, rotation = 5) {
  const strings = ['kid', 'material', 'start', 'mask', 'enc', version, 'a', 'b', 'c',
    'length', 'set', 'slice', 'unused0', 'unused1', 'unused2', 'unused3'];
  const parts = [data.slice(0, 32), data.slice(32, 65), data.slice(65)];
  // Byte + 33 avoids surrogate code units and matches the observed string chunk encoding.
  strings.push(Array.from(parts[1], value => String.fromCharCode((value ^ 23) + 33)).join(''));
  const call = (index: number) => `A(${100 + index})`;
  const custom = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encoded = strings.map(value => btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/[A-Za-z]/g, char => custom[standard.indexOf(char)]));
  const table = [...encoded.slice(-rotation), ...encoded.slice(0, -rotation)];
  return `const A=d;function d(v){v-=100;const h=t();return h[v]}function t(){const h=${JSON.stringify(table)};return h}
"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";
const pool={};pool[${call(6)}]=${JSON.stringify([...parts[0]].map(value => value ^ 7))};pool[${call(7)}]=${call(16)};pool[${call(8)}]=${JSON.stringify([99, ...[...parts[2]].map(value => value ^ 51)])};
const p={};p.id=${call(6)},p[${call(2)}]=0,p[${call(3)}]=7,p[${call(4)}]=0;
const q={};q.id=${call(7)},q[${call(2)}]=32,q[${call(3)}]=23,q[${call(4)}]=1;
const r={};r.id=${call(8)},r[${call(2)}]=65,r[${call(3)}]=51,r[${call(4)}]=2;var chunks=[p,q,r];
const meta={};meta[${call(0)}]=${call(5)},meta[${call(1)}]=function(){let bytes;bytes=new Uint8Array(1088);return bytes};
globalThis.__comixRemoteCodeExecuted=true;`;
}
export const protocolAssetPath = '/assets/build/fixture/dist/apicore-fixture.js';
export const protocolHtml = `<script type="module" src="${protocolAssetPath}"></script>`;
