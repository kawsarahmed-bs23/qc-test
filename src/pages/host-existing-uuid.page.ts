import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import { waitForIdle } from '@pages/admin-shell.page';
import type { NewHost } from '@pages/host-management.page';
import { queryMasterDb, querySingleValue } from '@utils/localDb';

export const QC912_HOST_NAME_PREFIX = 'E2E QC-912';
export const QC912_HOST_KEY_PREFIX = 'e2e-qc912';
export const QC912_REMOVE_SCRIPT = 'master-qc912-hosts.remove.sql';

/** The optional "Existing host UUID" field of the Add host form (QC-912); the edit form does not have it. */
export class AddHostUuidPage extends BasePage {
  protected readonly path = '/hosts/new';
  readonly input: Locator;
  readonly label: Locator;
  readonly hint: Locator;
  readonly clientError: Locator;
  readonly serverError: Locator;

  constructor(page: Page) {
    super(page);
    this.input = page.locator('#Input_HostUuid');
    const field = page.locator('.qc-field').filter({ has: this.input });
    this.label = field.locator('mat-label');
    this.hint = field.locator('.qc-hint');
    this.clientError = field.locator('.qc-field-error:not([data-field-error])');
    this.serverError = page.locator('[data-field-error="hostUuid"]');
  }

  /** Fills the Add host fields every Admin build has (no message queue), then the existing UUID when one is given. */
  async fillHost(host: NewHost, hostUuid?: string): Promise<void> {
    const fields: [string, string][] = [
      ['Name', host.name],
      ['HostKey', host.hostKey],
      ['ClientId', host.clientId],
      ['DatabaseName', host.databaseName],
      ['HostOrganisationId', host.organisationId],
      ['UiUrl', host.uiUrl],
      ['ApiBaseUrl', host.apiBaseUrl ?? ''],
    ];
    for (const [name, value] of fields) {
      await this.page.locator(`#Input_${name}`).fill(value);
    }
    if (hostUuid !== undefined) await this.input.fill(hostUuid);
  }

  /** Starts counting POST .../api/hosts requests the page sends; read the returned array after the action. */
  recordHostPosts(): string[] {
    const posts: string[] = [];
    this.page.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/hosts$/.test(new URL(request.url()).pathname)) posts.push(request.url());
    });
    return posts;
  }

  /** Presses Create and waits for the server's refusal of the UUID field. */
  async expectRefused(create: Locator, message: string): Promise<void> {
    const answered = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/hosts$/.test(new URL(r.url()).pathname));
    await create.click();
    expect((await answered).status()).toBe(400);
    await expect(this.serverError).toHaveText(message);
    await waitForIdle(this.page);
  }
}

export function masterHostCount(): number {
  return Number(queryMasterDb('SELECT COUNT(*) FROM app.Hosts'));
}

export function masterHostsWithUuid(uuid: string): number {
  return Number(queryMasterDb(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${uuid.replace(/'/g, '')}'`));
}

export function masterHostReady(uuid: string): boolean {
  return queryMasterDb(`SELECT CASE WHEN ReadyAt IS NULL THEN 0 ELSE 1 END FROM app.Hosts WHERE HostUUID = '${uuid.replace(/'/g, '')}'`) === '1';
}

/** The UUID of a deactivated HOST_MASTER host, or null when the database has none. */
export function deactivatedHostUuid(): string | null {
  return queryMasterDb('SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE Active = 0 ORDER BY HostID');
}

/** A SHA-256 over every row of the host database's app.EnvironmentSetting, to prove nothing was written there. */
export function hostEnvironmentSettingHash(): string {
  return querySingleValue(
    "SELECT CONVERT(varchar(64), HASHBYTES('SHA2_256', ISNULL((SELECT * FROM app.EnvironmentSetting ORDER BY EnvironmentSettingId FOR JSON PATH, INCLUDE_NULL_VALUES), N'')), 2)",
  )!;
}
