import {describe, expect, it} from 'vitest';
import {menuPosition} from './visual-viewport';

const anchor = {left: 280, right: 324, top: 200, bottom: 244, width: 44, height: 44};

describe('floating menu viewport placement', () => {
  it('keeps a wide menu inside a narrow phone viewport', () => {
    const result = menuPosition(anchor, {left: 0, top: 0, width: 320, height: 568}, 400, 500);
    expect(result.width).toBe(304);
    expect(result.left).toBe(8);
    expect(result.top + Math.min(500, result.maxHeight)).toBeLessThanOrEqual(560);
  });
  it('falls back from a reader side menu when the side gutter is too narrow', () => {
    const result = menuPosition({...anchor, left: 16, right: 60}, {left: 0, top: 0, width: 390, height: 844}, 280, 240, 'left');
    expect(result.width).toBe(280);
    expect(result.left).toBe(16);
    expect(result.top).toBe(250);
  });
  it('retains side placement when there is room on desktop', () => {
    const result = menuPosition({...anchor, left: 900, right: 944}, {left: 0, top: 0, width: 1200, height: 800}, 280, 240, 'left');
    expect(result.left).toBe(614);
    expect(result.top).toBe(102);
  });
  it('stays above the soft keyboard and accounts for a panned visual viewport', () => {
    const result = menuPosition({...anchor, top: 410, bottom: 454}, {left: 12, top: 180, width: 360, height: 300}, 280, 400);
    expect(result.left).toBeGreaterThanOrEqual(20);
    expect(result.left + result.width).toBeLessThanOrEqual(364);
    expect(result.top).toBeGreaterThanOrEqual(188);
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(472);
  });
  it('does not produce negative dimensions in a collapsed viewport', () => {
    const result = menuPosition(anchor, {left: 0, top: 0, width: 12, height: 12}, 280, 400);
    expect(result.width).toBe(0);
    expect(result.maxHeight).toBe(0);
  });
});
