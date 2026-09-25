import {createHash, createPublicKey} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {extensionIdentity} from '../extension-identity';

describe('browser package identities', () => {
  it.each([['chrome', 'aiajdjliifeeaogpalejpggkiccjbneo'], ['edge', 'haelhcdomcfllhpfjdpbejccbjcdeaig']])('keeps the registered %s ID only in manual-install builds', (browser, id) => {
    const {key} = extensionIdentity(browser);
    const der = Buffer.from(key!, 'base64');
    expect(createPublicKey({key: der, format: 'der', type: 'spki'}).asymmetricKeyType).toBe('rsa');
    const actual = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    expect(actual).toBe(id);
    expect(extensionIdentity(browser, true)).not.toHaveProperty('key');
  });
  it('does not attach Chromium keys to Firefox', () => {
    expect(extensionIdentity('firefox')).toEqual({});
  });
});
