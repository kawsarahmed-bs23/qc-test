import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, queryIdentityDb, querySingleValue, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import { DispatchContactSession, MISSING_DISPATCH_CONTACT, contactChangedMessage } from '@pages/dispatch-contact.page';
import { ReplyLinkApi, randomCode, sha256Hex } from '@pages/reply-links.page';
import { ASSIGNMENT_STATUS } from '@pages/message-link.page';

const MARKER = 'e2e-qc910';
const NAMES = ['admin', 'alpha', 'bravo', 'driver', 'mover', 'bee'] as const;
type Name = (typeof NAMES)[number];
const FULL: Record<Name, string> = {
  admin: 'E2E QC-910 Admin',
  alpha: 'E2E QC-910 Alpha',
  bravo: 'E2E QC-910 Bravo',
  driver: 'E2E QC-910 Driver',
  mover: 'E2E QC-910 Mover',
  bee: 'E2E QC-910 Bee',
};
const ALPHA_PHONE = '5125559101';
const ORG_CACHE = { timeout: 120_000, intervals: [5_000] };

function email(name: Name): string {
  return `e2e.qc910.${name}@quarryconnect.test`;
}

function value(query: string): string | null {
  return querySingleValue(query);
}

function orgId(name: string): number {
  return Number(value(`SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'${name}'`) ?? '0');
}

/**
 * What the move warning names a Truck by: its app.TruckSettings.TruckNumber, else its name (QC-922). On a database without the
 * QC-922 column it is the short name, else the name, as before.
 */
function truckLabel(truckId: number): string {
  const hasNumber = value(`SELECT CASE WHEN COL_LENGTH(N'app.TruckSettings', N'TruckNumber') IS NULL THEN 0 ELSE 1 END`) === '1';
  return (
    value(
      hasNumber
        ? `SELECT COALESCE(NULLIF(ts.TruckNumber, N''), o.OrganisationName) FROM auth.Organisations o LEFT JOIN app.TruckSettings ts ON ts.OrganisationID_FK = o.OrganisationID WHERE o.OrganisationID = ${truckId}`
        : `SELECT COALESCE(NULLIF(OrganisationShortName, N''), OrganisationName) FROM auth.Organisations WHERE OrganisationID = ${truckId}`,
    ) ?? ''
  );
}

function hostToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
}

function removeAll(): void {
  const output = runSeedScript('host-qc910.remove.sql');
  runIdentitySeedScript('identity-qc910.remove.sql');
  if (!/REMOVED left=0/.test(output)) throw new Error(`QC-910 rows are left behind:\n${output}`);
}

