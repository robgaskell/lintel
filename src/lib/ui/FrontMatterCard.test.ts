import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import FrontMatterCard from './FrontMatterCard.svelte';

function card(data: Record<string, unknown> | null, error: string | null = null) {
  return render(FrontMatterCard, { data, error }).container;
}

describe('FrontMatterCard', () => {
  it('shows keys and values, with a list of words as pills', () => {
    const container = card({ name: 'x', tools: ['Bash', 'Read'] });

    expect(container.textContent).toContain('name');
    expect(container.textContent).toContain('x');
    const pills = container.querySelectorAll('.fm-pill');
    expect([...pills].map((p) => p.textContent)).toEqual(['Bash', 'Read']);
  });

  it('shows the YAML error as one line', () => {
    const container = card(null, 'bad indent');

    expect(container.textContent).toContain('bad indent');
    expect(container.querySelector('.fm-error')?.textContent).toBe('bad indent');
  });

  it('renders nothing without front matter', () => {
    expect(card(null).children).toHaveLength(0);
  });

  it('renders nothing for an empty block', () => {
    expect(card({}).children).toHaveLength(0);
  });

  it('shows nested values as compact YAML', () => {
    const container = card({ meta: { owner: 'rob', tags: [{ a: 1 }] } });

    expect(container.querySelector('.fm-yaml')?.textContent).toBe('owner: rob\ntags:\n  - a: 1');
    expect(container.querySelectorAll('.fm-pill')).toHaveLength(0);
  });

  it('shows numbers and booleans as text, and a key without a value as empty', () => {
    const container = card({ version: 2, draft: false, empty: null });
    const values = [...container.querySelectorAll('.fm-value')].map((v) => v.textContent);

    expect(values).toEqual(['2', 'false', '']);
  });

  it('never runs markup found in a value', () => {
    const container = card({ title: '<img src=x onerror=alert(1)>' });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
