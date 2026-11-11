import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { inviteResultFrom, inviteResultSignedBy, type InviteResult } from '@utils/inviteLinks';
import { identityAcceptsLink } from '@api/user-invites.api';
import { BasePage } from './base.page';

export interface InviteSetupInput {
  password: string;
  acceptTerms: boolean;
}

const FAILED_TEXT = /This invite has expired or has already been used\. Ask .+ to send a new one\./;

/**
 * Identity's Host invite pages (QC-914): /invite, /invite/decline, /invite/accept and /invite/complete.
 * The link's return_url belongs to the host app; nothing has to serve it, because `catchReturn` answers it
 * in the browser and the case reads `invite_result` from the URL.
 */
export class IdentityInvitePage extends BasePage {
  protected readonly path = '/invite';
  readonly pageHeading: Locator;
  readonly subtitle: Locator;
  readonly email: Locator;
  readonly setupForm: Locator;
  readonly firstName: Locator;
  readonly lastName: Locator;
  readonly password: Locator;
  readonly confirmPassword: Locator;
  readonly acceptTerms: Locator;
  readonly save: Locator;
  readonly error: Locator;
  readonly existing: Locator;
  readonly signInToConnect: Locator;
  readonly declineLink: Locator;
  readonly declineConfirm: Locator;
  readonly goBack: Locator;
  readonly failed: Locator;
  readonly complete: Locator;
  readonly hostSignIn: Locator;
  readonly driverApp: Locator;
  readonly declined: Locator;
  readonly wrongAccount: Locator;
  readonly acceptForm: Locator;
  readonly acceptQuestion: Locator;
  readonly acceptConfirm: Locator;
  private returnRequests = 0;

  constructor(page: Page) {
    super(page);
    this.pageHeading = page.locator('#page-heading');
    this.subtitle = page.locator('.daxa-form .title p');
    this.email = page.locator('#invite-email');
    this.setupForm = page.locator('#invite-setup');
    this.firstName = page.getByLabel('First name', { exact: true });
    this.lastName = page.getByLabel('Last name', { exact: true });
    this.password = this.setupForm.locator('#Input_Password');
    this.confirmPassword = this.setupForm.locator('#Input_ConfirmPassword');
    this.acceptTerms = page.getByLabel('I accept the Terms of Use and Privacy Policy');
    this.save = page.locator('#invite-save');
    this.error = this.setupForm.getByRole('alert');
    this.existing = page.locator('#invite-existing');
    this.signInToConnect = page.locator('#invite-sign-in');
    this.declineLink = page.locator('#invite-decline-link');
    this.declineConfirm = page.locator('#invite-decline-confirm');
    this.goBack = page.locator('#invite-go-back');
    this.failed = page.locator('#invite-failed');
    this.complete = page.locator('#invite-complete');
    this.hostSignIn = page.locator('#invite-host-sign-in');
    this.driverApp = page.locator('#invite-driver-app');
    this.declined = page.locator('#invite-declined');
    this.wrongAccount = page.locator('#invite-wrong-account');
    this.acceptForm = page.locator('#invite-accept');
    this.acceptQuestion = page.locator('#invite-accept-question');
    this.acceptConfirm = page.locator('#invite-accept-confirm');
  }

  async open(token: string): Promise<void> {
    await this.page.goto(`${env.identityUrl}/invite?t=${encodeURIComponent(token)}`);
  }

  /** True when Identity's /invite page takes the link (shows the setup or existing-login view), false when it shows #invite-failed. */
  acceptsLink(token: string): Promise<boolean> {
    return identityAcceptsLink(this.page.request, token);
  }

  async openDecline(token: string): Promise<void> {
    await this.page.goto(`${env.identityUrl}/invite/decline?t=${encodeURIComponent(token)}`);
  }

  async openAccept(token: string): Promise<void> {
    await this.page.goto(`${env.identityUrl}/invite/accept?t=${encodeURIComponent(token)}`);
  }

  /** What the host does with a result: send the person to Identity's complete_url with the token and its status. */
  async openComplete(result: InviteResult, status: 'recorded' | 'expired' = 'recorded'): Promise<void> {
    await this.page.goto(`${result.payload.complete_url}?r=${encodeURIComponent(result.token)}&status=${status}`);
  }

  /** Answers every request to the return URL's origin in the browser, so the redirect lands without a host app. */
  async catchReturn(returnUrl: string): Promise<void> {
    const origin = new URL(returnUrl).origin;
    await this.page.route(`${origin}/**`, async (route) => {
      this.returnRequests++;
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>host return</body></html>' });
    });
  }

  expectNoReturnYet(): void {
    expect(this.returnRequests, 'nothing has been sent to return_url yet').toBe(0);
  }

