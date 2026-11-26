<script lang="ts">
  import { stringify } from 'yaml';

  let { data, error }: { data: Record<string, unknown> | null; error: string | null } = $props();

  type Row =
    | { key: string; kind: 'text'; text: string; code: boolean }
    | { key: string; kind: 'pills'; items: string[] }
    | { key: string; kind: 'yaml'; text: string };

  const rows = $derived(Object.entries(data ?? {}).map(([key, value]) => toRow(key, value)));

  function isScalar(value: unknown): value is string | number | boolean {
    return ['string', 'number', 'boolean'].includes(typeof value);
  }

  function toRow(key: string, value: unknown): Row {
    if (value === null || value === undefined) return { key, kind: 'text', text: '', code: false };
    if (isScalar(value)) {
      const text = String(value);
      // Identifiers such as a skill name read better in monospace, as in the artboard.
      return { key, kind: 'text', text, code: typeof value !== 'string' || !/\s/.test(text) };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isScalar)) {
      return { key, kind: 'pills', items: value.map(String) };
    }
    return { key, kind: 'yaml', text: stringify(value).trimEnd() };
  }
</script>

{#if error || rows.length > 0}
  <section class="front-matter" aria-label="Front matter">
    <div class="fm-title">Front matter</div>
    {#if error}
      <div class="fm-error">{error}</div>
    {:else}
      <div class="fm-grid">
        {#each rows as row, i (i)}
          <span class="fm-key">{row.key}</span>
          {#if row.kind === 'pills'}
            <span class="fm-value fm-pills">
              {#each row.items as item, j (j)}<span class="fm-pill">{item}</span>{/each}
            </span>
          {:else if row.kind === 'yaml'}
            <pre class="fm-value fm-yaml">{row.text}</pre>
          {:else}
            <span class="fm-value" class:fm-code={row.code}>{row.text}</span>
          {/if}
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .front-matter {
    margin-bottom: 28px;
    padding: 14px 16px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.5;
  }

  .fm-title {
    margin-bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--card-label);
  }

  .fm-grid {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    row-gap: 6px;
    column-gap: 12px;
  }

  .fm-key {
    color: var(--card-label);
    overflow-wrap: anywhere;
  }

  .fm-value {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .fm-code,
  .fm-yaml {
    font-family: var(--font-edit);
  }

  .fm-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .fm-pill {
    padding: 0 8px;
    border-radius: 999px;
    background: var(--pill-bg);
    font-size: 12px;
  }

  .fm-yaml {
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
  }

  .fm-error {
    color: var(--card-label);
  }
</style>
