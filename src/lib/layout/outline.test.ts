import { beforeEach, describe, expect, it } from 'vitest';
import {
  outline,
  resetOutlineWidth,
  restoreOutlineWidth,
  setOutlineWidth,
  shownOutlineWidth,
} from './outline.svelte';

beforeEach(() => {
  outline.width = 210;
});

describe('outline width (v0.2 item 8)', () => {
  it('starts expanded at 210 px', () => {
    expect(outline.collapsed).toBe(false);
    expect(outline.width).toBe(210);
  });

  it('clamps a dragged width to 160-480 and rounds it', () => {
    setOutlineWidth(300.6);
    expect(outline.width).toBe(301);
    setOutlineWidth(1000);
    expect(outline.width).toBe(480);
    setOutlineWidth(20);
    expect(outline.width).toBe(160);
  });

  it('ignores a width that is not a number', () => {
    setOutlineWidth(300);
    setOutlineWidth(Number.NaN);
    expect(outline.width).toBe(300);
  });

  it('resets to 210 px', () => {
    setOutlineWidth(400);
    resetOutlineWidth();
    expect(outline.width).toBe(210);
  });

  it.each([
    ['missing', undefined],
    ['above 480', 600],
    ['below 160', 100],
    ['not whole', 250.5],
    ['not a number', 'x'],
  ])('restores 210 for a saved width that is %s', (_, saved) => {
    expect(restoreOutlineWidth(saved)).toBe(210);
  });

  it('restores a saved whole width inside 160-480 as it is', () => {
    expect(restoreOutlineWidth(300)).toBe(300);
    expect(restoreOutlineWidth(160)).toBe(160);
    expect(restoreOutlineWidth(480)).toBe(480);
  });
});

describe('shown outline width (Ruling 15 of the v0.2 ledger)', () => {
  it.each([
    [480, 480, 160],
    [480, 600, 280],
    [250, 600, 250],
    [480, 800, 480],
    [480, 1200, 480],
    [300, 400, 160],
  ])('shows a saved %i px column at %i px of window as %i px', (saved, windowWidth, shown) => {
    expect(shownOutlineWidth(saved, windowWidth)).toBe(shown);
  });
});
