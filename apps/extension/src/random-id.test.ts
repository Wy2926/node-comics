import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomId} from './random-id';
import {id} from './reader/model';

const secureCrypto=globalThis.crypto;
afterEach(()=>vi.unstubAllGlobals());

describe('document-safe random identifiers',()=>{
  it('prefers the native UUID method without requesting fallback bytes',()=>{
    const expected='01234567-89ab-4cde-8f01-23456789abcd';
    const native={randomUUID:vi.fn(()=>expected),getRandomValues:vi.fn()};
    vi.stubGlobal('crypto',native);
    expect(randomId()).toBe(expected);
    expect(native.randomUUID).toHaveBeenCalledOnce();
    expect(native.getRandomValues).not.toHaveBeenCalled();
  });

  it('sets UUIDv4 version and variant bits without changing the remaining random bytes',()=>{
    const getRandomValues=vi.fn((bytes:Uint8Array)=>{bytes.set(Array.from({length:16},(_,i)=>i));return bytes;});
    vi.stubGlobal('crypto',{getRandomValues});
    expect(randomId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('uses fresh cryptographic randomness for repeated insecure-document UUIDs',()=>{
    const getRandomValues=vi.fn((bytes:Uint8Array)=>secureCrypto.getRandomValues(bytes));
    vi.stubGlobal('crypto',{getRandomValues});
    const values=Array.from({length:512},()=>randomId());
    expect(new Set(values).size).toBe(values.length);
    expect(values.every(value=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))).toBe(true);
    expect(getRandomValues).toHaveBeenCalledTimes(values.length);
  });

  it('keeps the existing reader id helper on the same HTTP-safe implementation',()=>{
    vi.stubGlobal('crypto',{getRandomValues:(bytes:Uint8Array)=>bytes.fill(255)});
    expect(id()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
});
