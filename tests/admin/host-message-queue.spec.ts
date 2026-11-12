import { test, expect } from '@fixtures/pageFixtures';
import { canUseMasterDb, markChangeLogs, queryMasterDb, removeChangeLogsSince, runMasterSeedScript, type ChangeLogMark } from '@utils/localDb';
import { adminAccount } from '@utils/throwawayUsers';
import { AdminApi, canUseAdminApi } from '@api/admin.api';
import { adminUrl } from '@pages/admin-shell.page';

const PROBE = 'qc-local-host-e2e.fifo';
const PATTERN_MESSAGE = 'Use letters, digits, _ or -, ending in .fifo.';
const SERVER_FORMAT_MESSAGE = /^Enter the host's SQS FIFO queue name/;
const TAKEN_MESSAGE = 'Another host already uses this message queue.';

interface HostModel {
  hostUuid: string;
  name: string;
  databaseName: string;
  uiUrl: string;
  apiBaseUrl: string | null;
  hostOrganisationId: number | null;
  messageQueue: string | null;
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function storedQueue(uuid: string): string | null {
  return queryMasterDb(`SELECT MessageQueue FROM app.Hosts WHERE HostUUID = ${sqlText(uuid)}`);
}

function latestSummary(uuid: string): string | null {
  return queryMasterDb(
    `SELECT TOP 1 c.Summary FROM app.ChangeLogs c JOIN app.Hosts h ON h.HostID = c.HostID_FK WHERE h.HostUUID = ${sqlText(uuid)} ORDER BY c.ChangeLogID DESC`,
  );
}

function hostCount(): string | null {
  return queryMasterDb('SELECT COUNT(*) FROM app.Hosts');
}

function hostInput(host: HostModel, messageQueue: string | null) {
  return {
    name: host.name,
    databaseName: host.databaseName,
    uiUrl: host.uiUrl,
    apiBaseUrl: host.apiBaseUrl ?? '',
    hostOrganisationId: host.hostOrganisationId,
    messageQueue: messageQueue ?? '',
  };
}

function note(type: string, description: string | null): void {
  test.info().annotations.push({ type, description: description ?? 'NULL' });
}

test.describe('Host message queue (QC-921)', { tag: ['@regression'] }, () => {
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
  test.skip(!canUseMasterDb(), 'MASTER_SQL_DATABASE is not set; the cases read app.Hosts.MessageQueue from HOST_MASTER.');

  test('HMQ-01 the New host page and the host page show an optional Message queue field with the .fifo hint', async ({ hostFormPage, request, targetHost }) => {
    await hostFormPage.openNew();
    await expect(hostFormPage.messageQueue).toBeVisible();
    await expect(hostFormPage.messageQueueLabel).toHaveText('Message queue (optional)');
    await expect(hostFormPage.messageQueue).toHaveAttribute('placeholder', 'qc-prod-host-rockridge.fifo');
    await expect(hostFormPage.messageQueue).toHaveAttribute('maxlength', '80');
    await expect(hostFormPage.messageQueue).not.toHaveAttribute('required', /.*/);
    await expect(hostFormPage.messageQueueHint).toContainText('SQS FIFO queue');
    await expect(hostFormPage.messageQueueHint).toContainText('Leave blank until the queue exists.');
    await expect(hostFormPage.messageQueue).toHaveValue('');

    const host = (await AdminApi.asAdmin(request).get<HostModel>(`/hosts/${targetHost.uuid}`)).body;
    expect(host).toHaveProperty('messageQueue');
    expect(host.messageQueue).toBe(storedQueue(targetHost.uuid));

    await hostFormPage.openDetail(targetHost.uuid);
    await expect(hostFormPage.messageQueueLabel).toHaveText('Message queue (optional)');
    await expect(hostFormPage.messageQueueHint).toContainText('.fifo');
    await expect(hostFormPage.messageQueue).toHaveValue(host.messageQueue ?? '');
  });

  test('HMQ-02 a queue name without .fifo, with a space or with a slash is refused in the browser and nothing is sent', async ({
    page,
    hostFormPage,
    targetHost,
  }) => {
    const sent: string[] = [];
    page.on('request', (request) => {
      if (['POST', 'PUT'].includes(request.method()) && request.url().includes('/api/hosts')) sent.push(`${request.method()} ${request.url()}`);
    });

    await hostFormPage.openNew();
    await hostFormPage.fill({
      name: 'E2E QC-921 refused',
      hostKey: 'e2e-qc921-refused',
      clientId: 'e2e-qc921.refused',
      databaseName: 'QuarryConnect_Dev',
      organisationId: '99',
      uiUrl: 'http://localhost:4293',
      messageQueue: 'qc-local-host',
    });
    for (const bad of ['qc-local-host', 'qc local.fifo', 'qc/local.fifo', 'qc-local-host.FIFO']) {
      await hostFormPage.messageQueue.fill(bad);
      await hostFormPage.create.click();
      await expect(hostFormPage.clientError('MessageQueue'), bad).toHaveText(PATTERN_MESSAGE);
      await expect(page).toHaveURL(adminUrl('/hosts/new'));
    }

    await hostFormPage.openDetail(targetHost.uuid);
    const original = await hostFormPage.messageQueue.inputValue();
    await hostFormPage.messageQueue.fill('qc-local-host');
    await hostFormPage.save.click();
    await expect(hostFormPage.clientError('MessageQueue')).toHaveText(PATTERN_MESSAGE);

    await hostFormPage.openDetail(targetHost.uuid);
    await expect(hostFormPage.messageQueue).toHaveValue(original);
    expect(sent, 'no create or update request was sent').toEqual([]);
  });

  test('HMQ-03 a direct API call with a badly formed queue name is refused 400 on messageQueue and HOST_MASTER is unchanged', async ({
    request,
    targetHost,
  }) => {
    const api = AdminApi.asAdmin(request);
    const host = (await api.get<HostModel>(`/hosts/${targetHost.uuid}`)).body;
    const before = { queue: storedQueue(targetHost.uuid), hosts: hostCount(), summary: latestSummary(targetHost.uuid) };

    for (const bad of ['qc-local-host', 'qc local.fifo', 'qc/local.fifo', '.fifo', `${'a'.repeat(76)}.fifo`]) {
      const refused = await api.put(`/hosts/${targetHost.uuid}`, hostInput(host, bad));
      expect(refused.status, bad).toBe(400);
      expect(refused.body.errors.messageQueue, bad).toEqual([expect.stringMatching(SERVER_FORMAT_MESSAGE)]);
    }

    const created = await api.post('/hosts', {
      name: 'E2E QC-921 api refused',
      hostKey: 'e2e-qc921-api-refused',
      clientId: 'e2e-qc921.apirefused',
      databaseName: 'QuarryConnect_Dev',
      uiUrl: 'http://localhost:4292',
      apiBaseUrl: '',
      hostOrganisationId: 99,
      messageQueue: 'qc-local-host',
    });
    expect(created.status).toBe(400);
    expect(Object.keys(created.body.errors)).toEqual(['messageQueue']);
    expect(created.body.errors.messageQueue).toEqual([expect.stringMatching(SERVER_FORMAT_MESSAGE)]);

    expect(storedQueue(targetHost.uuid)).toBe(before.queue);
    expect(hostCount()).toBe(before.hosts);
    expect(latestSummary(targetHost.uuid)).toBe(before.summary);
  });

  test.describe('on the target host', () => {
    let mark: ChangeLogMark;
    let original: string | null = null;

    test.beforeAll(({ targetHost }) => {
      mark = markChangeLogs();
      original = storedQueue(targetHost.uuid);
    });

    test.afterAll(async ({ request, targetHost }) => {
      const api = AdminApi.asAdmin(request);
      if (storedQueue(targetHost.uuid) !== original) {
        const host = (await api.get<HostModel>(`/hosts/${targetHost.uuid}`)).body;
        expect((await api.put(`/hosts/${targetHost.uuid}`, hostInput(host, original))).status).toBe(200);
      }
      removeChangeLogsSince(mark, adminAccount()!.email);
    });

    test(
      'HMQ-04 a queue set on the host page is saved trimmed in HOST_MASTER and the change log, survives a reload, and clearing it stores NULL',
      { tag: '@write' },
      async ({ request, hostFormPage, shell, targetHost }) => {
        const api = AdminApi.asAdmin(request);
        const probe = original === PROBE ? 'qc-local-host-e2e-2.fifo' : PROBE;

        try {
          await hostFormPage.openDetail(targetHost.uuid);
          await hostFormPage.messageQueue.fill(`  ${probe}  `);
          await hostFormPage.save.click();
          await shell.expectStatus('Host saved.');
          expect(storedQueue(targetHost.uuid)).toBe(probe);
          expect((await api.get<HostModel>(`/hosts/${targetHost.uuid}`)).body.messageQueue).toBe(probe);
          const setSummary = latestSummary(targetHost.uuid);
          note('change log after set', setSummary);
          expect(setSummary).toBe(`Updated host details; message queue ${probe}`);

          await hostFormPage.openDetail(targetHost.uuid);
          await expect(hostFormPage.messageQueue).toHaveValue(probe);

          await hostFormPage.save.click();
          await shell.expectStatus('Host saved.');
          const unchangedSummary = latestSummary(targetHost.uuid);
          note('change log after an unchanged save', unchangedSummary);
          expect(unchangedSummary).toBe('Updated host details');

          await hostFormPage.messageQueue.fill('');
          await hostFormPage.save.click();
          await shell.expectStatus('Host saved.');
          expect(storedQueue(targetHost.uuid)).toBeNull();
          const clearSummary = latestSummary(targetHost.uuid);
          note('change log after clear', clearSummary);
          expect(clearSummary).toBe('Updated host details; cleared the message queue');

          await hostFormPage.openDetail(targetHost.uuid);
          await expect(hostFormPage.messageQueue).toHaveValue('');

          const host = (await api.get<HostModel>(`/hosts/${targetHost.uuid}`)).body;
          expect(host.messageQueue).toBeNull();
          expect((await api.put(`/hosts/${targetHost.uuid}`, hostInput(host, '   '))).status).toBe(200);
          expect(storedQueue(targetHost.uuid), 'a blank name is stored as NULL').toBeNull();
        } finally {
          if (storedQueue(targetHost.uuid) !== original) {
            const host = (await api.get<HostModel>(`/hosts/${targetHost.uuid}`)).body;
            await api.put(`/hosts/${targetHost.uuid}`, hostInput(host, original));
          }
        }
        expect(storedQueue(targetHost.uuid)).toBe(original);
      },
    );
  });

  test.describe('a created host', () => {
    let mark: ChangeLogMark;

    test.beforeAll(() => {
      mark = markChangeLogs();
    });

    test.afterAll(() => {
      runMasterSeedScript('master-qc921-hosts.remove.sql');
      removeChangeLogsSince(mark, adminAccount()!.email);
    });

    test(
      'HMQ-05 a created host keeps its queue, no other active host may use the same queue, and a deactivated host frees it',
      { tag: '@create' },
      async ({ page, request, hostFormPage, shell, targetHost }) => {
        const api = AdminApi.asAdmin(request);
        const stamp = Date.now().toString(36);
        const queue = `e2e-qc921-${stamp}.fifo`;
        const name = `E2E QC-921 ${stamp}`;
        const targetQueue = storedQueue(targetHost.uuid);

        await hostFormPage.openNew();
        await hostFormPage.fill({
          name,
          hostKey: `e2e-qc921-${stamp}`,
          clientId: `e2e-qc921.web${stamp}`,
          databaseName: 'QuarryConnect_Dev',
          organisationId: '99',
          uiUrl: 'http://localhost:4291',
          messageQueue: queue,
        });
        await hostFormPage.create.click();
        await shell.expectStatus(`Host '${name}' created.`);
        await expect(page).toHaveURL(/#\/hosts\/[0-9a-f-]{36}$/);
        const uuid = page.url().split('/').pop()!;

        expect(storedQueue(uuid)).toBe(queue);
        await expect(hostFormPage.messageQueue).toHaveValue(queue);
        const createSummary = latestSummary(uuid);
        note('change log after create', createSummary);
        expect(createSummary).toBe(`Created host ${name} (e2e-qc921-${stamp}) with sign-in client e2e-qc921.web${stamp} and message queue ${queue}`);

        const duplicate = {
          name: `${name} copy`,
          hostKey: `e2e-qc921-${stamp}-copy`,
          clientId: `e2e-qc921.copy${stamp}`,
          databaseName: 'QuarryConnect_Dev',
          uiUrl: 'http://localhost:4290',
          apiBaseUrl: '',
          hostOrganisationId: 99,
          messageQueue: queue,
        };
        const refused = await api.post('/hosts', duplicate);
        expect(refused.status).toBe(400);
        expect(refused.body.errors).toEqual({ messageQueue: [TAKEN_MESSAGE] });

        await hostFormPage.openDetail(targetHost.uuid);
        await hostFormPage.messageQueue.fill(queue);
        await hostFormPage.save.click();
        await expect(hostFormPage.formError).toContainText('Check the highlighted fields.');
        await expect(hostFormPage.error('messageQueue')).toHaveText(TAKEN_MESSAGE);
        expect(storedQueue(targetHost.uuid)).toBe(targetQueue);

        expect((await api.post(`/hosts/${uuid}/deactivate`)).status).toBe(200);
        const reused = await api.post<HostModel>('/hosts', duplicate);
        expect(reused.status, 'a deactivated host no longer holds its queue').toBe(201);
        expect(reused.body.messageQueue).toBe(queue);
        expect((await api.post(`/hosts/${reused.body.hostUuid}/deactivate`)).status).toBe(200);
      },
    );
  });
});
