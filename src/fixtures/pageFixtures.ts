import { test as base, expect } from '@playwright/test';
import { ADMIN_STATE, env, type TestEnvironment } from '@config/env.config';
import { AdminShell, adminUrl } from '@pages/admin-shell.page';
import { ActivityPage, DashboardPage, HostNav } from '@pages/host.page';
import { HostEnvironmentPage, HostFeaturesPage, HostFormPage, HostListPage, HostSignInSettingsPage, UserDetailPage } from '@pages/host-management.page';
import { UserListPage } from '@pages/user-list.page';
import { IdentityInvitePage } from '@pages/identity-invite.page';
import { PlatformAdminsPage, PlatformSettingsPage } from '@pages/platform.page';
import { HostReadinessCard, SettingTemplatePage } from '@pages/setting-template.page';
import { IdentityBrandingView, IdentityLoginPage, IdentityLogoutPage, IdentityPasswordResetPage, IdentityTwoStepPage } from '@pages/identity-login.page';
import { AppSignInPage, CommsPage, DispatchOrdersPage, PlanVsLivePage, TicketActivityPage } from '@pages/app.page';
import { CommsDayPage } from '@pages/comms-day.page';
import { CommsComposer } from '@pages/comms-send-gate.page';
import { ForgotPasswordPage, ResetPasswordPage } from '@pages/host-password-link.page';
import { HostNotFoundPage, HostRootApi, HostSidebar } from '@pages/host-root-removed.page';
import { CompanySettingsPage } from '@pages/login-subtitle.page';
import { AppHeader, LogoCropper, LogoSettingsPage, TicketUploadScreen } from '@pages/logo-upload.page';
import { MessageLinkPanel } from '@pages/message-link.page';
import { ReplyLinkThread } from '@pages/reply-links.page';
import { ReplyPage } from '@pages/reply-page.page';
import { AppSignInErrorView, AppTermsPage, HostAppHeader } from '@pages/sign-in-redirect.page';
import { AdminUserEditPage, SignUserAgreementPage, UserEulaStatus, VendorUserEditPage } from '@pages/user-eula.page';
import { AdminUserFormPage, UserInviteSection, UserListSignInColumn, VendorSidebar, VendorUserFormPage } from '@pages/user-invites.page';
import { HostSignInMode, HostUserInvitesApi } from '@api/user-invites.api';
import { DriverSettingsApi } from '@api/driver-settings.api';
import { AccountDeletionApi } from '@api/account-deletion.api';
import { HostDriverEventsApi } from '@api/driver-events.api';
import { HostApi } from '@api/drivers-mirror.api';
import { HostAccountApi } from '@api/host-account.api';
import { HostAdminApi } from '@api/host-admin.api';
import { HostAssignmentsApi } from '@api/host-assignments.api';
import { HostBrandingApi } from '@api/host-branding.api';
import { LocalStackSqs, MessagingProbeApi } from '@api/messaging-probe.api';
import { PasswordGrantApi } from '@api/password-grant.api';
import { UserEulaApi } from '@api/user-eula.api';
import { HostUserEditApi } from '@api/email-change.api';
import { ConfirmEmailChangePage, HostMyProfilePage, HostUserEmailField, UserEmailChangePanel } from '@pages/email-change.page';
import { EditVendorPage, VendorProfileBillRatesPage } from '@pages/bill-rates.page';
import { HostBillRatesApi } from '@api/bill-rates.api';
import {
  AdminUserDispatchContactPage,
  AssignDialogDispatchPage,
  EditTruckDispatchPage,
  EditVendorDispatchPage,
  ProfileDispatchContactPage,
  VendorUserDispatchContactPage,
} from '@pages/dispatch-contact.page';
import { DispatchContactApi } from '@api/dispatch-contact.api';
import { HostTruckFormPage, HostTrucksListPage, TruckNumberSchedulePage } from '@pages/truck-number.page';
import { AdminUserTextMessagesPage, VendorUserTextMessagesPage } from '@pages/notify-by-sms.page';
import { NotifyBySmsApi } from '@api/notify-by-sms.api';
import { AddHostUuidPage } from '@pages/host-existing-uuid.page';
import { HostExistingUuidApi } from '@api/host-existing-uuid.api';

