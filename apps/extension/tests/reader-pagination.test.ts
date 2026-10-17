import {describe, expect, it} from 'vitest';
import {pageSpreads, spreadAt, spreadFrames} from '../src/reader/pagination';

const portrait = {width: 800, height: 1200};
const landscape = {width: 1600, height: 1000};
const portraits = (count: number) => Array.from({length: count}, () => ({...portrait}));

describe('manga page spreads', () => {
  it.each([
    [0, []],
    [1, [{start: 0, end: 1}]],
    [2, [{start: 0, end: 1}, {start: 1, end: 2}]],
    [3, [{start: 0, end: 1}, {start: 1, end: 3}]],
    [4, [{start: 0, end: 1}, {start: 1, end: 3}, {start: 3, end: 4}]],
    [5, [{start: 0, end: 1}, {start: 1, end: 3}, {start: 3, end: 5}]],
  ])('keeps the cover separate and covers all %i pages exactly once', (count, expected) => {
    expect(pageSpreads(portraits(count as number))).toEqual(expected);
  });

  it('does not pair across a landscape page or pull an unpaired portrait from its previous group', () => {
    const pages = [landscape, portrait, landscape, portrait, portrait, landscape, landscape, portrait];
    expect(pageSpreads(pages)).toEqual([
      {start: 0, end: 1}, {start: 1, end: 2}, {start: 2, end: 3}, {start: 3, end: 5},
      {start: 5, end: 6}, {start: 6, end: 7}, {start: 7, end: 8},
    ]);
  });

  it('treats square and unknown dimensions as pairable placeholders without losing failed pages', () => {
    const pages = [portrait, {width: 0, height: 0}, {width: 900, height: 0}, {width: -2, height: 100},
      {width: NaN, height: 100}, {width: 100, height: Infinity}, {width: 100, height: 100}];
    expect(pageSpreads(pages)).toEqual([
      {start: 0, end: 1}, {start: 1, end: 3}, {start: 3, end: 5}, {start: 5, end: 7},
    ]);
  });

  it('starts a fresh cover in each chapter instead of joining the previous chapter tail', () => {
    expect(pageSpreads(portraits(2))).toEqual([{start: 0, end: 1}, {start: 1, end: 2}]);
    expect(pageSpreads(portraits(3))).toEqual([{start: 0, end: 1}, {start: 1, end: 3}]);
  });

  it('finds the same group from either member, including exact first and last boundaries', () => {
    const spreads = pageSpreads(portraits(1000));
    for (const spread of spreads) {
      for (let index = spread.start; index < spread.end; index++) expect(spreadAt(spreads, index)).toBe(spread);
    }
    expect(spreadAt(spreads, 0)).toBe(spreads[0]);
    expect(spreadAt(spreads, 999)).toBe(spreads.at(-1));
  });

  it.each([-1, .5, 3, Infinity, -Infinity, NaN])('rejects a nonexistent page index %s', index => {
    expect(spreadAt(pageSpreads(portraits(3)), index)).toBeUndefined();
    expect(spreadAt([], index)).toBeUndefined();
  });
});

describe('whole-spread frames', () => {
  it('has no frames for an empty chapter', () => {
    expect(spreadFrames([], {width: 1200, height: 800})).toEqual([]);
  });

  it('fits portraits of different proportions at the same height without stretching either image', () => {
    const pages = [{width: 800, height: 1200}, {width: 900, height: 1200}];
    const frames = spreadFrames(pages, {width: 1400, height: 800});
    expect(frames.map(frame => frame.height)).toEqual([776, 776]);
    for (let index = 0; index < pages.length; index++) {
      expect(frames[index].width / frames[index].height).toBeCloseTo(pages[index].width / pages[index].height);
    }
    expect(frames.reduce((sum, frame) => sum + frame.width, 0)).toBeLessThanOrEqual(1376);
  });

  it('gives a standalone landscape image the whole available width', () => {
    const [frame] = spreadFrames([landscape], {width: 1000, height: 900});
    expect(frame).toEqual({width: 976, height: 610});
  });

  it.each([false, true])('fits tall and narrow viewports without scroll overflow (comparison=%s)', compare => {
    for (const viewport of [{width: 390, height: 640}, {width: 1200, height: 80}, {width: 80, height: 1200}, {width: 25, height: 25}]) {
      const pages = [portrait, {width: 1000, height: 1900}];
      const frames = spreadFrames(pages, viewport, compare);
      expect(frames[0].height).toBe(frames[1].height);
      expect(frames.reduce((sum, frame) => sum + frame.width, 0)).toBeLessThanOrEqual(viewport.width - 24 + 1e-8);
      for (let index = 0; index < pages.length; index++) {
        expect(frames[index].height).toBeGreaterThan(0);
        expect(frames[index].height).toBeLessThanOrEqual(viewport.height - 24);
        expect(frames[index].width / frames[index].height).toBeCloseTo(pages[index].width / pages[index].height * (compare ? 2 : 1));
      }
    }
  });

  it('allocates two comparison panes per page without doubling a phone canvas width', () => {
    const viewport = {width: 390, height: 640};
    const normal = spreadFrames([portrait, portrait], viewport);
    const comparison = spreadFrames([portrait, portrait], viewport, true);
    expect(comparison[0].width).toBeCloseTo(normal[0].width);
    expect(comparison[0].height).toBeCloseTo(normal[0].height / 2);
    expect(comparison.reduce((sum, frame) => sum + frame.width, 0)).toBeCloseTo(366);
  });

  it.each([
    {width: 0, height: 1200}, {width: 800, height: 0}, {width: -1, height: 1200},
    {width: 800, height: -1}, {width: NaN, height: 1200}, {width: 800, height: Infinity},
  ])('uses a finite square fallback for unavailable source dimensions %j', page => {
    const [frame] = spreadFrames([page], {width: 600, height: 800});
    expect(frame).toEqual({width: 576, height: 576});
    const [comparison] = spreadFrames([page], {width: 600, height: 800}, true);
    expect(comparison).toEqual({width: 576, height: 288});
  });

  it.each([
    {width: 0, height: 800}, {width: 1200, height: 0}, {width: 24, height: 800},
    {width: 800, height: 24}, {width: 10, height: 10}, {width: NaN, height: 800}, {width: 800, height: Infinity},
  ])('keeps a temporarily unmeasurable viewport finite and nonnegative %j', viewport => {
    expect(spreadFrames([portrait, portrait], viewport)).toEqual([{width: 0, height: 0}, {width: 0, height: 0}]);
  });

  it('does not mutate page dimensions or spread boundaries', () => {
    const pages = Object.freeze([Object.freeze({...portrait}), Object.freeze({...portrait}), Object.freeze({...landscape})]);
    const spreads = Object.freeze(pageSpreads(pages).map(spread => Object.freeze(spread)));
    expect(spreadAt(spreads, 1)).toEqual({start: 1, end: 2});
    expect(() => spreadFrames(pages.slice(1), {width: 1000, height: 700}, true)).not.toThrow();
    expect(pages).toEqual([portrait, portrait, landscape]);
  });
});
