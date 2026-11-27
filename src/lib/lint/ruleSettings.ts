import { settings, updateSettings } from '../settings/settings.svelte';
import { findRule, ruleKey } from './ruleNames';
import type { LintRule } from './rules';

/** Whether `rules` (as settings hold them) turn `rule` on. Tags such as `headings` are not read. */
export function ruleIsOn(rules: Record<string, boolean | object>, rule: LintRule): boolean {
  const value = rules[ruleKey(rule)];
  if (value === undefined) return rules.default !== false;
  return value !== false && !(isRecord(value) && value.enabled === false);
}

/**
 * Turns a rule on or off in Settings under its first alias, and deletes any other key
 * naming it, so the two can never disagree (Ruling 270). A rule with options keeps them.
 */
export function setRuleOn(name: string, on: boolean): Promise<void> {
  const rule = findRule(name);
  if (!rule) return Promise.reject(new Error(`There is no lint rule called ${name}.`));
  const key = ruleKey(rule);
  const current = settings.lint.rules[key];
  // A JSON copy, as the stored value is a reactive proxy.
  const value = isRecord(current) ? { ...JSON.parse(JSON.stringify(current)), enabled: on } : on;
  const rules: Record<string, boolean | object | null> = { [key]: value };
  for (const other of [rule.id, ...rule.aliases]) if (other !== key) rules[other] = null;
  return updateSettings({ lint: { rules } });
}

/** "Turn off this rule": writes `settings.lint.rules[alias] = false`. */
export function disableRule(alias: string): Promise<void> {
  return setRuleOn(alias, false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