export interface TargetHost {
  uuid: string;
  name: string;
}

/**
 * Everything a spec can request by name. Register every new page object or API client here
 * (type + factory below) and request it in the test signature instead of calling `new XPage(page)`.
 * Only classes built from `page` or `request` alone are fixtures; components that need extra
 * arguments (CompanyLogoCard, RestartControls, AdminApi, ...) are still built inside the page object or spec.
 */
type TestFixtures = {
  env: TestEnvironment;
  shell: AdminShell;

  // Page objects (UI), built from `page`.
  dashboardPage: DashboardPage;
  hostNav: HostNav;
  activityPage: ActivityPage;
  hostListPage: HostListPage;
  hostFormPage: HostFormPage;
  hostFeaturesPage: HostFeaturesPage;
  hostEnvironmentPage: HostEnvironmentPage;
  hostSignInSettingsPage: HostSignInSettingsPage;
  userDetailPage: UserDetailPage;
  userListPage: UserListPage;
  platformSettingsPage: PlatformSettingsPage;
  platformAdminsPage: PlatformAdminsPage;
  settingTemplatePage: SettingTemplatePage;
  hostReadinessCard: HostReadinessCard;
  identityLoginPage: IdentityLoginPage;
  identityBrandingView: IdentityBrandingView;
  identityTwoStepPage: IdentityTwoStepPage;
  identityLogoutPage: IdentityLogoutPage;
  identityPasswordResetPage: IdentityPasswordResetPage;
  identityInvitePage: IdentityInvitePage;
  appSignInPage: AppSignInPage;
  planVsLivePage: PlanVsLivePage;
  ticketActivityPage: TicketActivityPage;
  commsPage: CommsPage;
  dispatchOrdersPage: DispatchOrdersPage;
  commsDayPage: CommsDayPage;
  commsComposer: CommsComposer;
  forgotPasswordPage: ForgotPasswordPage;
  resetPasswordPage: ResetPasswordPage;
  hostSidebar: HostSidebar;
  hostNotFoundPage: HostNotFoundPage;
  companySettingsPage: CompanySettingsPage;
  logoCropper: LogoCropper;
  appHeader: AppHeader;
  logoSettingsPage: LogoSettingsPage;
  ticketUploadScreen: TicketUploadScreen;
  messageLinkPanel: MessageLinkPanel;
  replyLinkThread: ReplyLinkThread;
  replyPage: ReplyPage;
  hostAppHeader: HostAppHeader;
  appSignInErrorView: AppSignInErrorView;
  appTermsPage: AppTermsPage;
  adminUserFormPage: AdminUserFormPage;
  vendorUserFormPage: VendorUserFormPage;
  userInviteSection: UserInviteSection;
  userListSignInColumn: UserListSignInColumn;
  vendorSidebar: VendorSidebar;
  adminUserEditPage: AdminUserEditPage;
  vendorUserEditPage: VendorUserEditPage;
  userEulaStatus: UserEulaStatus;
  signUserAgreementPage: SignUserAgreementPage;
  hostUserEmailField: HostUserEmailField;
  hostMyProfilePage: HostMyProfilePage;
  confirmEmailChangePage: ConfirmEmailChangePage;
  userEmailChangePanel: UserEmailChangePanel;
  editVendorPage: EditVendorPage;
  vendorProfileBillRatesPage: VendorProfileBillRatesPage;
  adminUserDispatchContactPage: AdminUserDispatchContactPage;
  vendorUserDispatchContactPage: VendorUserDispatchContactPage;
  profileDispatchContactPage: ProfileDispatchContactPage;
  editVendorDispatchPage: EditVendorDispatchPage;
  editTruckDispatchPage: EditTruckDispatchPage;
  assignDialogDispatchPage: AssignDialogDispatchPage;
  hostTruckFormPage: HostTruckFormPage;
  hostTrucksListPage: HostTrucksListPage;
  truckNumberSchedulePage: TruckNumberSchedulePage;
  adminUserTextMessagesPage: AdminUserTextMessagesPage;
  vendorUserTextMessagesPage: VendorUserTextMessagesPage;

  // API clients, built from `request`.
  hostUserInvitesApi: HostUserInvitesApi;
  hostSignInMode: HostSignInMode;
  hostApi: HostApi;
  hostAccountApi: HostAccountApi;
  hostAdminApi: HostAdminApi;
  hostAssignmentsApi: HostAssignmentsApi;
  hostBrandingApi: HostBrandingApi;
  messagingProbeApi: MessagingProbeApi;
  localStackSqs: LocalStackSqs;
  passwordGrantApi: PasswordGrantApi;
  hostRootApi: HostRootApi;
  userEulaApi: UserEulaApi;
  driverSettingsApi: DriverSettingsApi;
  accountDeletionApi: AccountDeletionApi;
  hostDriverEventsApi: HostDriverEventsApi;
  hostUserEditApi: HostUserEditApi;
  hostBillRatesApi: HostBillRatesApi;
  dispatchContactApi: DispatchContactApi;
  notifyBySmsApi: NotifyBySmsApi;
  addHostUuidPage: AddHostUuidPage;
  hostExistingUuidApi: HostExistingUuidApi;
};

