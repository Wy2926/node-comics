import {describe, expect, it} from 'vitest';
import {decodeResponse, encodeRequest} from '../protocol';
import vectors from './protocol-vectors.json';

describe('Comix qo4 protocol', () => {
  // Fixed expectations: request signing and response encoding are different algorithms.
  it.each([
    ['/manga/sample', 'qo4.M-9zSiB-KY2C0Lpn'],
    ['x'.repeat(55), 'qo4.t0DLMaHDc0Iu09NW'],
    ['x'.repeat(56), 'qo4.eyLNwq2ZQlUo78o9'],
    ['x'.repeat(63), 'qo4.3VSrcYzDV4RGrWi9'],
    ['x'.repeat(64), 'qo4.eez154J2PyVF0QvE'],
  ])('signs paths and SHA-256 block boundaries: %s', (input, signature) => {
    expect(encodeRequest(input)).toBe(signature);
  });

  it('decodes UTF-8 and pad wraparound with either Base64 alphabet', () => {
    const encoded = vectors.unicode;
    const decoded = {status: 'ok', result: {text: '漫画🌊\n"\\' + '0123456789'.repeat(110)}};
    expect(JSON.parse(decodeResponse(encoded))).toEqual(decoded);
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    expect(JSON.parse(decodeResponse(padded))).toEqual(decoded);
  });

  it.each(['AAA', 'not base64!', 'AAC_'])('rejects truncated, malformed or invalid UTF-8 payloads: %s', encoded => {
    expect(() => decodeResponse(encoded)).toThrow();
  });
});