test.describe('Vendor Dispatch Contact and the move warning between a Vendor and a Truck (QC-910)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'default' });
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's and Identity's local databases (local only).");
  test.skip(
    !env.admin || !env.appApiUrl || !env.appUrl,
    'Needs ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway users copy that password), APP_URL and APP_API_URL.',
  );
  test.skip(
    canSeedLocalDb() && value(`SELECT CASE WHEN COL_LENGTH(N'app.VendorSettings', N'DispatchContactUserID_FK') IS NULL THEN 0 ELSE 1 END`) !== '1',
    'The QC-910 migration (app.VendorSettings.DispatchContactUserID_FK) is not applied.',
  );

  const id = {} as Record<Name, string>;
  let vendorA = 0;
  let vendorB = 0;
  let truckA = 0;
  let truckB = 0;
  let orderId = 0;
  let admin: DispatchContactSession;
  let alpha: DispatchContactSession;

  const contactOf = (vendorId: number) => value(`SELECT DispatchContactUserID_FK FROM app.VendorSettings WHERE OrganisationID_FK = ${vendorId}`);
  const billToOf = (vendorId: number) => value(`SELECT BillToUserId_Fk FROM app.VendorSettings WHERE OrganisationID_FK = ${vendorId}`);
  const organisationOf = (name: Name) => Number(value(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = N'${id[name]}'`));
  const rolesOf = (name: Name) => value(`SELECT STRING_AGG(RoleName, ',') FROM auth.UserToRoles WHERE UserId = N'${id[name]}'`);
  const setContact = (vendorId: number, name: Name | null) =>
    value(`UPDATE app.VendorSettings SET DispatchContactUserID_FK = ${name ? `N'${id[name]}'` : 'NULL'} WHERE OrganisationID_FK = ${vendorId}`);
  const assignmentsOf = (vendorId: number) => Number(value(`SELECT COUNT(*) FROM app.OrderAssignments WHERE VendorID_FK = ${vendorId}`));
  const uuidOf = (name: Name) => value(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE Id = N'${id[name]}'`);
  const stampOf = (assignment: number) =>
    value(`SELECT LOWER(CONVERT(nvarchar(36), DriverUserUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignment}`);
  const offersSent = (assignment: number) =>
    Number(
      value(
        `SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignment} AND OrderAssignmentHistoryData LIKE N'Job offer sent to the Driver%'`,
      ),
    );
  const isActive = (name: Name) => value(`SELECT CAST(IsActive AS int) FROM auth.Users WHERE Id = N'${id[name]}'`);
  const openVendorOffer = async (vendorId: number) => {
    const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId, notes: MARKER });
    expect(saved.status, saved.text).toBe(201);
    return Number(saved.data);
  };
  const saveUserByApi = async (name: Name, changes: Record<string, unknown>) => {
    const model = await admin.api.userEdit('manageusers', id[name]);
    expect(model.status, model.text).toBe(200);
    const saved = await admin.api.saveUserEdit('manageusers', { ...model.data, ...changes, password: null, confirmPassword: null });
    expect(saved.status, saved.text).toBe(200);
    return saved;
  };

  const expectBillingUntouched = () => {
    expect(billToOf(vendorA), "Vendor A's billing contact (BillToUserID_FK) is still alpha").toBe(id.alpha);
    expect(billToOf(vendorB), 'Vendor B still has no billing contact').toBeNull();
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    removeAll();
    for (const name of NAMES) {
      runIdentitySeedScript('identity-qc910-user.apply.sql', {
        Email: email(name),
        SourceEmail: env.admin!.email,
        LastName: `QC-910 ${name}`,
        TwoFactor: '0',
        AuthenticatorKey: 'none',
      });
      id[name] = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email(name)}')`) ?? '';
      expect(id[name], `the throwaway Identity user ${name}`).toMatch(/^[0-9a-f-]{36}$/);
    }
    runSeedScript('host-qc910.apply.sql', { IdentityDb: env.identitySql!.database });
    vendorA = orgId('E2E QC-910 Vendor A');
    vendorB = orgId('E2E QC-910 Vendor B');
    truckA = orgId('E2E QC-910 Truck A');
    truckB = orgId('E2E QC-910 Truck B');
    orderId = Number(value(`SELECT OrderID FROM app.Orders WHERE Notes = N'${MARKER}'`));
    expect(vendorA * vendorB * truckA * truckB * orderId, 'the throwaway vendors, trucks and order exist').toBeGreaterThan(0);

    admin = await DispatchContactSession.signIn(browser, { email: email('admin'), password: env.admin!.password });
    alpha = await DispatchContactSession.signIn(browser, { email: email('alpha'), password: env.admin!.password });
    await expect
      .poll(
        async () => [
          (await admin.api.vendorEdit(vendorA)).status,
          (await admin.api.truckEdit(truckA)).status,
          (await alpha.api.dispatchContactSetting()).status,
        ],
        {
          message: 'the host API sees the new organisations once its organisation tree cache (Auth:OrganisationTreeCacheSeconds) expires',
          ...ORG_CACHE,
        },
      )
      .toEqual([200, 200, 200]);
  });

  test.afterAll(async () => {
    await admin?.close();
    await alpha?.close();
    removeAll();
  });

  test('DCON-01 Admin > Users shows "Is dispatch contact" for a Vendor-role user; ticking it on the Vendor\'s first contact saves it with no replace message', async () => {
    setContact(vendorA, null);
    const answer = await admin.api.userEdit('manageusers', id.alpha);
    expect(answer.data).toMatchObject({ showIsDispatchContact: true, isDispatchContact: false, isBillingContact: true });

    const page = admin.adminUser;
    await page.open(id.alpha);
    await expect(page.dispatchContact).not.toBeChecked();
    await expect(page.dispatchContactHelp).toBeVisible();
    await page.dispatchContact.check();
    const saved = await page.saveUser();
    expect(saved.status).toBe(200);
    expect(saved.message ?? '', 'no "changed from" message when the Vendor had no contact').not.toContain('Dispatch contact changed');
    await page.toasts.expectSuccess('User updated successfully!');
    expect(contactOf(vendorA)).toBe(id.alpha);

    await page.open(id.alpha);
    await expect(page.dispatchContact, 'the tick shows after a reload').toBeChecked();
    expectBillingUntouched();
  });

  test('DCON-02 ticking it on another user of the same Vendor replaces the contact and the toast reads "Dispatch contact changed from <A> to <B>."', async () => {
    setContact(vendorA, 'alpha');
    const page = admin.adminUser;
    await page.open(id.bravo);
    await expect(page.dispatchContact).not.toBeChecked();
    await page.dispatchContact.check();
    const saved = await page.saveUserConfirming('replace', `${FULL.alpha} is this Vendor's dispatch contact today.`);
    expect(saved.status).toBe(200);
    expect(saved.message).toBe(contactChangedMessage(FULL.alpha, FULL.bravo));
    await page.toasts.expectSuccess(contactChangedMessage(FULL.alpha, FULL.bravo));

    expect(contactOf(vendorA)).toBe(id.bravo);
    expect((await admin.api.userEdit('manageusers', id.alpha)).data).toMatchObject({ isDispatchContact: false });
    expect((await admin.api.userEdit('manageusers', id.bravo)).data).toMatchObject({ isDispatchContact: true });
    expectBillingUntouched();
  });

  test('DCON-03 saving a user who is not the contact with the box unticked leaves the contact; unticking the contact clears it', async () => {
    setContact(vendorA, 'bravo');
    const page = admin.adminUser;
    await page.open(id.alpha);
    await expect(page.dispatchContact).not.toBeChecked();
    expect((await page.saveUser()).status).toBe(200);
    expect(contactOf(vendorA), 'saving alpha unticked does not clear bravo').toBe(id.bravo);

    await page.open(id.bravo);
    await expect(page.dispatchContact).toBeChecked();
    await page.dispatchContact.uncheck();
    expect((await page.saveUserConfirming('leave')).status).toBe(200);
    expect(contactOf(vendorA), 'unticking the contact clears it').toBeNull();
    expectBillingUntouched();
  });

  test('DCON-04 the tick is not shown for a Driver-role user or after choosing a non-Vendor role on Create, and posting it for a Driver sets nothing', async () => {
    setContact(vendorA, null);
    const page = admin.adminUser;
    await page.open(id.driver);
    await expect(page.role).toContainText('Driver');
    await expect(page.dispatchContact).toHaveCount(0);

    const driver = await admin.api.userEdit('manageusers', id.driver);
    expect(driver.data).toMatchObject({ showIsDispatchContact: false, isDispatchContact: false });
    const posted = await admin.api.saveUserEdit('manageusers', { ...driver.data, isDispatchContact: true, password: null, confirmPassword: null });
    expect(posted.status, posted.text).toBe(200);
    expect(contactOf(vendorA), 'a Driver cannot become the Vendor contact').toBeNull();
    expect(value(`SELECT COUNT(*) FROM app.VendorSettings WHERE DispatchContactUserID_FK = N'${id.driver}'`)).toBe('0');
    expect(organisationOf('driver'), 'the driver stays on Truck A').toBe(truckA);

    await page.open();
    await page.chooseRole('Vendor');
    await expect(page.dispatchContact).toBeVisible();
    await page.chooseRole('Driver');
    await expect(page.dispatchContact).toHaveCount(0);
  });

  test('DCON-05 Vendor Portal > My Users shows the tick only while "Truck Driver" is unticked, and ticking it replaces the contact with the same message', async () => {
    const own = await alpha.api.saveDispatchContactSetting(true);
    expect(own.status, own.text).toBe(200);
    expect(contactOf(vendorA)).toBe(id.alpha);

    const page = alpha.vendorUser;
    await page.open(id.bravo);
    await expect(page.truckDriver).not.toBeChecked();
    await expect(page.dispatchContact).not.toBeChecked();
    await expect(page.dispatchContactHelp).toBeVisible();
    await page.truckDriver.check();
    await expect(page.dispatchContact).toHaveCount(0);
    await page.truckDriver.uncheck();
    await expect(page.dispatchContact).toBeVisible();

    await page.dispatchContact.check();
    const saved = await page.saveUserConfirming('replace', `${FULL.alpha} is this Vendor's dispatch contact today.`);
    expect(saved.status).toBe(200);
    expect(saved.message).toBe(contactChangedMessage(FULL.alpha, FULL.bravo));
    await page.toasts.expectSuccess(contactChangedMessage(FULL.alpha, FULL.bravo));
    expect(contactOf(vendorA)).toBe(id.bravo);
    expect((await alpha.api.userEdit('vendor', id.bravo)).data).toMatchObject({ isDispatchContact: true, isDriver: false });
    expect(organisationOf('bravo'), 'bravo stays a user of Vendor A').toBe(vendorA);
    expect(rolesOf('bravo')).toBe('Vendor');
    expectBillingUntouched();
  });

  test('DCON-06 My Profile ticks and unticks the signed-in Vendor user as the contact at once, naming the current contact first', async () => {
    setContact(vendorA, 'bravo');
    const page = alpha.profile;
    await page.open();
    await expect(page.checkbox).not.toBeChecked();
    await expect(page.todayIs(FULL.bravo)).toBeVisible();

    expect(await page.toggle('replace')).toBe(200);
    await page.toasts.expectSuccess(contactChangedMessage(FULL.bravo, FULL.alpha));
    await expect(page.checkbox).toBeChecked();
    expect(contactOf(vendorA)).toBe(id.alpha);
    expect((await alpha.api.dispatchContactSetting()).data).toEqual({ isDispatchContact: true, dispatchContactName: FULL.alpha });

    await page.open();
    await expect(page.checkbox, 'the tick shows after a reload').toBeChecked();
    expect(await page.toggle('leave')).toBe(200);
    await page.toasts.expectSuccess('Your setting is saved.');
    expect(contactOf(vendorA), 'unticking clears the contact').toBeNull();

    expect(await page.toggle()).toBe(200);
    expect(contactOf(vendorA)).toBe(id.alpha);
    expect((await admin.api.dispatchContactSetting()).status, 'the setting is Vendor-only').toBe(403);
    expectBillingUntouched();
  });

  test('DCON-07 Edit Vendor shows "Dispatch contact: <name>", or "None" with the hint when the Vendor has none', async () => {
    setContact(vendorA, 'alpha');
    setContact(vendorB, null);
    const page = admin.editVendor;
    await page.open(vendorA);
    await page.expectDispatchContact(FULL.alpha);
    expect((await admin.api.vendorEdit(vendorA)).data).toMatchObject({ dispatchContactUserId: id.alpha, dispatchContactName: FULL.alpha });

    await page.open(vendorB);
    await page.expectDispatchContact(null);
    expect((await admin.api.vendorEdit(vendorB)).data).toMatchObject({ dispatchContactUserId: null, dispatchContactName: null });
  });

  test('DCON-08 Edit Vendor warns before saving a user who is on another Truck; Cancel sends nothing and the user stays where they were', async () => {
    setContact(vendorA, 'alpha');
    const organisations = ((await admin.api.vendorEdit(vendorA)).data?.availableUserOrganisations ?? []) as Record<string, unknown>[];
    expect(organisations.find((o) => o.userId === id.mover)).toMatchObject({
      organisationId: truckB,
      organisationShortName: 'E2E910TB',
      organisationType: 'Truck',
    });

    const page = admin.editVendor;
    await page.open(vendorA);
    await page.addAssociatedUser(FULL.mover);
    await page.fillAddressIfEmpty('E2E QC-910 Yard', '910 Congress Ave');
    const saves = page.countSaves();
    await page.save.click();
    await page.moveDialog.expectMove('Vendor', `${FULL.mover} is on Truck ${truckLabel(truckB)}. Adding them to this Vendor removes them from that Truck.`);
    await page.moveDialog.cancel.click();
    await expect(page.moveDialog.root).toHaveCount(0);
    await expect(page.save).toBeEnabled();
    expect(saves(), 'Cancel sends no vendor-edit POST').toBe(0);
    expect(organisationOf('mover'), 'the mover is still on Truck B').toBe(truckB);
    expect(contactOf(vendorA)).toBe(id.alpha);
  });

  test('DCON-09 "Move and save" on Edit Vendor moves the Truck user into the Vendor and leaves the dispatch and billing contacts alone', async () => {
    setContact(vendorA, 'alpha');
    const page = admin.editVendor;
    await page.open(vendorA);
    await page.addAssociatedUser(FULL.mover);
    await page.fillAddressIfEmpty('E2E QC-910 Yard', '910 Congress Ave');
    await page.save.click();
    await page.moveDialog.expectMove('Vendor', `${FULL.mover} is on Truck ${truckLabel(truckB)}. Adding them to this Vendor removes them from that Truck.`);
    const saved = page.saveRequest();
    await page.moveDialog.moveAndSave.click();
    const response = await saved;
    expect(response.status(), `POST vendor-edit ${await response.text()}`).toBe(200);
    await page.toasts.expectSuccess('Vendor updated successfully!');

    expect(organisationOf('mover'), 'the mover now belongs to Vendor A').toBe(vendorA);
    expect(rolesOf('mover')).toBe('Vendor');
    expect(contactOf(vendorA)).toBe(id.alpha);
    expectBillingUntouched();
  });

  test("DCON-10 Edit Truck warns before taking a Vendor's user; Cancel changes nothing, and Move and save moves them and clears that Vendor's dispatch contact", async () => {
    setContact(vendorB, 'bee');
    const line = `${FULL.bee} is a user of Vendor E2E QC-910 Vendor B. Adding them to this Truck removes them from that Vendor.`;
    const page = admin.editTruck;

    await page.open(truckA);
    await page.addAssociatedUser(FULL.bee);
    await page.fillAddressIfEmpty('E2E QC-910 Truck Yard', '910 Congress Ave');
    const saves = page.countSaves();
    await page.save.click();
    await page.moveDialog.expectMove('Truck', line);
    await page.moveDialog.cancel.click();
    await expect(page.moveDialog.root).toHaveCount(0);
    expect(saves(), 'Cancel sends no truck-edit POST').toBe(0);
    expect(organisationOf('bee')).toBe(vendorB);
    expect(contactOf(vendorB), "Cancel keeps Vendor B's contact").toBe(id.bee);

    await page.open(truckA);
    await page.addAssociatedUser(FULL.bee);
    await page.fillAddressIfEmpty('E2E QC-910 Truck Yard', '910 Congress Ave');
    await page.save.click();
    await page.moveDialog.expectMove('Truck', line);
    const saved = page.saveRequest();
    await page.moveDialog.moveAndSave.click();
    const response = await saved;
    expect(response.status(), `POST truck-edit ${await response.text()}`).toBe(200);
    await page.toasts.expectSuccess('Truck updated successfully!');

    expect(organisationOf('bee'), 'bee now drives Truck A').toBe(truckA);
    expect(rolesOf('bee')).toBe('Driver');
    expect(contactOf(vendorB), "moving the contact away clears Vendor B's dispatch contact").toBeNull();
    expect(organisationOf('driver'), "Truck A's own driver stays").toBe(truckA);
    expectBillingUntouched();
  });

  test('DCON-11 a Vendor-only assignment for a Vendor with no dispatch contact is refused by the API, and the SMS preview says why', async () => {
    setContact(vendorB, null);
    const before = assignmentsOf(vendorB);
    const refused = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorB, notes: MARKER });
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toContain(MISSING_DISPATCH_CONTACT);
    expect(assignmentsOf(vendorB), 'no assignment row is added').toBe(before);

    const preview = await admin.api.smsPreview(orderId, vendorB);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.data).toMatchObject({ canSend: false, cannotSendReason: MISSING_DISPATCH_CONTACT });
    expect(await admin.api.assignVendor(vendorB)).toMatchObject({ vendorName: 'E2E QC-910 Vendor B', dispatchContactUserId: null });
  });

  test('DCON-12 the Assign Truck dialog warns for a Vendor-only offer to a Vendor with no contact and names the contact for one that has it', async () => {
    setContact(vendorA, 'alpha');
    setContact(vendorB, null);
    const dialog = admin.schedule;
    await dialog.openDialog();
    await dialog.chooseVendor('E2E QC-910 Vendor B');
    await dialog.expectMissingContact();
    await dialog.chooseVendor('E2E QC-910 Vendor A');
    await dialog.expectContact(FULL.alpha);
    await expect(dialog.offerMessage).toBeEditable();
  });

  test('DCON-13 before a Vendor is chosen the Assign Truck dialog shows no dispatch-contact note', async () => {
    const dialog = admin.schedule;
    await dialog.openDialog();
    await expect(dialog.vendor).toContainText('Select vendor');
    await expect(dialog.contactNote, 'no "The offer goes to the Vendor\'s dispatch contact, ." line with an empty name').toHaveCount(0);
    await expect(dialog.missingContact).toHaveCount(0);
  });

  test("DCON-14 a Vendor-only assignment for a Vendor with a contact saves with DriverUserId NULL and DriverUserUUID set to the contact's UserUUID, and the preview can text the contact", async () => {
    setContact(vendorA, 'alpha');
    const option = await admin.api.assignVendor(vendorA);
    expect(option).toMatchObject({ dispatchContactUserId: id.alpha, dispatchContactName: FULL.alpha });
    expect((option?.dispatchContactPhoneNumber ?? '').replace(/\D/g, ''), 'the contact phone (the Admin page saves it formatted)').toBe(ALPHA_PHONE);
    const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorA, notes: MARKER });
    expect(saved.status, saved.text).toBe(201);
    const offerId = Number(saved.data);
    expect(offerId).toBeGreaterThan(0);

    const row = value(
      `SELECT CONCAT(ISNULL(DriverUserID_FK, 'NULL'), '|', ISNULL(LOWER(CONVERT(nvarchar(36), DriverUserUUID)), 'NULL'), '|', ISNULL(CAST(TruckID_FK AS varchar(12)), 'NULL'), '|', OrderAssignmentStatusID_FK) FROM app.OrderAssignments WHERE OrderAssignmentID = ${offerId}`,
    );
    const alphaUuid = value(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE Id = N'${id.alpha}'`);
    expect(row).toBe(`NULL|${alphaUuid}|NULL|${ASSIGNMENT_STATUS.Pending}`);

    const preview = await admin.api.smsPreview(orderId, vendorA);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.data).toMatchObject({ canSend: true, cannotSendReason: null });
    expect((preview.data?.phoneNumber ?? '').replace(/\D/g, '')).toContain(ALPHA_PHONE);
  });

  test('DCON-15 a Vendor-only offer to a dispatch contact with no phone saves (QC-930 retired the Send SMS phone rule); that contact is on the Driver App, so the preview and the history send it there', async () => {
    setContact(vendorA, 'bravo');
    try {
      expect((await admin.api.smsPreview(orderId, vendorA)).data).toMatchObject({ canSend: true, cannotSendReason: null, delivery: 'app' });
      const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorA, notes: MARKER });
      expect(saved.status, saved.text).toBe(201);
      const assignment = Number(saved.data);
      expect(
        value(
          `SELECT STRING_AGG(CONCAT(Channel, '|', ISNULL(TwilioMessageSid, '~')), ',') FROM app.Messages WHERE OrderAssignmentID_FK = ${assignment} AND DriverUserID_FK = N'${id.bravo}' AND Direction = 20`,
        ),
        'one offer message for the contact, stored as App with no Twilio id',
      ).toBe('20|~');
      expect(
        value(
          `SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignment} AND OrderAssignmentHistoryData = N'Job offer message sent to the dispatch contact''s Driver App; their own setting decides texts.'`,
        ),
      ).toBe('1');
    } finally {
      setContact(vendorA, 'alpha');
    }
    expect(contactOf(vendorA)).toBe(id.alpha);
  });

  test('DCON-16 every new Vendor-only offer sends the offer message to the dispatch contact (message row for the contact) with no Send SMS tick', async () => {
    setContact(vendorA, 'alpha');
    const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorA, notes: MARKER });
    expect(saved.status, saved.text).toBe(201);
    const assignment = Number(saved.data);
    expect(value(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${assignment} AND DriverUserID_FK = N'${id.alpha}' AND Direction = 20`)).toBe(
      '1',
    );
  });

  test('DCON-17 the reply link of a Vendor-only offer is open for the contact it was sent to (Accept accepts it) and withdrawn for anyone else', async () => {
    setContact(vendorA, 'alpha');
    const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorA, notes: MARKER });
    expect(saved.status, saved.text).toBe(201);
    const offerId = Number(saved.data);
    const contactCode = randomCode();
    const otherCode = randomCode();
    runSeedScript('host-qc910-offer.apply.sql', { OrderAssignmentId: String(offerId), RecipientUserId: id.bravo, CodeHash: sha256Hex(otherCode) });
    runSeedScript('host-qc910-offer.apply.sql', { OrderAssignmentId: String(offerId), RecipientUserId: id.alpha, CodeHash: sha256Hex(contactCode) });

    const links = await ReplyLinkApi.open();
    try {
      const other = await links.get(otherCode);
      expect(other.status, other.text).toBe(200);
      expect(other.view?.state, 'a link sent to someone other than the contact').toBe('withdrawn');

      const open = await links.get(contactCode);
      expect(open.status, open.text).toBe(200);
      expect(open.view?.state).toBe('open');
      const answer = await links.reply(contactCode, { option: 'accept', comment: null });
      expect(answer.status, answer.text).toBe(200);
    } finally {
      await links.close();
    }
    expect(Number(value(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${offerId}`))).toBe(ASSIGNMENT_STATUS.Accepted);
  });

  test('DCON-18 none of this changed a billing contact: Vendor A still bills alpha, Vendor B has none, and Admin > Users still shows alpha as billing contact', async () => {
    setContact(vendorA, 'alpha');
    expectBillingUntouched();
    expect((await admin.api.userEdit('manageusers', id.alpha)).data).toMatchObject({ isBillingContact: true, isDispatchContact: true });
    const page = admin.adminUser;
    await page.open(id.alpha);
    await expect(page.billingContact).toBeChecked();
    await expect(page.dispatchContact).toBeChecked();
  });

  test('DCON-19 an existing Vendor-only assignment whose Vendor lost its contact can still be saved unchanged, sending no new offer, and not moved to another Vendor without a contact', async () => {
    setContact(vendorA, 'alpha');
    setContact(vendorB, null);
    const saved = await admin.api.saveVendorOnlyAssignment({ orderId, assignmentDate: hostToday(), vendorId: vendorA, notes: MARKER });
    expect(saved.status, saved.text).toBe(201);
    const assignment = Number(saved.data);
    const vendorOf = () => Number(value(`SELECT VendorID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignment}`));
    const messagesOf = () => value(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${assignment}`);
    const offered = messagesOf();

    setContact(vendorA, null);
    const unchanged = await admin.api.updateVendorOnlyAssignment(assignment, {
      orderId,
      assignmentDate: hostToday(),
      vendorId: vendorA,
      notes: `${MARKER} edited`,
    });
    expect(unchanged.status, unchanged.text).toBe(200);
    expect(value(`SELECT Notes FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignment}`)).toBe(`${MARKER} edited`);

    const moved = await admin.api.updateVendorOnlyAssignment(assignment, { orderId, assignmentDate: hostToday(), vendorId: vendorB, notes: MARKER });
    expect(moved.status, moved.text).toBe(400);
    expect(moved.text).toContain(MISSING_DISPATCH_CONTACT);
    expect(vendorOf(), 'the refused saves change nothing').toBe(vendorA);
    expect(messagesOf(), 'the unchanged save and the refused move send no new offer').toBe(offered);
  });

  test("DCON-20 replacing the contact through Admin > Users' user-edit re-stamps the Vendor's open Vendor-only offer to the new contact and offers it again; unticking them clears the stamp", async () => {
    setContact(vendorA, 'alpha');
    const assignment = await openVendorOffer(vendorA);
    try {
      expect(stampOf(assignment), 'the offer starts stamped with alpha').toBe(uuidOf('alpha'));
      const offersBefore = offersSent(assignment);

      const replaced = await saveUserByApi('bravo', { isActive: true, isDispatchContact: true });
      expect(replaced.message).toBe(contactChangedMessage(FULL.alpha, FULL.bravo));
      expect(contactOf(vendorA)).toBe(id.bravo);
      expect(stampOf(assignment), "the open offer now goes to bravo's UserUUID").toBe(uuidOf('bravo'));
      expect(offersSent(assignment), 'a "Job offer sent to the Driver" history row for the new contact').toBe(offersBefore + 1);

      await saveUserByApi('bravo', { isActive: true, isDispatchContact: false });
      expect(contactOf(vendorA)).toBeNull();
      expect(stampOf(assignment), 'clearing the contact clears DriverUserUUID').toBeNull();
      expect(offersSent(assignment), 'no offer goes out when nobody is the contact').toBe(offersBefore + 1);
    } finally {
      setContact(vendorA, 'alpha');
    }
  });

  test('DCON-21 deactivating the contact through the Admin > Users user-edit clears the Vendor\'s dispatch contact and the open offer\'s stamp, and Edit Vendor names an inactive contact "<name> (inactive)"', async () => {
    setContact(vendorA, 'alpha');
    try {
      await saveUserByApi('bravo', { isActive: true, isDispatchContact: true });
      expect(contactOf(vendorA)).toBe(id.bravo);
      const assignment = await openVendorOffer(vendorA);
      expect(stampOf(assignment)).toBe(uuidOf('bravo'));

      await saveUserByApi('bravo', { isActive: false, isDispatchContact: true });
      expect(isActive('bravo')).toBe('0');
      expect(contactOf(vendorA), 'VendorSettings.DispatchContactUserID_FK is cleared').toBeNull();
      expect(stampOf(assignment), "the open offer's DriverUserUUID is cleared").toBeNull();

      setContact(vendorA, 'bravo');
      expect((await admin.api.vendorEdit(vendorA)).data).toMatchObject({ dispatchContactUserId: id.bravo, dispatchContactName: `${FULL.bravo} (inactive)` });
    } finally {
      setContact(vendorA, null);
      await saveUserByApi('bravo', { isActive: true, isDispatchContact: false });
      setContact(vendorA, 'alpha');
    }
    expect(isActive('bravo'), 'bravo is active again').toBe('1');
    expect(contactOf(vendorA)).toBe(id.alpha);
  });

  test('DCON-22 Cancel on the "Replace the dispatch contact?" dialog of Admin > Users sends nothing, stays on the page and keeps the contact', async () => {
    setContact(vendorA, 'alpha');
    const page = admin.adminUser;
    await page.open(id.bravo);
    await page.dispatchContact.check();
    const saves = page.countSaves();
    await page.save.click();
    await page.changeDialog.expectOpen('replace', `${FULL.alpha} is this Vendor's dispatch contact today.`);
    await page.changeDialog.cancel.click();
    await expect(page.changeDialog.root).toHaveCount(0);
    await expect(page.editHeading, 'still on Edit User').toBeVisible();
    await expect(page.save).toBeEnabled();
    expect(saves(), 'Cancel sends no user-edit POST').toBe(0);
    expect(contactOf(vendorA)).toBe(id.alpha);
    expect((await admin.api.userEdit('manageusers', id.bravo)).data).toMatchObject({ isDispatchContact: false });
  });

  test('DCON-23 unticking yourself on My Profile asks first: Cancel keeps the tick and saves nothing, "Untick and save" clears the contact', async () => {
    setContact(vendorA, 'alpha');
    try {
      const page = alpha.profile;
      await page.open();
      await expect(page.checkbox).toBeChecked();
      const saves = page.countSaves();
      await page.checkbox.click();
      await page.changeDialog.expectOpen('leave');
      await page.changeDialog.cancel.click();
      await expect(page.changeDialog.root).toHaveCount(0);
      await expect(page.checkbox, 'Cancel puts the tick back').toBeChecked();
      expect(saves(), 'Cancel sends no dispatch-contact POST').toBe(0);
      expect(contactOf(vendorA)).toBe(id.alpha);

      expect(await page.toggle('leave')).toBe(200);
      await page.toasts.expectSuccess('Your setting is saved.');
      await expect(page.checkbox).not.toBeChecked();
      expect(contactOf(vendorA), 'Untick and save clears the contact').toBeNull();
    } finally {
      setContact(vendorA, 'alpha');
    }
    expect(contactOf(vendorA)).toBe(id.alpha);
  });

  test('DCON-24 a double submit of Save on Edit Vendor with a move opens one move dialog and keeps Save disabled while it is open', async () => {
    setContact(vendorA, 'alpha');
    const page = admin.editVendor;
    await page.open(vendorA);
    await page.addAssociatedUser(FULL.driver);
    await page.fillAddressIfEmpty('E2E QC-910 Yard', '910 Congress Ave');
    const saves = page.countSaves();
    await page.doubleSubmit();
    await page.moveDialog.expectMove('Vendor', `${FULL.driver} is on Truck ${truckLabel(truckA)}. Adding them to this Vendor removes them from that Truck.`);
    await expect(page.moveDialog.root, 'exactly one move dialog').toHaveCount(1);
    await expect(page.saveButton).toBeDisabled();
    await page.moveDialog.cancel.click();
    await expect(page.moveDialog.root).toHaveCount(0);
    await expect(page.saveButton).toBeEnabled();
    expect(saves(), 'Cancel sends no vendor-edit POST').toBe(0);
    expect(organisationOf('driver'), 'the driver is still on Truck A').toBe(truckA);
  });
});
