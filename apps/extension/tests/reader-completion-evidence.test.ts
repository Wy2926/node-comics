import {describe, expect, it, vi} from 'vitest';
import {CompletionEvidence, pageKey} from '../src/reader/completion-evidence';

const chapter = {id: 'chapter', contentId: 'content', generation: 1, pages: Array.from({length: 10}, (_, index) => ({id: `page-${index}`}))};
const viewport = {top: 0, bottom: 100, left: 0, right: 100};
function fixture() {
  const evidence = new CompletionEvidence(); let scrollTop = 0;
  const bounds = vi.fn((cell: string) => {
    const index = chapter.pages.findIndex(page => pageKey(chapter, page.id) === cell);
    return {top: index * 100 - scrollTop, bottom: (index + 1) * 100 - scrollTop, left: 0, right: 100};
  });
  for (const page of chapter.pages) evidence.display(chapter, page.id, true);
  return {evidence, bounds, observe: (index: number, foreground = true) => {scrollTop = index * 100; evidence.observe(viewport, bounds, foreground);}};
}

describe('foreground reader completion evidence', () => {
  it('does not count offscreen preloads when jumping from the first page to the end', () => {
    const {evidence, observe, bounds} = fixture();
    observe(0); observe(9);
    expect(evidence.complete(chapter)).toBe(false);
    expect(bounds).toHaveBeenCalledTimes(20); // Two events, each inspects only the ten mounted images.
  });
  it('ignores hidden-tab display and scrolling, and only observes the current viewport on returning', () => {
    const {evidence, observe, bounds} = fixture();
    for (let page = 0; page < 10; page++) observe(page, false);
    expect(bounds).not.toHaveBeenCalled();
    observe(9);
    expect(evidence.complete(chapter)).toBe(false);
  });
  it('accepts a complete visible reading and keeps its evidence across successful image remounts', () => {
    const {evidence, observe} = fixture();
    for (let page = 0; page < 10; page++) observe(page);
    for (const page of chapter.pages) evidence.display(chapter, page.id, false);
    expect(evidence.complete(chapter)).toBe(true);
  });
  it('requires a fresh complete traverse after an explicit reread reset without reloading images', () => {
    const {evidence, observe, bounds} = fixture();
    for (let page = 0; page < 10; page++) observe(page);
    expect(evidence.complete(chapter)).toBe(true);
    evidence.reset(chapter);
    expect(evidence.complete(chapter)).toBe(false);
    bounds.mockClear(); observe(0);
    expect(bounds).toHaveBeenCalledTimes(10); // Already-loaded images remain available for new observations.
    expect(evidence.complete(chapter)).toBe(false);
    observe(9);
    expect(evidence.complete(chapter)).toBe(false);
    for (let page = 1; page < 9; page++) observe(page);
    expect(evidence.complete(chapter)).toBe(true);
  });
  it('does not count a failed image and cannot transfer evidence across content generations', () => {
    const {evidence, observe} = fixture();
    evidence.display(chapter, 'page-5', false);
    for (let page = 0; page < 10; page++) observe(page);
    expect(evidence.complete(chapter)).toBe(false);
    evidence.display(chapter, 'page-5', true); observe(5);
    expect(evidence.complete(chapter)).toBe(true);
    expect(evidence.complete({...chapter, generation: 2})).toBe(false);
    expect(evidence.complete({...chapter, contentId: 'replacement'})).toBe(false);
  });
  it('ignores late old-generation unloads and retains only the current bounded chapter window', () => {
    const evidence = new CompletionEvidence(), next = {...chapter, generation: 2, pages: [chapter.pages[0]]};
    evidence.display(next, 'page-0', true); evidence.display(chapter, 'page-0', false);
    const bounds = vi.fn(() => viewport);
    evidence.observe(viewport, bounds, true);
    expect(evidence.complete(next)).toBe(true);
    evidence.retain([{...next, id: 'other-chapter'}]); bounds.mockClear();
    evidence.observe(viewport, bounds, true);
    expect(bounds).not.toHaveBeenCalled(); expect(evidence.complete(next)).toBe(false);
  });
  it('requires actual intersection, not a zero-size or merely touching image box', () => {
    const evidence = new CompletionEvidence(), one = {...chapter, pages: [chapter.pages[0]]};
    evidence.display(one, 'page-0', true);
    for (const box of [{...viewport, bottom: 0}, {...viewport, right: 0}, {...viewport, top: 100, bottom: 200}, {...viewport, left: 100, right: 200}]) {
      evidence.observe(viewport, () => box, true); expect(evidence.complete(one)).toBe(false);
    }
    evidence.observe(viewport, () => viewport, true); expect(evidence.complete(one)).toBe(true);
  });
});
