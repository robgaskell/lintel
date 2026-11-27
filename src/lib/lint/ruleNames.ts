import { LINT_RULES, type LintRule } from './rules';

// markdownlint matches rule names in any case.
const byName = new Map<string, LintRule>(
  LINT_RULES.flatMap((rule) => [rule.id, ...rule.aliases].map((name) => [name.toLowerCase(), rule] as const)),
);

/** The rule an ID or alias names, in any case. */
export function findRule(name: string): LintRule | undefined {
  return byName.get(name.toLowerCase());
}

/** The one key settings keep for a rule (Ruling 270). */
export function ruleKey(rule: LintRule): string {
  return rule.aliases[0] ?? rule.id;
}

/**
 * Renames every key that names a rule to that rule's first alias, so each rule has one key.
 * If a rule is named twice, the first alias wins, else the last name. Other keys, such as
 * `default` or tags, stay. Values other than a boolean, an object, "error" or "warning"
 * are dropped; markdownlint takes those two severities as "on" (Ruling 281).
 */
export function normaliseRules(rules: Record<string, unknown>): Record<string, boolean | object> {
  const out: Record<string, boolean | object> = {};
  const exact = new Set<string>();
  for (const [name, value] of Object.entries(rules)) {
    if (!isRuleValue(value)) continue;
    const rule = findRule(name);
    if (!rule) {
      out[name] = value;
      continue;
    }
    const key = ruleKey(rule);
    if (name === key) exact.add(key);
    else if (exact.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// The severities are kept as written, though settings type rules as boolean or object.
function isRuleValue(value: unknown): value is boolean | object {
  if (value === 'error' || value === 'warning') return true;
  return typeof value === 'boolean' || (typeof value === 'object' && value !== null && !Array.isArray(value));
}
