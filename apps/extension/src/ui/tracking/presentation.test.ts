import {describe, expect, it} from 'vitest';
import {trackingFailure, trackingSearchQuery} from './presentation';

describe('tracking search input', () => {
  it.each(['123', ' 00123 ', 'https://anilist.co/manga/123', 'https://anilist.co/manga/123/Example-Title/', 'https://anilist.co/manga/123?tab=stats#top'])('normalizes exact manga identity: %s', value => {
    expect(trackingSearchQuery(value)).toBe('123');
  });
  it.each(['', '0', 'https://evil.example/manga/123', 'https://anilist.co.evil.example/manga/123', 'https://anilist.co/anime/123', 'http://anilist.co/manga/123', 'https://user:pass@anilist.co/manga/123', 'https://anilist.co:444/manga/123', 'javascript:alert(1)', '//anilist.co/manga/123', '9'.repeat(30), 'x'.repeat(201)])('rejects unsafe or invalid identity: %s', value => {
    expect(trackingSearchQuery(value)).toBeUndefined();
  });
  it('preserves title search without deriving chapter numbers', () => {
    expect(trackingSearchQuery('  20th Century Boys  ')).toBe('20th Century Boys');
    expect(trackingSearchQuery('Berserk: The Prototype')).toBe('Berserk: The Prototype');
  });
  it('never displays raw remote error contents', () => {
    const message = trackingFailure(new Error('request failed https://callback/#access_token=secret'));
    expect(message).not.toContain('secret');
    expect(message).not.toContain('https://');
  });
  it('explains failed authorization separately from user cancellation', () => {
    expect(trackingFailure(new Error('authorization'))).toBe('AniList 授权未完成。请检查网络，以及 AniList 应用的 Client ID 和回调地址。');
    expect(trackingFailure(new Error('cancelled'))).toBe('已取消 AniList 授权。');
  });
});