type WorkerFixtures = {
  targetHost: TargetHost;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern
  env: async ({}, use) => {
    await use(env);
  },
  shell: async ({ page }, use) => {
    await use(new AdminShell(page));
  },

  dashboardPage: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  hostNav: async ({ page }, use) => {
    await use(new HostNav(page));
  },
  activityPage: async ({ page }, use) => {
    await use(new ActivityPage(page));
  },
  hostListPage: async ({ page }, use) => {
    await use(new HostListPage(page));
  },
  hostFormPage: async ({ page }, use) => {
    await use(new HostFormPage(page));
  },
  hostFeaturesPage: async ({ page }, use) => {
    await use(new HostFeaturesPage(page));
  },
  hostEnvironmentPage: async ({ page }, use) => {
    await use(new HostEnvironmentPage(page));
  },
  hostSignInSettingsPage: async ({ page }, use) => {
    await use(new HostSignInSettingsPage(page));
  },
  userDetailPage: async ({ page }, use) => {
    await use(new UserDetailPage(page));
  },
  userListPage: async ({ page }, use) => {
    await use(new UserListPage(page));
  },
  platformSettingsPage: async ({ page }, use) => {
    await use(new PlatformSettingsPage(page));
  },
  platformAdminsPage: async ({ page }, use) => {
    await use(new PlatformAdminsPage(page));
  },
  settingTemplatePage: async ({ page }, use) => {
    await use(new SettingTemplatePage(page));
  },
  hostReadinessCard: async ({ page }, use) => {
    await use(new HostReadinessCard(page));
  },
  identityLoginPage: async ({ page }, use) => {
    await use(new IdentityLoginPage(page));
  },
  identityBrandingView: async ({ page }, use) => {
    await use(new IdentityBrandingView(page));
  },
  identityTwoStepPage: async ({ page }, use) => {
    await use(new IdentityTwoStepPage(page));
  },
  identityLogoutPage: async ({ page }, use) => {
    await use(new IdentityLogoutPage(page));
  },
  identityPasswordResetPage: async ({ page }, use) => {
    await use(new IdentityPasswordResetPage(page));
  },
  identityInvitePage: async ({ page }, use) => {
    await use(new IdentityInvitePage(page));
  },
  appSignInPage: async ({ page }, use) => {
    await use(new AppSignInPage(page));
  },
  planVsLivePage: async ({ page }, use) => {
    await use(new PlanVsLivePage(page));
  },
  ticketActivityPage: async ({ page }, use) => {
    await use(new TicketActivityPage(page));
  },
  commsPage: async ({ page }, use) => {
    await use(new CommsPage(page));
  },
  dispatchOrdersPage: async ({ page }, use) => {
    await use(new DispatchOrdersPage(page));
  },
  commsDayPage: async ({ page }, use) => {
    await use(new CommsDayPage(page));
  },
  commsComposer: async ({ page }, use) => {
    await use(new CommsComposer(page));
  },
  forgotPasswordPage: async ({ page }, use) => {
    await use(new ForgotPasswordPage(page));
  },
  resetPasswordPage: async ({ page }, use) => {
    await use(new ResetPasswordPage(page));
  },
  hostSidebar: async ({ page }, use) => {
    await use(new HostSidebar(page));
  },
  hostNotFoundPage: async ({ page }, use) => {
    await use(new HostNotFoundPage(page));
  },
  companySettingsPage: async ({ page }, use) => {
    await use(new CompanySettingsPage(page));
  },
  logoCropper: async ({ page }, use) => {
    await use(new LogoCropper(page));
  },
  appHeader: async ({ page }, use) => {
    await use(new AppHeader(page));
  },
  logoSettingsPage: async ({ page }, use) => {
    await use(new LogoSettingsPage(page));
  },
  ticketUploadScreen: async ({ page }, use) => {
    await use(new TicketUploadScreen(page));
  },
  messageLinkPanel: async ({ page }, use) => {
    await use(new MessageLinkPanel(page));
  },
  replyLinkThread: async ({ page }, use) => {
    await use(new ReplyLinkThread(page));
  },
  replyPage: async ({ page }, use) => {
    await use(new ReplyPage(page));
  },
  hostAppHeader: async ({ page }, use) => {
    await use(new HostAppHeader(page));
  },
  appSignInErrorView: async ({ page }, use) => {
    await use(new AppSignInErrorView(page));
  },
  appTermsPage: async ({ page }, use) => {
    await use(new AppTermsPage(page));
  },
  adminUserFormPage: async ({ page }, use) => {
    await use(new AdminUserFormPage(page));
  },
  vendorUserFormPage: async ({ page }, use) => {
    await use(new VendorUserFormPage(page));
  },
  userInviteSection: async ({ page }, use) => {
    await use(new UserInviteSection(page));
  },
  userListSignInColumn: async ({ page }, use) => {
    await use(new UserListSignInColumn(page));
  },
  vendorSidebar: async ({ page }, use) => {
    await use(new VendorSidebar(page));
  },
  adminUserEditPage: async ({ page }, use) => {
    await use(new AdminUserEditPage(page));
  },
  vendorUserEditPage: async ({ page }, use) => {
    await use(new VendorUserEditPage(page));
  },
  userEulaStatus: async ({ page }, use) => {
    await use(new UserEulaStatus(page));
  },
  signUserAgreementPage: async ({ page }, use) => {
    await use(new SignUserAgreementPage(page));
  },
  hostUserEmailField: async ({ page }, use) => {
    await use(new HostUserEmailField(page));
  },
  hostMyProfilePage: async ({ page }, use) => {
    await use(new HostMyProfilePage(page));
  },
  confirmEmailChangePage: async ({ page }, use) => {
    await use(new ConfirmEmailChangePage(page));
  },
  userEmailChangePanel: async ({ page }, use) => {
    await use(new UserEmailChangePanel(page));
  },

  hostUserInvitesApi: async ({ request }, use) => {
    await use(new HostUserInvitesApi(request));
  },
  hostSignInMode: async ({ request }, use) => {
    await use(new HostSignInMode(request));
  },
  hostApi: async ({ request }, use) => {
    await use(new HostApi(request));
  },
  hostAccountApi: async ({ request }, use) => {
    await use(new HostAccountApi(request));
  },
  hostAdminApi: async ({ request }, use) => {
    await use(new HostAdminApi(request));
  },
  hostAssignmentsApi: async ({ request }, use) => {
    await use(new HostAssignmentsApi(request));
  },
  hostDriverEventsApi: async ({ request }, use) => {
    await use(new HostDriverEventsApi(request));
  },
  hostBrandingApi: async ({ request }, use) => {
    await use(new HostBrandingApi(request));
  },
  messagingProbeApi: async ({ request }, use) => {
    await use(new MessagingProbeApi(request));
  },
  localStackSqs: async ({ request }, use) => {
    await use(new LocalStackSqs(request));
  },
  passwordGrantApi: async ({ request }, use) => {
    await use(new PasswordGrantApi(request));
  },
  hostRootApi: async ({ request }, use) => {
    await use(new HostRootApi(request));
  },
  userEulaApi: async ({ request }, use) => {
    await use(new UserEulaApi(request));
  },
  driverSettingsApi: async ({ request }, use) => {
    await use(new DriverSettingsApi(request));
  },
  accountDeletionApi: async ({ request }, use) => {
    await use(new AccountDeletionApi(request));
  },
  hostUserEditApi: async ({ request }, use) => {
    await use(new HostUserEditApi(request));
  },
  hostBillRatesApi: async ({ request }, use) => {
    await use(new HostBillRatesApi(request));
  },
  editVendorPage: async ({ page }, use) => {
    await use(new EditVendorPage(page));
  },
  vendorProfileBillRatesPage: async ({ page }, use) => {
    await use(new VendorProfileBillRatesPage(page));
  },
  adminUserDispatchContactPage: async ({ page }, use) => {
    await use(new AdminUserDispatchContactPage(page));
  },
  vendorUserDispatchContactPage: async ({ page }, use) => {
    await use(new VendorUserDispatchContactPage(page));
  },
  profileDispatchContactPage: async ({ page }, use) => {
    await use(new ProfileDispatchContactPage(page));
  },
  editVendorDispatchPage: async ({ page }, use) => {
    await use(new EditVendorDispatchPage(page));
  },
  editTruckDispatchPage: async ({ page }, use) => {
    await use(new EditTruckDispatchPage(page));
  },
  assignDialogDispatchPage: async ({ page }, use) => {
    await use(new AssignDialogDispatchPage(page));
  },
  hostTruckFormPage: async ({ page }, use) => {
    await use(new HostTruckFormPage(page));
  },
  hostTrucksListPage: async ({ page }, use) => {
    await use(new HostTrucksListPage(page));
  },
  truckNumberSchedulePage: async ({ page }, use) => {
    await use(new TruckNumberSchedulePage(page));
  },
  dispatchContactApi: async ({ request }, use) => {
    await use(new DispatchContactApi(request));
  },
  adminUserTextMessagesPage: async ({ page }, use) => {
    await use(new AdminUserTextMessagesPage(page));
  },
  vendorUserTextMessagesPage: async ({ page }, use) => {
    await use(new VendorUserTextMessagesPage(page));
  },
  notifyBySmsApi: async ({ request }, use) => {
    await use(new NotifyBySmsApi(request));
  },
  addHostUuidPage: async ({ page }, use) => {
    await use(new AddHostUuidPage(page));
  },
  hostExistingUuidApi: async ({ request }, use) => {
    await use(new HostExistingUuidApi(request));
  },

  targetHost: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        baseURL: env.adminUrl,
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
        storageState: ADMIN_STATE,
      });
      const page = await context.newPage();
      await page.goto(adminUrl('/hosts'));

      const row = page
        .locator('#hosts-table tr[data-host-uuid]')
        .filter({ has: page.locator('[data-testid="host-link"]', { hasText: env.hostName }) })
        .first();
      await expect(row, `Host '${env.hostName}' (HOST_NAME) must be registered in HOST_MASTER`).toBeVisible();

      const uuid = ((await row.getAttribute('data-host-uuid')) ?? '').toLowerCase();
      expect(uuid, 'host UUID from the hosts list').toMatch(/^[0-9a-f-]{36}$/i);

      await context.close();
      await use({ uuid, name: env.hostName });
    },
    { scope: 'worker' },
  ],
});

export { expect };

export const signedOut = { storageState: { cookies: [], origins: [] } };
