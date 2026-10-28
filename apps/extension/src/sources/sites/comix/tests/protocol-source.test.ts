import {describe, expect, it} from 'vitest';
import {parseProtocolSource} from '../protocol-source';
import {encodeRequest, decodeResponse} from '../protocol';
import {fixtureProtocol, fixtureSource, protocolData} from './protocol-fixture';
import vectors from './protocol-vectors.json';

describe('Comix inert public material extraction', () => {
  it.each([1, 5, 13])('resolves rotation %i and all three literal encodings without running code', rotation => {
    const parsed = parseProtocolSource(fixtureSource('new-version', protocolData, rotation));
    expect(parsed).toEqual({...fixtureProtocol, version:'new-version'});
    expect(encodeRequest('/manga/sample', parsed)).toBe('new-version.M-9zSiB-KY2C0Lpn');
    expect(decodeResponse(vectors.unicode, parsed)).toBe(decodeResponse(vectors.unicode, fixtureProtocol));
    expect(Reflect.get(globalThis, '__comixRemoteCodeExecuted')).toBeUndefined();
  });
  it('does not bind extraction to minified variable names or a fixed protocol version', () => {
    const source = fixtureSource('next').replace(/\bA\b/g, '$lookup').replace(/\bd\b/g, 'decode')
      .replace(/\bt\b/g, 'table').replace(/\bmeta\b/g, 'header').replace(/\bpool\b/g, '$pieces').replace(/\bp\b/g, '$piece');
    expect(parseProtocolSource(source).version).toBe('next');
  });
  it('reads changed signing states and response material rather than just replacing the version prefix', () => {
    const data=protocolData.map(value=>value^0xa5), parsed=parseProtocolSource(fixtureSource('rotated',data));
    expect(parsed).toEqual({version:'rotated',data});
    expect(encodeRequest('/manga/sample',parsed)).not.toBe('rotated.M-9zSiB-KY2C0Lpn');
  });
  it.each([
    (source:string) => source.replace('new Uint8Array(1088)', 'new Uint8Array(1090)'),
    (source:string) => source.replace('q[A(102)]=32', 'q[A(102)]=31'),
    (source:string) => source.replace('q[A(102)]=32', 'q[A(102)]=33'),
    (source:string) => source.replace('q[A(103)]=23', 'q[A(103)]=256'),
    (source:string) => source.replace('q[A(104)]=1', 'q[A(104)]=3'),
    (source:string) => source.replace('var chunks=[p,q,r]', 'var chunks=[p,q,p]'),
    (source:string) => source.replace('pool[A(106)]=[', 'pool[A(106)]=[999,'),
  ])('rejects incomplete, overlapping and unknown formats', mutate => {
    expect(() => parseProtocolSource(mutate(fixtureSource()))).toThrow(/协议已变化/);
  });
  it('bounds untrusted input and rejects non-protocol documents', () => {
    for (const input of ['<html>Verification</html>', 'x'.repeat(1024*1024+1), fixtureSource('bad.version')])
      expect(() => parseProtocolSource(input)).toThrow(/协议已变化/);
  });
  it('rejects a long malformed numeric literal without ambiguous repeated-digit matching', () => {
    const source=fixtureSource().replace(/pool\[A\(106\)\]=\[[^\]]*\]/,'pool[A(106)]=['+'9'.repeat(30000)+'x]');
    expect(()=>parseProtocolSource(source)).toThrow(/协议已变化/);
  });
});
