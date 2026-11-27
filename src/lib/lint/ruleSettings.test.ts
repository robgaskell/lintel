import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeStore, resetFakes } from '../../test/fakes';
import { loadSettings, settings } from '../settings/settings.svelte';
import { findRule } from './ruleNames';
import { disableRule, ruleIsOn, setRuleOn } from './ruleSettings';

vi.mock('@tauri-apps/plugin-store', () => import('../../test/fakes').then((f) => f.storeModule));
vi.mock('@tauri-apps/api/event', () => import('../../test/fakes').then((f) => f.eventModule));
vi.mock('@tauri-apps/api/core', () => import('../../test/fakes').then((f) => f.coreModule));

const store = () => fakeStore('settings.json');
const md004 = findRule('MD004')!;

beforeEach(async () => {
  resetFakes();
  await loadSettings();
});

describe('disableRule', () => {
  it('writes the alias as false (spec: rules[alias])', async () => {
    await disableRule('ul-style');

    expect(await store().get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
    expect(settings.lint.rules['ul-style']).toBe(false);
  });

  it('removes a key naming the rule by ID, so the two cannot disagree (Ruling 270)', async () => {
    store().data.set('lint', { enabled: true, rules: { default: true, MD004: true } });

    await disableRule('ul-style');

    expect(await store().get('lint')).toEqual({ enabled: true, rules: { default: true, 'ul-style': false } });
  });

  it('removes every other alias of a rule with two', async () => {
    store().data.set('lint', { enabled: true, rules: { 'single-h1': true } });

    await disableRule('single-title');

    expect((await store().get<{ rules: object }>('lint'))!.rules).toEqual({ default: true, 'single-title': false });
  });
});

describe('setRuleOn', () => {
  it('keeps the options of a rule that has them', async () => {
    store().data.set('version', 1);
    store().data.set('lint', { enabled: true, rules: { MD013: { line_length: 120 } } });
    await loadSettings();

    await setRuleOn('line-length', false);

    expect((await store().get<{ rules: object }>('lint'))!.rules).toEqual({
      default: true,
      'line-length': { line_length: 120, enabled: false },
    });
  });

  it('refuses a name that is no rule', async () => {
    await expect(setRuleOn('no-such-rule', false)).rejects.toThrow('no lint rule called no-such-rule');
  });
});

describe('ruleIsOn', () => {
  it('follows the rule key, then `default`', () => {
    expect(ruleIsOn({ default: true }, md004)).toBe(true);
    expect(ruleIsOn({ default: false }, md004)).toBe(false);
    expect(ruleIsOn({}, md004)).toBe(true);
    expect(ruleIsOn({ default: false, 'ul-style': true }, md004)).toBe(true);
    expect(ruleIsOn({ 'ul-style': false }, md004)).toBe(false);
    expect(ruleIsOn({ 'ul-style': { style: 'dash' } }, md004)).toBe(true);
    expect(ruleIsOn({ 'ul-style': { enabled: false } }, md004)).toBe(false);
  });
});
