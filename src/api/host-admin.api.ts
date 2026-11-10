import { request as playwrightRequest, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';
import { HostAccountApi, identityAccessToken, type HostTokens } from '@api/host-account.api';
import { decodeJwt } from '@api/password-grant.api';
import { authorizeUrl } from '@pages/host-sign-in-flow.page';

export const QC899_ADMIN_EMAIL = 'e2e.qc899.hostadmin@quarryconnect.test';
export const QC899_ORGANISATION_PREFIX = 'E2E QC-899';

export function qc899NewUserEmail(name: string): string {
  return `e2e.qc899.${name}@example.com`;
}

export interface HostAnswer<T = unknown> {
  status: number;
  data: T | null;
  body: Record<string, unknown> | null;
  text: string;
}

export interface SelectItem {
  value: string;
  text: string;
}

export interface OrganisationModel extends Record<string, unknown> {
  organisationId: number;
  organisationName: string;
  location: Record<string, unknown> | null;
}

export interface HostUserRow {
  userId: string;
  userName: string;
}

/** The QC-899 throwaway host admin: an Identity user with two-step verification and a host Admin row in the host database. */
export const Qc899HostAdmin = {
  seed(): ThrowawayUser {
    if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway host admin copies that password.');
    if (!env.identitySql) throw new Error("Identity's local database is not set.");
    const authenticatorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc899-user.apply.sql', {
      Email: QC899_ADMIN_EMAIL,
      SourceEmail: env.admin.email,
      LastName: 'QC-899 Host admin',
      TwoFactor: '1',
      AuthenticatorKey: authenticatorKey,
    });
    const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${QC899_ADMIN_EMAIL}')`);
    if (!userId) throw new Error(`The throwaway user ${QC899_ADMIN_EMAIL} was not created.`);
    runSeedScript('host-qc899-admin.apply.sql', { UserId: userId, Email: QC899_ADMIN_EMAIL, IdentityDb: env.identitySql.database });
    return { email: QC899_ADMIN_EMAIL, password: env.admin.password, userId, authenticatorKey };
  },

  remove(): void {
    try {
      runSeedScript('host-qc899.remove.sql');
    } finally {
      runIdentitySeedScript('identity-qc899.remove.sql');
    }
  },
};

/** The host API (APP_API_URL) as a host user signed in through Identity and the identity exchange. */
export class HostAdminApi {
  private tokens: HostTokens | null = null;

  constructor(private readonly request: APIRequestContext) {}

