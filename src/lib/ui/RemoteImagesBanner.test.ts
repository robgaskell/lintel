import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import RemoteImagesBanner from './RemoteImagesBanner.svelte';

function banner() {
  const props = { onLoad: vi.fn(), onAlwaysLoad: vi.fn(), onDismiss: vi.fn() };
  return { ...render(RemoteImagesBanner, props), ...props };
}

describe('RemoteImagesBanner', () => {
  it("says why the images are blocked, in the spec's words", () => {
    const { getByRole } = banner();

    expect(getByRole('status').textContent?.replace(/\s+/g, ' ')).toContain(
      'This document has remote images. They were blocked to protect your privacy.',
    );
  });

  it('calls one handler per button', async () => {
    const { getByRole, onLoad, onAlwaysLoad, onDismiss } = banner();

    await fireEvent.click(getByRole('button', { name: 'Load images' }));
    expect(onLoad).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Always load' }));
    expect(onAlwaysLoad).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Keep images blocked' }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onLoad).toHaveBeenCalledOnce();
  });
});
