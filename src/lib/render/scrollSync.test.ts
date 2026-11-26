import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanAnchors,
  createScrollLock,
  lineToOffset,
  offsetToLine,
  renderDelayMs,
} from './scrollSync';

const anchors = [
  { line: 10, top: 100 },
  { line: 20, top: 300 },
  { line: 30, top: 350 },
];

describe('lineToOffset', () => {
  it('interpolates between the anchors either side', () => {
    expect(lineToOffset(anchors, 15)).toBe(200);
    expect(lineToOffset(anchors, 25)).toBe(325);
  });

  it('gives an anchor its own top', () => {
    expect(lineToOffset(anchors, 20)).toBe(300);
  });

  it('clamps lines before the first and after the last anchor', () => {
    expect(lineToOffset(anchors, 1)).toBe(100);
    expect(lineToOffset(anchors, 99)).toBe(350);
  });

  it('gives 0 when there are no anchors', () => {
    expect(lineToOffset([], 7)).toBe(0);
  });
});

describe('offsetToLine', () => {
  it('inverts lineToOffset', () => {
    expect(offsetToLine(anchors, 200)).toBe(15);
    expect(offsetToLine(anchors, 325)).toBe(25);
    for (const line of [10, 12.5, 20, 27]) {
      expect(offsetToLine(anchors, lineToOffset(anchors, line))).toBeCloseTo(line);
    }
  });

  it('clamps offsets above the first and below the last anchor', () => {
    expect(offsetToLine(anchors, 0)).toBe(10);
    expect(offsetToLine(anchors, 9000)).toBe(30);
  });

  it('gives the earlier line where two anchors share a top', () => {
    const flat = [
      { line: 4, top: 50 },
      { line: 8, top: 50 },
      { line: 12, top: 90 },
    ];
    expect(offsetToLine(flat, 50)).toBe(4);
    expect(offsetToLine(flat, 70)).toBe(10);
    expect(offsetToLine([{ line: 1, top: 0 }, ...flat], 50)).toBe(4);
  });

  it('gives line 1 when there are no anchors', () => {
    expect(offsetToLine([], 120)).toBe(1);
  });
});

describe('cleanAnchors', () => {
  it('sorts by line and keeps the first top for a repeated line', () => {
    const raw = [
      { line: 20, top: 300 },
      { line: 10, top: 100 },
      { line: 20, top: 900 },
    ];
    expect(cleanAnchors(raw)).toEqual([
      { line: 10, top: 100 },
      { line: 20, top: 300 },
    ]);
  });

  it('drops a forged line whose top runs backwards', () => {
    // Raw HTML can claim any line number (Ruling 85).
    const raw = [
      { line: 1, top: 0 },
      { line: 5, top: 200 },
      { line: 6, top: 300 },
      { line: 3, top: 400 },
      { line: 9, top: 600 },
    ];
    expect(cleanAnchors(raw)).toEqual([
      { line: 1, top: 0 },
      { line: 5, top: 200 },
      { line: 6, top: 300 },
      { line: 9, top: 600 },
    ]);
  });

  it('keeps the longest run that agrees with page order when an early line is forged', () => {
    const raw = [
      { line: 1, top: 0 },
      { line: 999, top: 100 },
      { line: 5, top: 200 },
      { line: 9, top: 300 },
    ];
    expect(cleanAnchors(raw)).toEqual([
      { line: 1, top: 0 },
      { line: 5, top: 200 },
      { line: 9, top: 300 },
    ]);
  });

  it('drops line 0 and values that are not finite', () => {
    const raw = [
      { line: 0, top: 0 },
      { line: 2, top: Number.NaN },
      { line: 3, top: 30 },
    ];
    expect(cleanAnchors(raw)).toEqual([{ line: 3, top: 30 }]);
  });
});

describe('renderDelayMs', () => {
  it('is 150 ms plus 50 ms per MB of 1,000,000 bytes', () => {
    expect(renderDelayMs(0)).toBe(150);
    expect(renderDelayMs(1_000_000)).toBe(200);
    expect(renderDelayMs(4_000_000)).toBe(350);
  });
});

describe('createScrollLock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips exactly the next scroll event after hold, then lets events through', () => {
    const lock = createScrollLock(300);
    expect(lock.skip()).toBe(false);

    lock.hold();
    expect(lock.skip()).toBe(true);
    expect(lock.skip()).toBe(false);
  });

  it('still skips a late echo inside the fallback', () => {
    const lock = createScrollLock(300);
    lock.hold();
    vi.advanceTimersByTime(299);
    expect(lock.skip()).toBe(true);
  });

  it('gives up after the fallback when the programmatic scroll caused no event', () => {
    const lock = createScrollLock(300);
    lock.hold();
    vi.advanceTimersByTime(300);
    expect(lock.skip()).toBe(false);
  });
});
