import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {inlineImageRect} from '../src/sources/shared/geometry';

class Rect {
  constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {}
  get left() {return this.x;} get right() {return this.x + this.width;}
  get top() {return this.y;} get bottom() {return this.y + this.height;}
}
const top = {} as Document;
beforeEach(() => {
  vi.stubGlobal('document', top); vi.stubGlobal('DOMRect', Rect);
  vi.stubGlobal('getComputedStyle', () => ({visibility: 'visible', opacity: '1'}));
});
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const frame = {ownerDocument: top, isConnected: true, checkVisibility: () => true,
    offsetWidth: 604, offsetHeight: 404, clientWidth: 600, clientHeight: 400, clientLeft: 2, clientTop: 2,
    getBoundingClientRect: () => new Rect(100, 50, 302, 202)};
  const doc = {defaultView: {frameElement: frame}} as unknown as Document;
  const image = {ownerDocument: doc, complete: true, naturalWidth: 800, naturalHeight: 1100,
    checkVisibility: () => true, getBoundingClientRect: () => new Rect(20, -100, 500, 700)} as unknown as HTMLImageElement;
  return {image, frame};
}
describe('inline image geometry across same-origin frames', () => {
  it('preserves top-level lookahead geometry', () => {
    const {image} = fixture(); Object.assign(image, {ownerDocument: top});
    expect(inlineImageRect(image)).toEqual(new Rect(20, -100, 500, 700));
  });
  it('maps borders and scaling to top coordinates and clips to the reader viewport', () => {
    const {image} = fixture();
    expect(inlineImageRect(image)).toEqual(new Rect(111, 51, 250, 200));
  });
  it('excludes hidden, detached, inaccessible and off-frame preloaded targets', () => {
    const {image, frame} = fixture();
    frame.checkVisibility = () => false; expect(inlineImageRect(image)).toBeUndefined();
    frame.checkVisibility = () => true; frame.isConnected = false; expect(inlineImageRect(image)).toBeUndefined();
    frame.isConnected = true; image.getBoundingClientRect = () => new Rect(0, 401, 500, 700) as DOMRect;
    expect(inlineImageRect(image)).toBeUndefined();
    Object.assign(image, {ownerDocument: {defaultView: {get frameElement() {throw Error('cross origin');}}}});
    expect(inlineImageRect(image)).toBeUndefined();
  });
});
