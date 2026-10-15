import {describe, expect, it} from 'vitest';
import {sessionAnchor} from './session-model';

describe('temporary reader anchors', () => {
  const pages = [{id: 'source:0'}, {id: 'source:1'}, {id: 'source:2'}];
  it('retains page identity and its fractional offset when pages are appended or reordered', () => {
    const anchor = {pageId: 'source:1', relativeOffset: .42};
    expect(sessionAnchor(pages, anchor)).toEqual(anchor);
    expect(sessionAnchor([...pages.slice(1), pages[0]], anchor)).toEqual(anchor);
    expect(sessionAnchor([...pages, {id: 'source:3'}], anchor)).toEqual(anchor);
  });
  it('does not apply an offset to a replacement page after the old slot disappears', () => {
    expect(sessionAnchor(pages, {pageId: 'old-document:1', relativeOffset: .9})).toEqual({pageId: 'source:0', relativeOffset: 0});
    expect(sessionAnchor([], {pageId: 'source:1', relativeOffset: .9})).toEqual({pageId: '', relativeOffset: 0});
  });
  it.each([[NaN, 0], [Infinity, 0], [-.2, 0], [1.3, 1], [.6, .6]])('bounds invalid offset %s', (offset, expected) => {
    expect(sessionAnchor(pages, {pageId: 'source:1', relativeOffset: offset})).toEqual({pageId: 'source:1', relativeOffset: expected});
  });
});