  /** Waits for the redirect to the return URL and returns the result it carries. */
  async resultAt(returnUrl: string): Promise<InviteResult> {
    const origin = new URL(returnUrl).origin;
    await this.page.waitForURL((url) => url.origin === origin && url.searchParams.has('invite_result'));
    expect(this.page.url().startsWith(returnUrl), 'Identity redirects to the link return_url').toBe(true);
    return inviteResultFrom(this.page.url());
  }

  async expectSignedByIdentity(result: InviteResult): Promise<void> {
    const response = await this.page.request.get(`${env.identityUrl}/.well-known/openid-configuration/jwks`);
    expect(response.ok(), 'Identity JWKS').toBe(true);
    expect(inviteResultSignedBy(result, await response.json()), 'the result token is signed by a key in Identity JWKS').toBe(true);
  }

  /** The host's display name, read from "{Host} Account setup". */
  async hostDisplayName(): Promise<string> {
    await expect(this.pageHeading).toHaveText(/\S.* Account setup$/);
    return (await this.pageHeading.innerText()).trim().replace(/ Account setup$/, '');
  }

  async expectSetupFor(email: string, firstName: string, lastName: string): Promise<void> {
    await expect(this.pageHeading).toHaveText(/\S.* Account setup$/);
    await expect(this.subtitle).toHaveText('This email address is your username, contact support to change it.');
    await expect(this.email).toHaveText(email);
    await expect(this.setupForm).toBeVisible();
    await expect(this.firstName).toHaveValue(firstName);
    await expect(this.lastName).toHaveValue(lastName);
    await expect(this.acceptTerms).not.toBeChecked();
    await expect(this.save).toHaveText('Save Settings');
    await expect(this.declineLink).toBeVisible();
  }

  async fillSetup(input: InviteSetupInput): Promise<void> {
    await this.password.fill(input.password);
    await this.confirmPassword.fill(input.password);
    if (input.acceptTerms) {
      await this.acceptTerms.check();
    }
  }

  async saveSettings(input: InviteSetupInput): Promise<void> {
    await this.fillSetup(input);
    await this.save.click();
  }

  async expectTermsRequired(): Promise<void> {
    await expect(this.error).toContainText('Accept the Terms of Use and Privacy Policy to continue.');
    await expect(this.setupForm).toBeVisible();
  }

  async expectExistingLogin(email: string, hostName: string, options: { used?: boolean } = {}): Promise<void> {
    await expect(this.email).toHaveText(email);
    await expect(this.existing).toBeVisible();
    await expect(this.setupForm).toHaveCount(0);
    await expect(this.signInToConnect).toHaveText(`Sign in to connect with ${hostName}`);
    await expect(this.declineLink).toHaveCount(options.used ? 0 : 1);
  }

  /** GET /invite/accept after sign-in shows a confirm form and redirects nowhere until it is posted. */
  async expectAcceptQuestion(email: string, hostName: string, options: { used?: boolean } = {}): Promise<void> {
    await expect(this.page).toHaveURL((url) => url.href.startsWith(`${env.identityUrl}/invite/accept?`));
    await expect(this.acceptForm).toBeVisible();
    await expect(this.acceptQuestion).toHaveText(`Connect ${email} to ${hostName}?`);
    await expect(this.acceptConfirm).toHaveText('Accept invite');
    await expect(this.declineLink).toHaveCount(options.used ? 0 : 1);
    this.expectNoReturnYet();
  }

  async expectDeclineQuestion(hostName: string): Promise<void> {
    await expect(this.pageHeading).toHaveText(`Decline the invite from ${hostName}?`);
    await expect(this.declineConfirm).toHaveText('Decline');
    await expect(this.goBack).toHaveText('Go back');
  }

  async expectFailed(): Promise<void> {
    await expect(this.failed).toHaveText(FAILED_TEXT);
    await expect(this.setupForm).toHaveCount(0);
    await expect(this.signInToConnect).toHaveCount(0);
  }

  async expectSetupComplete(withDriverApp: boolean): Promise<void> {
    await expect(this.pageHeading).toHaveText('Setup Complete');
    await expect(this.complete).toHaveText("You're all set. Your account is now active.");
    await expect(this.hostSignIn.getByRole('link')).toBeVisible();
    if (withDriverApp) {
      await expect(this.driverApp.getByRole('link')).toHaveAttribute('href', /^https:\/\/drivers(-dev)?\.quarryconnect\.com/);
    } else {
      await expect(this.driverApp).toHaveCount(0);
    }
  }

  async expectDeclined(hostName: string): Promise<void> {
    await expect(this.declined).toHaveText(`You declined. ${hostName} has been told.`);
  }
}
