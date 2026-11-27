<script lang="ts">
  import { LINT_RULES } from '../lib/lint/rules';
  import { ruleKey } from '../lib/lint/ruleNames';
  import { ruleIsOn, setRuleOn } from '../lib/lint/ruleSettings';
  import { settings } from '../lib/settings/settings.svelte';
  import { save, track } from './save.svelte';
</script>

<div class="field">
  <label class="switch-row">
    <input
      type="checkbox"
      role="switch"
      checked={settings.lint.enabled}
      onchange={(e) => save({ lint: { enabled: e.currentTarget.checked } })}
    />
    Lint documents with markdownlint
  </label>
</div>

<div class="field">
  <span class="field-label" id="lint-rules-label">Rules</span>
  <ul class="rules" aria-labelledby="lint-rules-label">
    {#each LINT_RULES as rule (rule.id)}
      <li>
        <label class="switch-row">
          <input
            type="checkbox"
            role="switch"
            aria-describedby="rule-{rule.id}"
            checked={ruleIsOn(settings.lint.rules, rule)}
            onchange={(e) => track(setRuleOn(ruleKey(rule), e.currentTarget.checked))}
          />
          <span class="rule-name">{rule.id} {ruleKey(rule)}</span>
        </label>
        <span class="hint" id="rule-{rule.id}">{rule.description}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .switch-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .switch-row input {
    margin: 0;
    accent-color: var(--accent);
  }

  .rules {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rules li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .rules .hint {
    padding-left: 21px;
  }

  .rule-name {
    font-family: var(--font-edit);
    font-size: 12px;
  }
</style>
