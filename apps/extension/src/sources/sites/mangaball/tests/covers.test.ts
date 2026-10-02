import {describe, expect, it} from 'vitest';
import {cover} from '../protocol';
import {parseCatalog} from '../network';
import {title, titleId, groups} from './fixtures';

const original = 'https://uploads.mangadex.org/covers/c5015e2e-b636-41f0-a462-f98af24cf3a3/28d63e87-71ea-4714-8a9e-2a3060f2eb92.png';
const copy = {path: titleId + '/cover_123.jpg'};
describe('MangaBall source-provided dedicated covers', () => {
  it('prefers the explicit original artwork in validated title metadata', () => {
    const value=title();value.data.image={...value.data.image,cdn_mangadex:original} as typeof value.data.image;
    expect(parseCatalog(value,groups(),titleId).cover).toEqual({url:original});
    expect(cover({cdn_mangadex:original})).toEqual({url:original});
  });
  it('accepts dedicated originals from any public HTTP image address', () => {
    const url='https://art.example.test:8443/title/cover.png?size=original';
    expect(cover({cdn_mangadex:url,cover:copy})).toEqual({url});
    expect(cover({cover:{path:'https://other.example.test/cover.png'}})).toEqual({url:'https://other.example.test/cover.png'});
    for(const cdn_mangadex of [undefined,'javascript:alert(1)','ftp://images.example.test/cover.png',
      original.replace('uploads.','user:pass@uploads.')])
      expect(cover({cdn_mangadex,cover:copy})?.url).toBe('https://bulbasaur.poke-black-and-white.net/covers/'+copy.path);
  });
});
