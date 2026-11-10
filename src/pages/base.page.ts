import { expect, test, type Locator, type Page } from '@playwright/test';
import { createLogger, type Logger } from '@utils/logger';

/**
 * Shared behaviour for page objects. New page objects extend this, declare their `path`
 * (relative to the project's baseURL: Admin for `chromium`, the host app for `app`) and expose
 * intent-revealing actions and `assert*` methods built on accessible locators.
 *
 * Page objects written before this class existed do not extend it yet; move them over when you
 * next change them.
 */
export abstract class BasePage {
  /** Path relative to `baseURL` (set per project in playwright.config.ts). */
  protected abstract readonly path: string;
  protected readonly log: Logger;

  constructor(protected readonly page: Page) {
    this.log = createLogger(this.constructor.name);
  }

  /** Navigates to this page's path and waits for the DOM to be ready. */
  async goto(): Promise<void> {
    this.log.info(`Navigating to ${this.path}`);
    await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
  }

  async waitForURL(url: string | RegExp = this.urlPattern()): Promise<void> {
    await this.page.waitForURL(url);
  }

  async assertOnPage(): Promise<void> {
    await expect(this.page).toHaveURL(this.urlPattern());
  }

  /** Waits for a response whose URL matches the pattern (useful around form submits). */
  async waitForResponse(urlPattern: string | RegExp, status = 200): Promise<void> {
    await this.page.waitForResponse(
      (response) => (typeof urlPattern === 'string' ? response.url().includes(urlPattern) : urlPattern.test(response.url())) && response.status() === status,
    );
  }

  // --- Accessibility helpers -------------------------------------------------

  heading(name: string | RegExp, level?: number): Locator {
    return this.page.getByRole('heading', { name, level });
  }

  button(name: string | RegExp): Locator {
    return this.page.getByRole('button', { name });
  }

  link(name: string | RegExp): Locator {
    return this.page.getByRole('link', { name });
  }

  async assertHeadingVisible(name: string | RegExp, level?: number): Promise<void> {
    await expect(this.heading(name, level)).toBeVisible();
  }

  // --- Diagnostics -----------------------------------------------------------

  /** Captures a full-page screenshot and attaches it to the current test's report. */
  async attachScreenshot(name: string): Promise<void> {
    const body = await this.page.screenshot({ fullPage: true });
    await test.info().attach(name, { body, contentType: 'image/png' });
    this.log.debug(`Attached screenshot "${name}"`);
  }

  private urlPattern(): RegExp {
    const escaped = this.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped}(\\?.*)?$`);
  }
}
