import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';

export interface PasswordPolicy {
  requiredLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireNonAlphanumeric: boolean;
  requiredUniqueChars: number;
}

export type PasswordRuleKind = 'length' | 'upper' | 'lower' | 'digit' | 'symbol' | 'unique';

/** Identity's password options, as the Driver App reads them (GET /api/account/password/policy). */
export async function passwordPolicy(request: APIRequestContext): Promise<PasswordPolicy> {
  const response = await request.get(`${env.identityUrl}/api/account/password/policy`);
  expect(response.ok(), 'password policy').toBe(true);
  return response.json();
}

/** The rules the page should list, in order, with the English text of Identity's Identity_Password* strings. */
export function expectedRules(policy: PasswordPolicy): { kind: PasswordRuleKind; text: string }[] {
  const rules: { kind: PasswordRuleKind; text: string }[] = [];
  if (policy.requiredLength > 0) rules.push({ kind: 'length', text: `Passwords must be at least ${policy.requiredLength} characters.` });
  if (policy.requireUppercase) rules.push({ kind: 'upper', text: "Passwords must have at least one uppercase letter ('A'-'Z')." });
  if (policy.requireLowercase) rules.push({ kind: 'lower', text: "Passwords must have at least one lowercase letter ('a'-'z')." });
  if (policy.requireDigit) rules.push({ kind: 'digit', text: "Passwords must have at least one number ('0'-'9')." });
  if (policy.requireNonAlphanumeric) rules.push({ kind: 'symbol', text: 'Passwords must have at least one symbol.' });
  if (policy.requiredUniqueChars > 1) rules.push({ kind: 'unique', text: `Passwords must use at least ${policy.requiredUniqueChars} different characters.` });
  return rules;
}

/** A password that meets every rule of the policy. */
export function validPassword(policy: PasswordPolicy): string {
  const base = 'Qc1032!aB9';
  const padding = 'xYz7#mNp4$';
  let password = base;
  while (password.length < Math.max(policy.requiredLength, policy.requiredUniqueChars)) password += padding;
  return password;
}

/** A password that breaks only the given rule. */
export function passwordMissing(kind: PasswordRuleKind, policy: PasswordPolicy): string {
  const valid = validPassword(policy);
  switch (kind) {
    case 'length':
      return valid.slice(0, policy.requiredLength - 1);
    case 'upper':
      return valid.toLowerCase();
    case 'lower':
      return valid.toUpperCase();
    case 'digit':
      return valid.replace(/[0-9]/g, 'k');
    case 'symbol':
      return valid.replace(/[^A-Za-z0-9]/g, 'k');
    case 'unique':
      return 'Aa1!'.padEnd(Math.max(policy.requiredLength, policy.requiredUniqueChars - 1), 'A');
  }
}

/** QC-1032: the rule list under the new password field on /Account/ResetPassword and /invite. */
export class PasswordRulesPanel {
  readonly list: Locator;
  readonly password: Locator;
  readonly confirmPassword: Locator;

  constructor(
    private readonly page: Page,
    readonly submit: Locator,
  ) {
    this.list = page.locator('ul.qc-password-rules[data-qc-password-rules="Input_Password"]');
    this.password = page.locator('#Input_Password');
    this.confirmPassword = page.locator('#Input_ConfirmPassword');
  }

  rule(kind: PasswordRuleKind): Locator {
    return this.list.locator(`li[data-qc-rule="${kind}"]`);
  }

  async expectRulesShown(policy: PasswordPolicy): Promise<void> {
    const rules = expectedRules(policy);
    await expect(this.list).toBeVisible();
    await expect(this.list.locator('li')).toHaveText(rules.map((r) => `${r.text} (Not met yet)`));
    await expect(this.list.locator('li.met')).toHaveCount(0);
    await expect(this.password).toHaveAttribute('aria-describedby', /Input_Password_rules/);
    await expect(this.submit).toBeDisabled();
  }

  async type(password: string, confirm = password): Promise<void> {
    await this.password.fill(password);
    await this.confirmPassword.fill(confirm);
  }

  async expectOnlyUnmet(kind: PasswordRuleKind, policy: PasswordPolicy): Promise<void> {
    for (const rule of expectedRules(policy)) {
      if (rule.kind === kind) {
        await expect(this.rule(rule.kind), `${rule.kind} is marked unmet`).not.toHaveClass(/\bmet\b/);
        await expect(this.rule(rule.kind).locator('.qc-rule-state'), `${rule.kind} reads as not met`).toHaveText('(Not met yet)');
      } else await expect(this.rule(rule.kind), `${rule.kind} is marked met`).toHaveClass(/\bmet\b/);
    }
    await expect(this.submit).toBeDisabled();
  }

  /** Each broken rule keeps the button gray and is the only rule marked unmet; a mismatched confirm does too; a valid pair turns it on. */
  async expectGating(policy: PasswordPolicy): Promise<void> {
    for (const rule of expectedRules(policy)) {
      const password = passwordMissing(rule.kind, policy);
      await this.type(password);
      await this.expectOnlyUnmet(rule.kind, policy);
    }
    const valid = validPassword(policy);
    await this.type(valid, `${valid}x`);
    await expect(this.list.locator('li:not(.met)')).toHaveCount(0);
    await expect(this.list.locator('.qc-rule-state')).toHaveText(expectedRules(policy).map(() => '(Met)'));
    await expect(this.submit).toBeDisabled();
    await this.type(valid);
    await expect(this.submit).toBeEnabled();
  }

  async expectRuleText(kind: PasswordRuleKind, text: string): Promise<void> {
    await expect(this.rule(kind)).toContainText(text);
  }

  /** At phone width the rules are visible and the page does not scroll sideways. */
  async expectFitsPhone(): Promise<void> {
    await this.page.setViewportSize({ width: 375, height: 812 });
    await expect(this.list).toBeVisible();
    for (const item of await this.list.locator('li').all()) await expect(item).toBeInViewport();
    expect(await this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true);
  }
}
