import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { NotifyBySmsSession } from '@pages/notify-by-sms.page';

const SEEDED = ['admin', 'vendor', 'linked', 'plain', 'staff'] as const;
type Seeded = (typeof SEEDED)[number];
const TRUCK = 'E2E QC-936 Truck';
const LINKED_PHONE = '5125559361';
const PLAIN_PHONE = '5125559362';
const ORG_CACHE = { timeout: 120_000, intervals: [5_000] };

function email(name: string): string {
  return `e2e.qc936.${name}@quarryconnect.test`;
}

function value(query: string): string | null {
  return querySingleValue(query);
}

function userId(address: string): string {
  return value(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${address}')`) ?? '';
}

function digits(text: string | null | undefined): string {
  return (text ?? '').replace(/\D/g, '');
}

function setting(id: string): { notifyBySms: string; phone: string } | null {
  const row = value(`SELECT CONCAT(CAST(NotifyBySms AS int), '|', ISNULL(MobilePhone, '')) FROM app.UserSettings WHERE UserID_FK = N'${id}'`);
  if (row === null) return null;
  const [notifyBySms, phone] = row.split('|');
  return { notifyBySms, phone: digits(phone) };
}

function settingStamp(id: string): string | null {
  return value(
    `SELECT CONCAT(CAST(NotifyBySms AS int), '|', ISNULL(MobilePhone, 'NULL'), '|', CONVERT(varchar(30), Updated, 126), '|', ISNULL(UpdatedBy, 'NULL'), '|', COUNT(*) OVER ()) FROM app.UserSettings WHERE UserID_FK = N'${id}'`,
  );
}

function storedPhone(id: string): string | null {
  return value(`SELECT PhoneNumber FROM auth.Users WHERE Id = N'${id}'`);
}

function removeAll(): void {
  const output = runSeedScript('host-qc936.remove.sql');
  if (!/REMOVED left=0/.test(output)) throw new Error(`QC-936 rows are left behind:\n${output}`);
}

test.describe('Text messages (NotifyBySms) on Manage Users and Vendor Portal My Users (QC-936)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'default' });
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's local database and Identity's (for the source password hash); local only.");
  test.skip(
    !env.admin || !env.appApiUrl || !env.appUrl,
    'Needs ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway users copy that password), APP_URL and APP_API_URL.',
  );
  test.skip(
    canSeedLocalDb() && value(`SELECT CASE WHEN OBJECT_ID(N'app.UserSettings', N'U') IS NULL THEN 0 ELSE 1 END`) !== '1',
    'The host database has no app.UserSettings (QC-920).',
  );

  const id = {} as Record<Seeded, string>;
  let admin: NotifyBySmsSession;
  let vendor: NotifyBySmsSession;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    removeAll();
    runSeedScript('host-qc936.apply.sql', { SourceEmail: env.admin!.email, IdentityDb: env.identitySql!.database });
    for (const name of SEEDED) {
      id[name] = userId(email(name));
      expect(id[name], `the throwaway host user ${name}`).toMatch(/^[0-9a-f-]{36}$/);
    }

    admin = await NotifyBySmsSession.signIn(browser, { email: email('admin'), password: env.admin!.password });
    vendor = await NotifyBySmsSession.signIn(browser, { email: email('vendor'), password: env.admin!.password });
    const names = (items: unknown) => ((items ?? []) as { text?: string }[]).map((o) => o.text);
    await expect
      .poll(
        async () => [
          (await admin.api.userEdit('manageusers', id.linked)).status,
          (await vendor.api.userEdit('vendor', id.linked)).status,
          names((await admin.api.organisationOptions('Driver')).data?.availableOrganisations).includes(TRUCK),
          names((await vendor.api.userCreate('vendor')).data?.availableTrucks).includes(TRUCK),
        ],
        {
          message: 'the host API sees the new vendor and truck once its organisation tree cache (Auth:OrganisationTreeCacheSeconds) expires',
          ...ORG_CACHE,
        },
      )
      .toEqual([200, 200, true, true]);
  });

  test.afterAll(async () => {
    try {
      await admin?.close();
      await vendor?.close();
    } finally {
      removeAll();
    }
  });

  test('SMSSET-01 user-edit of a Driver with no app.UserSettings row answers notifyBySms true and not contact-locked, and both create models start ticked', async () => {
    const manage = await admin.api.userEdit('manageusers', id.plain);
    expect(manage.status, manage.text).toBe(200);
    expect(manage.data).toMatchObject({ notifyBySms: true, showNotifyBySms: true, IsContactLocked: false });

    const portal = await vendor.api.userEdit('vendor', id.plain);
    expect(portal.status, portal.text).toBe(200);
    expect(portal.data).toMatchObject({ notifyBySms: true, IsContactLocked: false });

    const create = await admin.api.userCreate('manageusers');
    expect(create.status, create.text).toBe(200);
    expect(create.data, 'Create New User starts as Admin, so the tick is hidden but defaults on').toMatchObject({ notifyBySms: true, showNotifyBySms: false });
    const portalCreate = await vendor.api.userCreate('vendor');
    expect(portalCreate.status, portalCreate.text).toBe(200);
    expect(portalCreate.data).toMatchObject({ notifyBySms: true });

    expect(setting(id.plain), 'reading the user adds no app.UserSettings row').toBeNull();
  });

  test('SMSSET-02 Manage Users > Create New User hides Text messages for Admin and shows it ticked for Vendor and Driver, following the role as it changes', async () => {
    for (const [role, shown] of [
      ['Admin', false],
      ['Sales', false],
      ['Vendor', true],
      ['Driver', true],
    ] as const) {
      const options = await admin.api.organisationOptions(role);
      expect(options.status, options.text).toBe(200);
      expect(options.data?.showNotifyBySms, `organisation-options/${role} showNotifyBySms`).toBe(shown);
    }

    const page = admin.adminUser;
    await page.open();
    await expect(page.role).toContainText('Admin');
    await expect(page.textMessages.root).toHaveCount(0);

    await page.chooseRole('Vendor');
    await expect(page.textMessages.checkbox).toBeVisible();
    await expect(page.textMessages.checkbox, 'ticked by default on create').toBeChecked();
    await page.expectContactEditable();

    await page.chooseRole('Driver');
    await expect(page.textMessages.checkbox).toBeChecked();

    await page.chooseRole('Sales');
    await expect(page.textMessages.root).toHaveCount(0);
    await page.chooseRole('Vendor');
    await expect(page.textMessages.checkbox).toBeVisible();
  });

  test('SMSSET-03 Manage Users: a Driver created with Text messages unticked stores NotifyBySms 0 with its phone, reopens unticked, and ticking it stores 1', async () => {
    const address = email('created.admin');
    const page = admin.adminUser;
    await page.open();
    await page.fillPerson(address, 'E2E', 'QC-936 Created Admin');
    await page.phone.input.fill('5125559363');
    await page.chooseRole('Driver');
    await page.chooseOrganisation(TRUCK);
    await expect(page.textMessages.checkbox).toBeChecked();
    await page.textMessages.checkbox.uncheck();
    const created = await page.saveNew();

    expect(setting(created)).toEqual({ notifyBySms: '0', phone: '5125559363' });
    expect((await admin.api.userEdit('manageusers', created)).data).toMatchObject({ notifyBySms: false, IsContactLocked: false });

    await page.open(created);
    await expect(page.textMessages.checkbox, 'unticked after a reload').not.toBeChecked();
    await page.expectContactEditable();
    await page.textMessages.checkbox.check();
    expect(await page.saveExisting()).toBe(200);
    expect(setting(created)).toEqual({ notifyBySms: '1', phone: '5125559363' });

    await page.open(created);
    await expect(page.textMessages.checkbox, 'ticked after a reload').toBeChecked();
    expect(value(`SELECT COUNT(*) FROM app.UserSettings WHERE UserID_FK = N'${created}'`), 'one row per user').toBe('1');
  });

  test('SMSSET-04 Vendor Portal > My Users: the tick shows for drivers and non-drivers; a driver created unticked stores NotifyBySms 0, and ticking it stores 1', async () => {
    const address = email('created.vendor');
    const page = vendor.vendorUser;
    await page.open();
    await expect(page.truckDriver).not.toBeChecked();
    await expect(page.textMessages.checkbox, 'shown for a non-driver').toBeVisible();
    await expect(page.textMessages.checkbox).toBeChecked();
    await page.expectContactEditable();

    await page.fillPerson(address, 'E2E', 'QC-936 Created Vendor');
    await page.phone.input.fill('5125559365');
    await page.chooseTruck(TRUCK);
    await expect(page.textMessages.checkbox, 'shown for a driver').toBeVisible();
    await page.textMessages.checkbox.uncheck();
    const created = await page.saveNew();

    expect(setting(created)).toEqual({ notifyBySms: '0', phone: '5125559365' });
    expect((await vendor.api.userEdit('vendor', created)).data).toMatchObject({ notifyBySms: false, isDriver: true, IsContactLocked: false });

    await page.open(created);
    await expect(page.textMessages.checkbox, 'unticked after a reload').not.toBeChecked();
    await page.textMessages.checkbox.check();
    expect(await page.saveExisting()).toBe(200);
    expect(setting(created)).toEqual({ notifyBySms: '1', phone: '5125559365' });

    await page.open(created);
    await expect(page.textMessages.checkbox, 'ticked after a reload').toBeChecked();
  });

  test('SMSSET-05 a linked user (UserUUID set) shows Text messages disabled and unticked and the phone read-only with "Set by the Driver in the Driver App." on both forms, and a Save keeps them', async () => {
    const before = settingStamp(id.linked);
    expect(before, 'the seeded row is NotifyBySms 0 with the phone').toMatch(new RegExp(`^0\\|${LINKED_PHONE}\\|`));

    const manage = admin.adminUser;
    await manage.open(id.linked);
    await expect(manage.textMessages.checkbox).not.toBeChecked();
    await manage.expectContactLocked();
    await expect(manage.phone.input).toHaveValue(/512.*555.*9361/);
    expect(await manage.saveExisting()).toBe(200);
    expect(settingStamp(id.linked), 'saving the page leaves the row untouched').toBe(before);
    expect(storedPhone(id.linked)).toBe(LINKED_PHONE);

    const portal = vendor.vendorUser;
    await portal.open(id.linked);
    await expect(portal.textMessages.checkbox).not.toBeChecked();
    await portal.expectContactLocked();
    expect(await portal.saveExisting()).toBe(200);
    expect(settingStamp(id.linked), 'saving the Vendor Portal page leaves the row untouched').toBe(before);
    expect(storedPhone(id.linked)).toBe(LINKED_PHONE);
  });

  test('SMSSET-06 for a linked user, posting user-edit with notifyBySms true and another phone changes neither the row nor the phone (Manage Users and Vendor Portal)', async () => {
    const before = settingStamp(id.linked);
    for (const [session, area] of [
      [admin, 'manageusers'],
      [vendor, 'vendor'],
    ] as const) {
      const model = await session.api.userEdit(area, id.linked);
      expect(model.status, model.text).toBe(200);
      expect(model.data).toMatchObject({ notifyBySms: false, IsContactLocked: true });
      const saved = await session.api.saveUserEdit(area, {
        ...model.data,
        notifyBySms: true,
        phoneNumber: '5125550936',
        password: null,
        confirmPassword: null,
      });
      expect(saved.status, saved.text).toBe(200);
      expect(settingStamp(id.linked), `${area}: app.UserSettings is not touched`).toBe(before);
      expect(storedPhone(id.linked), `${area}: auth.Users.PhoneNumber stays as stored`).toBe(LINKED_PHONE);
      expect((await session.api.userEdit(area, id.linked)).data).toMatchObject({ notifyBySms: false, phoneNumber: LINKED_PHONE });
    }
  });

  test('SMSSET-07 an unlinked Driver posted through user-edit saves the new phone and NotifyBySms; a Sales user gets no app.UserSettings row', async () => {
    try {
      const model = await admin.api.userEdit('manageusers', id.plain);
      expect(model.status, model.text).toBe(200);
      const saved = await admin.api.saveUserEdit('manageusers', {
        ...model.data,
        notifyBySms: false,
        phoneNumber: '5125559364',
        password: null,
        confirmPassword: null,
      });
      expect(saved.status, saved.text).toBe(200);
      expect(digits(storedPhone(id.plain)), 'the phone of an unlinked user still saves').toBe('5125559364');
      expect(setting(id.plain)).toEqual({ notifyBySms: '0', phone: '5125559364' });
    } finally {
      value(`DELETE app.UserSettings WHERE UserID_FK = N'${id.plain}'; UPDATE auth.Users SET PhoneNumber = N'${PLAIN_PHONE}' WHERE Id = N'${id.plain}'`);
    }
    expect(setting(id.plain), 'the plain driver is back to no row').toBeNull();
    expect(storedPhone(id.plain)).toBe(PLAIN_PHONE);

    const staff = await admin.api.userEdit('manageusers', id.staff);
    expect(staff.status, staff.text).toBe(200);
    expect(staff.data).toMatchObject({ showNotifyBySms: false });
    const posted = await admin.api.saveUserEdit('manageusers', { ...staff.data, notifyBySms: false, password: null, confirmPassword: null });
    expect(posted.status, posted.text).toBe(200);
    expect(setting(id.staff), 'host staff roles get no row').toBeNull();
  });
});
