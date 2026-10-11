import {createHash} from 'node:crypto';
import type {Plugin} from 'vite';

// PDF.js 6.3.289 embeds core-js 3.50.0 (MIT). All supported browsers have
// native Object.create; its old IE/WSH fallback is unnecessary in MV3.
// Keep the remaining legacy polyfills so Firefox ESR and WebKit still work.
const objectCreateFallback = /\/\* global ActiveXObject -- old IE, WSH \*\/[\s\S]*?(?=\n\n\n\/\*\*\*\/ \},)/g;
const fallbackSha256 = 'a5c03d7e6d7b6d7d3ec33e6b1c0406606083099d292398d5e16ac2d8bb203e1c';

export function readablePdf(code: string): string {
  const matches = [...code.matchAll(objectCreateFallback)];
  if (matches.length !== 1 || createHash('sha256').update(matches[0][0]).digest('hex') !== fallbackSha256) {
    throw new Error('PDF.js Object.create fallback changed; review pdfjs-csp.ts before upgrading.');
  }
  return code.replace(objectCreateFallback, '// Node Comics: supported browsers use native Object.create.\nmodule.exports = Object.create;');
}

export function pdfjsCsp(): Plugin {
  return {
    name: 'pdfjs-native-object-create', enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/pdfjs-dist/legacy/build/pdf.mjs')) return;
      return {code: readablePdf(code), map: null};
    },
  };
}
