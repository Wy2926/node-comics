import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {readablePdf} from '../pdfjs-csp';

const checksums = JSON.parse(readFileSync(new URL('../public/import-assets/licenses/dependency-checksums.json', import.meta.url), 'utf8'));
describe('reviewable PDF.js legacy bundles', () => {
  for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
    const path = `pdfjs-dist/legacy/build/${name}`;
    const original = readFileSync(new URL(`../node_modules/${path}`, import.meta.url), 'utf8');
    it(`only replaces the obsolete Object.create fallback in ${name}`, () => {
      expect(createHash('sha256').update(original).digest('hex')).toBe(checksums.sha256[path]);
      const patched = readablePdf(original);
      expect(patched).not.toMatch(/ActiveXObject|NullProtoObject|document\.F=Object/);
      expect(patched).toContain('module.exports = Object.create;');
      const start = original.indexOf('/* global ActiveXObject');
      const end = original.indexOf('\n\n\n/***/ },', start);
      expect(patched).toBe(original.slice(0, start) + '// Node Comics: supported browsers use native Object.create.\nmodule.exports = Object.create;' + original.slice(end));
      expect(patched).toContain('Apache License');
    });
    it(`fails closed on missing, changed or duplicate fallback in ${name}`, () => {
      expect(() => readablePdf(readablePdf(original))).toThrow('fallback changed');
      expect(() => readablePdf(original.replace("var GT = '>';", "var GT = '<';"))).toThrow('fallback changed');
      expect(() => readablePdf(original + original)).toThrow('fallback changed');
    });
  }
});
