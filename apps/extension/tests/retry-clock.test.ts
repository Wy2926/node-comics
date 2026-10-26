import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const hooks = vi.hoisted(() => ({refresh: vi.fn(), deadline: undefined as number | undefined, mounted: false, cleanup: undefined as (() => void) | undefined}));
vi.mock('react', () => ({
  useReducer: () => [0, hooks.refresh],
  useEffect: (effect: () => void | (() => void), [deadline]: [number]) => {
    if (!hooks.mounted || deadline !== hooks.deadline) {
      hooks.cleanup?.(); hooks.deadline = deadline; hooks.mounted = true;
      hooks.cleanup = effect() || undefined;
    }
  },
}));
import {useRetryClock} from '../src/ui/useRetryClock';

beforeEach(() => {hooks.mounted = false; hooks.cleanup = undefined; hooks.refresh.mockClear(); vi.useFakeTimers(); vi.setSystemTime(10_000);});
afterEach(() => {hooks.cleanup?.(); vi.useRealTimers();});

it.each([undefined, 0, 9_000, 10_000, Infinity, NaN])('does no periodic work without a future deadline: %s', deadline => {
  expect(useRetryClock(deadline)).toBe(10_000);
  vi.advanceTimersByTime(10_000);
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('updates a visible countdown, then releases its timer when retry becomes available', () => {
  useRetryClock(12_500);
  vi.advanceTimersByTime(1_000);
  expect(Math.ceil((12_500 - useRetryClock(12_500)) / 1000)).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(2_000);
  expect(hooks.refresh).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(20_000);
  expect(hooks.refresh).toHaveBeenCalledTimes(3);
});

it('replaces a changed deadline and cancels updates when the countdown is hidden', () => {
  useRetryClock(12_000);
  vi.advanceTimersByTime(500);
  useRetryClock(15_000);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(500);
  expect(hooks.refresh).not.toHaveBeenCalled();
  useRetryClock(0);
  vi.advanceTimersByTime(10_000);
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(useRetryClock(15_000)).toBe(21_000);
  expect(vi.getTimerCount()).toBe(0);
});

it('clears the pending timer on unmount', () => {
  useRetryClock(30_000); hooks.cleanup?.();
  vi.advanceTimersByTime(10_000);
  expect(hooks.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
