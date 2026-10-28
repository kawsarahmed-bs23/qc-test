import { expect, type Locator, type Page } from '@playwright/test';
import type { Credentials } from '../config/environment';
import { IdentityLoginPage, IdentityTwoStepPage } from './IdentityLoginPage';

export class AppSignInPage {
  private readonly localEmail: Locator;
  private readonly identityEmail: Locator;

  constructor(private readonly page: Page) {
    this.localEmail = page.locator('#email');
    this.identityEmail = page.locator('input[type="email"]');
  }

  // Since QC-826 a signed-out visit goes straight to Identity before the app renders; older builds still show their own form at #/authentication.
  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.localEmail.or(this.identityEmail).first()).toBeVisible({ timeout: 30_000 });
  }

  async signIn(credentials: Credentials, authenticatorKey: string | null = null): Promise<void> {
    if (await this.localEmail.isVisible()) {
      await this.localEmail.fill(credentials.email);
      await this.page.locator('#password').fill(credentials.password);
      await this.page.getByRole('button', { name: 'Sign In' }).click();
      return;
    }

    const identityOrigin = new URL(this.page.url()).origin;
    await new IdentityLoginPage(this.page).signIn(credentials);
    await this.page.waitForURL((url) => url.origin !== identityOrigin || /\/Account\/LoginWith2fa/i.test(url.pathname), { timeout: 30_000 });
    if (/\/Account\/LoginWith2fa/i.test(new URL(this.page.url()).pathname)) {
      if (!authenticatorKey) {
        throw new Error(`Identity asks ${credentials.email} for two-step verification; set APP_ADMIN_AUTHENTICATOR_KEY in env/<env>.app.secrets.env.`);
      }
      await new IdentityTwoStepPage(this.page).verify(authenticatorKey);
    }
    await this.page.waitForURL((url) => url.origin !== identityOrigin, { timeout: 30_000 });
    await this.page.waitForLoadState('networkidle');
  }
}

export class DateStrip {
  readonly previousWeek: Locator;
  readonly nextWeek: Locator;

  constructor(private readonly page: Page) {
    this.previousWeek = page.locator('.week-nav-btn').first();
    this.nextWeek = page.locator('.week-nav-btn').last();
  }

  tab(sublabel: string): Locator {
    return this.page.locator('.date-tab', {
      has: this.page.locator('.tab-date', { hasText: new RegExp(`(^|\\s)${sublabel}$`) }),
    });
  }

  async select(date: Date): Promise<void> {
    const sublabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const weeks = isoWeeksBetween(new Date(), date);
    const step = weeks < 0 ? this.previousWeek : this.nextWeek;

    for (let i = 0; i < Math.abs(weeks); i++) {
      await step.click();
    }

    await this.tab(sublabel).click();
    await expect(this.tab(sublabel)).toHaveClass(/\bactive\b/);
  }
}

export class PlanVsLivePage {
  readonly dateStrip: DateStrip;
  readonly board: Locator;
  readonly planBars: Locator;
  readonly liveBars: Locator;

  constructor(private readonly page: Page) {
    this.dateStrip = new DateStrip(page);
    this.board = page.locator('app-schedule-timeline-board');
    this.planBars = page.locator('.ghost-bar');
    this.liveBars = page.locator('.cmp-bar');
  }

  async open(date: Date): Promise<void> {
    await this.page.goto('/#/dispatch/schedule-comparison');
    await expect(this.page.getByRole('heading', { name: 'Schedule — Plan vs Live' })).toBeVisible();
    await this.dateStrip.select(date);
  }

  capturedAt(): Locator {
    return this.page.locator('.cmp-asof');
  }

  shiftedPlanBar(): Locator {
    return this.planBars.filter({ hasText: /^Plan / });
  }

  liveBarOf(planBar: Locator): Locator {
    return planBar.locator('xpath=following-sibling::div[contains(concat(" ", normalize-space(@class), " "), " cmp-bar ")][1]');
  }

  planLabel(planBar: Locator): Locator {
    return planBar.locator('.ghost-label');
  }

  liveText(liveBar: Locator): Locator {
    return liveBar.locator(':scope > *');
  }

  async hoverPlanOnly(planBar: Locator, liveBar: Locator): Promise<void> {
    const plan = await boxOf(planBar);
    const live = await boxOf(liveBar);
    const planOnlyX =
      plan.x + plan.width > live.x + live.width
        ? (live.x + live.width + plan.x + plan.width) / 2
        : (plan.x + live.x) / 2;

    await this.page.mouse.move(planOnlyX, plan.y + plan.height / 2);
  }

  async hoverCentre(bar: Locator): Promise<void> {
    const box = await boxOf(bar);
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  }

  async moveAway(): Promise<void> {
    await this.page.mouse.move(5, 5);
  }

  async topmostIsInside(bar: Locator): Promise<boolean> {
    const box = await boxOf(bar);
    return bar.evaluate(
      (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
  }
}

export class TicketActivityPage {
  readonly dateStrip: DateStrip;
  readonly cards: Locator;

  constructor(private readonly page: Page) {
    this.dateStrip = new DateStrip(page);
    this.cards = page.locator('.driver-card');
  }

  async open(date: Date): Promise<void> {
    await this.page.goto('/#/dispatch/tickets');
    await expect(this.page.locator('.date-tab').first()).toBeVisible({ timeout: 30_000 });
    await this.dateStrip.select(date);
  }

  lastTicketTimes(): Locator {
    return this.cards.locator('.last-time');
  }

  async expand(card: Locator): Promise<void> {
    await card.locator('.driver-row').click();
    await expect(card.locator('.ticket-detail-list')).toBeVisible();
  }

  haulTimes(card: Locator): Locator {
    return card.locator('.ticket-detail-row .ticket-time');
  }
}

export class CommsPage {
  constructor(private readonly page: Page) {}

  async open(driverUserId: string): Promise<void> {
    await this.page.goto(`/#/dispatch/comms?driverId=${encodeURIComponent(driverUserId)}`);
  }

  message(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId}`);
  }

  messageTime(messageId: number): Locator {
    return this.message(messageId).locator('.msg-time').first();
  }

  bubble(messageId: number): Locator {
    return this.message(messageId).locator('.msg-bubble');
  }

  messageFooter(messageId: number): Locator {
    return this.message(messageId).locator('.msg-meta');
  }

  readReceipt(messageId: number): Locator {
    return this.messageFooter(messageId).locator('.msg-seen');
  }

  tooltip(): Locator {
    return this.page.locator('.mat-mdc-tooltip');
  }

  messageText(messageId: number): Locator {
    return this.message(messageId).locator('.msg-text');
  }

  footerTags(messageId: number): Locator {
    return this.messageFooter(messageId).locator('.msg-tag');
  }
}

export function formatAppDateTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';

  return `${part('month')}/${part('day')}/${part('year')} ${part('hour')}:${part('minute')}${part('dayPeriod').toUpperCase()}`;
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Element has no bounding box; it is not rendered.');
  }
  return box;
}

function isoWeeksBetween(from: Date, to: Date): number {
  const monday = (d: Date) => {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
    return copy;
  };
  const days = Math.round((monday(to).getTime() - monday(from).getTime()) / 86_400_000);
  return Math.round(days / 7);
}
