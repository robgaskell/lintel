import { beforeEach, describe, expect, it } from 'vitest';
import cases from './settings-merge-cases.json';
import { coreModule, eventModule, fakeStore, resetFakes } from './fakes';

type Case = (typeof cases)[number] & { replace?: Record<string, unknown> };

beforeEach(() => resetFakes());

// Rust's settings tests run the same cases (Ruling 280).
describe('the fake update_settings', () => {
  for (const c of cases as Case[]) {
    it(c.name, async () => {
      const store = fakeStore('settings.json');
      for (const [key, value] of Object.entries(c.stored)) store.data.set(key, value);
      const heard: unknown[] = [];
      await eventModule.listen('lintel://settings-changed', (e) => heard.push(e.payload));

      const written = (await coreModule.invoke('update_settings', {
        patch: c.patch,
        defaults: c.defaults,
        replace: c.replace,
      })) as { entries: unknown };

      expect(written.entries).toEqual(c.after);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const changes = Object.keys(c.changes).length ? [c.changes] : [];
      expect(heard.map((p) => (p as { changes: unknown }).changes)).toEqual(changes);
    });
  }
});
