import { describe, expect, it } from 'vitest';

describe('jsdom layout stubs (Ruling 176)', () => {
  it('lets CodeMirror measure text ranges without throwing', () => {
    const text = document.createTextNode('abc');
    document.body.append(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);

    expect(range.getClientRects()).toHaveLength(0);
    expect(range.getBoundingClientRect()).toMatchObject({ top: 0, left: 0, width: 0, height: 0 });
    text.remove();
  });
});