  /** A client on its own request context, for a describe block that signs in once in beforeAll. Call close() after. */
  static async open(): Promise<HostAdminApi> {
    return new HostAdminApi(await playwrightRequest.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  close(): Promise<void> {
    return this.request.dispose();
  }

  /** Signs in through Identity's code flow in a fresh signed-out browser context, then exchanges the token at the host API. */
  async signInWith(browser: Browser, user: ThrowawayUser): Promise<HostAnswer<HostTokens>> {
    const context = await browser.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
    try {
      return await this.signIn(await context.newPage(), user);
    } finally {
      await context.close();
    }
  }

  private url(path: string): string {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
    return `${env.appApiUrl}${path}`;
  }

  private headers(): Record<string, string> {
    if (!this.tokens) throw new Error('Sign in first.');
    return { Authorization: `Bearer ${this.tokens.accessToken}` };
  }

  private async read<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<HostAnswer<T>> {
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const data = body && typeof body === 'object' && 'data' in body ? (body['data'] as T) : null;
    return { status: response.status(), data, body, text };
  }

  /** Whether Identity (IDENTITY_URL) starts a code flow for the host client, instead of sending it to its error page or the landing page. */
  static async identityServesHostClient(request: APIRequestContext): Promise<boolean> {
    if (!env.hostClient) return false;
    const response = await request.get(authorizeUrl({ client_id: env.hostClient.clientId, redirect_uri: env.hostClient.redirectUri, nonce: 'e2e' }), {
      maxRedirects: 0,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    const location = new URL(response.headers()['location'] ?? '/', env.identityUrl);
    return location.origin === new URL(env.identityUrl).origin && !/^\/Error/i.test(location.pathname);
  }

  /** Signs in with the host API's own password login (POST api/account/login), which needs no Identity client. */
  async signInWithPassword(email: string, password: string): Promise<HostAnswer<HostTokens>> {
    const answer = await this.read<HostTokens>(
      await this.request.post(this.url('/api/account/login'), { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors }),
    );
    this.tokens = answer.status === 200 ? answer.data : null;
    return answer;
  }

  async signIn(page: Page, user: ThrowawayUser): Promise<HostAnswer<HostTokens>> {
    const identityToken = await identityAccessToken(page, this.request, user, user.authenticatorKey ?? null);
    const exchange = await new HostAccountApi(this.request).identityExchange(identityToken);
    this.tokens = exchange.status === 200 ? exchange.data : null;
    return { status: exchange.status, data: exchange.data, body: exchange.body, text: JSON.stringify(exchange.body) };
  }

  accessTokenClaims(): Record<string, unknown> {
    if (!this.tokens) throw new Error('Sign in first.');
    return decodeJwt(this.tokens.accessToken).claims;
  }

  async get<T = unknown>(path: string): Promise<HostAnswer<T>> {
    return this.read<T>(await this.request.get(this.url(path), { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  async post<T = unknown>(path: string, data: unknown): Promise<HostAnswer<T>> {
    return this.read<T>(await this.request.post(this.url(path), { headers: this.headers(), data, ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  profile(): Promise<HostAnswer> {
    return this.get('/api/account/getuserprofile');
  }

  userEulaCheck(): Promise<HostAnswer> {
    return this.get('/api/account/checkusereulasign');
  }

  userSearch(keywords = ''): Promise<HostAnswer<{ data: HostUserRow[]; recordsTotal: number }>> {
    return this.post('/api/manageusers/user-search', { searchKeywords: keywords, start: 0, length: 1000 });
  }

  userCreateForm(): Promise<HostAnswer<{ availableRoles: SelectItem[]; availableOrganisations: SelectItem[] }>> {
    return this.get('/api/manageusers/user-create');
  }

  organisationOptions(role: string): Promise<HostAnswer<{ canSetOrganisation: boolean; availableOrganisations: SelectItem[] }>> {
    return this.get(`/api/manageusers/organisation-options/${encodeURIComponent(role)}`);
  }

  createUser(user: { userName: string; firstName: string; lastName: string; role: string; password: string }): Promise<HostAnswer<string>> {
    return this.post('/api/manageusers/user-create', {
      userName: user.userName,
      firstName: user.firstName,
      lastName: user.lastName,
      phoneNumber: '',
      password: user.password,
      confirmPassword: user.password,
      role: user.role,
      isActive: true,
      organisationId: 0,
      organisationLocationId: 0,
      canSetOrganisation: false,
      isBillingContact: false,
    });
  }

  userEditForm(userId: string): Promise<HostAnswer<{ userId: string; userName: string; role: string }>> {
    return this.get(`/api/manageusers/user-edit/${encodeURIComponent(userId)}`);
  }

  vendorSearch(keywords = ''): Promise<HostAnswer<{ data: OrganisationModel[] }>> {
    return this.post('/api/organisation/vendor-search', { searchKeywords: keywords, start: 0, length: 1000 });
  }

  vendorCreateForm(): Promise<HostAnswer<OrganisationModel>> {
    return this.get('/api/organisation/vendor-create');
  }

  createVendor(model: OrganisationModel): Promise<HostAnswer<number>> {
    return this.post('/api/organisation/vendor-create', model);
  }

  vendorEditForm(organisationId: number): Promise<HostAnswer<OrganisationModel>> {
    return this.get(`/api/organisation/vendor-edit/${organisationId}`);
  }

  editVendor(model: OrganisationModel): Promise<HostAnswer<OrganisationModel>> {
    return this.post('/api/organisation/vendor-edit', model);
  }

  changePassword(currentPassword: string, newPassword: string): Promise<HostAnswer> {
    return this.post('/api/manage/changepassword', { currentPassword, newPassword });
  }
}
