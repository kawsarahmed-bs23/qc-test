import { type Browser, type Locator, type Page } from '@playwright/test';
import { type Credentials } from '@config/env.config';
import { ChangeProposalsApi } from '@api/change-proposals.api';
import { NotifyBySmsSession } from '@pages/notify-by-sms.page';

/**
 * The Approve / Decline buttons the Comms page draws for a change a Driver proposed (QC-933), found by the hooks the app
 * exposes: `data-action="approve-change"` and `data-action="decline-change"`.
 */
export class CommsChangePage {
  readonly approve: Locator;
  readonly decline: Locator;

  constructor(private readonly page: Page) {
    this.approve = page.locator('[data-action="approve-change"]');
    this.decline = page.locator('[data-action="decline-change"]');
  }

  async open(driverUserId: string): Promise<void> {
    await this.page.goto(`/#/dispatch/comms?driverId=${encodeURIComponent(driverUserId)}`);
  }

  /** Presses Approve or Decline and returns the status of the `PUT api/dispatch/messages/{id}/change` call it makes. */
  async answer(button: 'approve' | 'decline'): Promise<number> {
    const answered = this.page.waitForResponse(
      (r) => r.request().method() === 'PUT' && /\/api\/dispatch\/messages\/\d+\/change$/.test(new URL(r.url()).pathname),
    );
    await this[button].first().click();
    return (await answered).status();
  }
}

/**
 * A host-app browser context of its own for one host-only user, signed in through the host API's own `api/account/login`
 * (as `NotifyBySmsSession` does), with the QC-933 API client signed in on the same context and the Comms change buttons.
 */
export class ChangeProposalsSession {
  private constructor(
    readonly base: NotifyBySmsSession,
    readonly api: ChangeProposalsApi,
    readonly comms: CommsChangePage,
  ) {}

  static async signIn(browser: Browser, credentials: Credentials): Promise<ChangeProposalsSession> {
    const base = await NotifyBySmsSession.signIn(browser, credentials);
    try {
      const api = new ChangeProposalsApi(base.context.request);
      await api.signIn(credentials.email, credentials.password);
      return new ChangeProposalsSession(base, api, new CommsChangePage(base.page));
    } catch (error) {
      await base.close();
      throw error;
    }
  }

  get adminUser() {
    return this.base.adminUser;
  }

  get vendorUser() {
    return this.base.vendorUser;
  }

  get page(): Page {
    return this.base.page;
  }

  async close(): Promise<void> {
    await this.base.close();
  }
}
