import { randomUUID } from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/test';
import { canSeedLocalDb, canUseDriversDb, queryBinaryValues, queryDriversDb, querySingleValue } from '../fixtures/localDb';
import { compactUuid, envelopeHeader, LocalStackSqs, MessagingProbeApi, sqsEnvelope, type MessagingProbe, type SqsMessage } from '../pages/MessagingProbeApi';
import { env } from '../config/environment';

const SENT = 'message-probe-sent.V1';
const ANSWERED = 'message-probe-answered.V1';
const ANSWER_WINDOW = 30_000;
const RETRY_WINDOW = 45_000;
const DEAD_LETTER_WINDOW = 90_000;
const QUIET_WAIT = 5_000;
const POLL = { intervals: [500, 1_000, 2_000] };

interface Messaging {
  hostUuid: string;
  driversUuid: string;
  hostQueue: string;
  driversQueue: string;
  driversDeadLetterQueue: string;
}

function setting(name: string): string | null {
  return querySingleValue(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND SubGroupName IS NULL AND PropertyName = N'${name}'`);
}

function bodyHas(uuid: string): string {
  return `CAST(body AS varchar(max)) LIKE '%${uuid.toLowerCase()}%'`;
}

function hostCount(table: string, uuid: string, messageType?: string): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM wolverine.${table} WHERE ${bodyHas(uuid)}${messageType ? ` AND message_type = '${messageType}'` : ''}`));
}

function driversCount(table: string, uuid: string, messageType?: string): number {
  return Number(queryDriversDb(`SELECT COUNT(*) FROM wolverine.${table} WHERE ${bodyHas(uuid)}${messageType ? ` AND message_type = '${messageType}'` : ''}`));
}

function probeRows(uuid: string): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.MessagingProbes WHERE ProbeUUID = '${uuid}'`));
}

function handledProbeEnvelope(uuid: string): Buffer | null {
  return queryBinaryValues('drivers', 'body', `wolverine.wolverine_incoming_envelopes WHERE message_type = '${SENT}' AND status = 'Handled' AND ${bodyHas(uuid)}`)[0] ?? null;
}

function answerEnvelope(uuid: string): { where: string; body: Buffer } | null {
  const sent = queryBinaryValues('drivers', 'body', `wolverine.wolverine_outgoing_envelopes WHERE message_type = '${ANSWERED}' AND ${bodyHas(uuid)}`)[0];
  if (sent) return { where: 'Drivers wolverine_outgoing_envelopes (not yet delivered)', body: sent };
  const received = queryBinaryValues('host', 'body', `wolverine.wolverine_incoming_envelopes WHERE message_type = '${ANSWERED}' AND ${bodyHas(uuid)}`)[0];
  return received ? { where: 'host wolverine_incoming_envelopes', body: received } : null;
}

function answersProduced(uuid: string): number {
  return driversCount('wolverine_outgoing_envelopes', uuid, ANSWERED) + hostCount('wolverine_incoming_envelopes', uuid, ANSWERED);
}

function deadLetterQueueFor(queue: string): string {
  return queue.replace(/\.fifo$/, '-dlq.fifo');
}

test.describe('Host and Drivers API talk over SQS with outbox and inbox (QC-776)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb() || !canUseDriversDb(), 'Needs the host and DRIVERS local databases (local only).');
  test.skip(!env.localStackUrl, 'Needs LOCALSTACK_URL (local only); SQS messaging runs against LocalStack.');
  test.skip(!env.appAdmin, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD (a root SuperAdmin on the host API).');
  test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

  let request: APIRequestContext;
  let api: MessagingProbeApi;
  let sqs: LocalStackSqs;
  let messaging: Messaging;
  const probes: string[] = [];

  async function sendProbe(failTimes: number): Promise<MessagingProbe> {
    const sent = await api.send(failTimes);
    expect(sent.status, `POST probes: ${sent.text}`).toBe(200);
    probes.push(sent.probe!.probeUuid.toLowerCase());
    expect(sent.probe).toMatchObject({ failTimes, answeredAt: null, attempts: null });
    return sent.probe!;
  }

  async function probe(uuid: string): Promise<MessagingProbe | null> {
    return (await api.get(uuid)).probe;
  }

  test.beforeAll(async ({ playwright }) => {
    request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    sqs = new LocalStackSqs(request);
    test.skip(!(await sqs.isUp()), `LocalStack does not answer at ${env.localStackUrl}/_localstack/health.`);
    const hostQueue = setting('QueueName');
    test.skip(!hostQueue, 'The host EnvironmentSetting has no Messaging:QueueName row, so messaging is not on SQS here.');

    const driversQueue = (setting('DriversEndpoint') ?? '').replace(/^sqs:\/\//, '').replace(/\/$/, '');
    messaging = {
      hostUuid: setting('HostUuid')!.toLowerCase(),
      driversUuid: setting('DriversUuid')!.toLowerCase(),
      hostQueue: hostQueue!,
      driversQueue,
      driversDeadLetterQueue: deadLetterQueueFor(driversQueue),
    };
    expect(driversQueue, 'Messaging:DriversEndpoint is an sqs:// queue').toMatch(/\.fifo$/);

    api = new MessagingProbeApi(request);
    expect(await api.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the app admin signs in to the host API').toBe(200);
  });

  test.afterAll(async () => {
    for (const uuid of probes) {
      querySingleValue(`DELETE FROM app.MessagingProbes WHERE ProbeUUID = '${uuid}'`);
      queryDriversDb(`DELETE FROM wolverine.wolverine_outgoing_envelopes WHERE message_type = '${ANSWERED}' AND ${bodyHas(uuid)}`);
    }
    await request?.dispose();
  });

  test('MSG-01 a probe goes to the Drivers API and its answer comes back on the first attempt', async () => {
    const sent = await sendProbe(0);
    expect(probeRows(sent.probeUuid), 'the probe row is saved').toBe(1);

    await expect
      .poll(async () => (await probe(sent.probeUuid))?.answeredAt ?? null, { message: 'the host gets MessageProbeAnswered and sets answeredAt', timeout: ANSWER_WINDOW, ...POLL })
      .not.toBeNull();
    expect((await probe(sent.probeUuid))!.attempts).toBe(1);
  });

  test('MSG-02 a rolled-back probe is neither saved nor sent', async () => {
    const answer = await api.send(0, true);
    expect(answer.status, answer.text).toBe(400);
    const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(answer.text)?.[1]?.toLowerCase();
    expect(uuid, `the 400 names the probe: ${answer.text}`).toBeTruthy();
    probes.push(uuid!);
    expect(answer.text).toContain('rolled back');

    const nothingStored = () => ({
      row: probeRows(uuid!),
      hostOutgoing: hostCount('wolverine_outgoing_envelopes', uuid!),
      driversIncoming: driversCount('wolverine_incoming_envelopes', uuid!),
    });
    expect(nothingStored()).toEqual({ row: 0, hostOutgoing: 0, driversIncoming: 0 });
    await new Promise((resolve) => setTimeout(resolve, QUIET_WAIT));
    expect(nothingStored(), `still nothing for probe ${uuid} after ${QUIET_WAIT / 1000} s`).toEqual({ row: 0, hostOutgoing: 0, driversIncoming: 0 });
    expect((await api.get(uuid!)).status).toBe(404);
  });

  test('MSG-03 a handler that fails twice is retried and answers on the third attempt', async () => {
    test.setTimeout(RETRY_WINDOW + 30_000);
    const sent = await sendProbe(2);

    await expect
      .poll(async () => (await probe(sent.probeUuid))?.answeredAt ?? null, { message: 'answered after two failed attempts (cooldowns 1 s and 5 s)', timeout: RETRY_WINDOW, ...POLL })
      .not.toBeNull();
    expect((await probe(sent.probeUuid))!.attempts).toBe(3);
  });

  test('MSG-04 a probe that fails every attempt lands in the Drivers SQS dead-letter queue and is never answered', async () => {
    test.setTimeout(DEAD_LETTER_WINDOW + 60_000);
    const sent = await sendProbe(9);
    const uuid = sent.probeUuid.toLowerCase();
    let found: SqsMessage | null = null;
    let wolverineDeadLetters = 0;

    const deadline = Date.now() + DEAD_LETTER_WINDOW;
    while (!found && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      for (const message of await sqs.receive(messaging.driversDeadLetterQueue, 20)) {
        if (sqsEnvelope(message).includes(uuid)) found = message;
      }
      wolverineDeadLetters = driversCount('wolverine_dead_letters', uuid);
      if (wolverineDeadLetters > 0 && !found) break;
    }

    if (found) {
      await sqs.remove(messaging.driversDeadLetterQueue, found.ReceiptHandle);
      const body = sqsEnvelope(found);
      test.info().annotations.push({
        type: 'dead letter',
        description: `SQS ${messaging.driversDeadLetterQueue}: MessageGroupId=${found.Attributes?.MessageGroupId}, MessageDeduplicationId=${found.Attributes?.MessageDeduplicationId}, ` +
          `qc-sender=${envelopeHeader(body, 'qc-sender')}, qc-recipient=${envelopeHeader(body, 'qc-recipient')}, group-id=${envelopeHeader(body, 'group-id')}, ` +
          `SQS attributes=${Object.keys(found.MessageAttributes ?? {}).join(',')}; wolverine_dead_letters rows=${wolverineDeadLetters}`,
      });
    }

    expect(
      found,
      wolverineDeadLetters > 0
        ? `Probe ${uuid} is NOT in the SQS queue ${messaging.driversDeadLetterQueue}; it is in the Drivers database wolverine.wolverine_dead_letters (${wolverineDeadLetters} row).`
        : `Probe ${uuid} is in neither ${messaging.driversDeadLetterQueue} nor Drivers wolverine.wolverine_dead_letters after ${DEAD_LETTER_WINDOW / 1000} s.`,
    ).not.toBeNull();
    const body = sqsEnvelope(found!);
    expect(found!.Attributes?.MessageGroupId, 'the SQS group is the probe').toBe(compactUuid(uuid));
    expect(envelopeHeader(body, 'qc-sender')).toBe(messaging.hostUuid);
    expect(envelopeHeader(body, 'qc-recipient')).toBe(messaging.driversUuid);
    expect(wolverineDeadLetters, 'the database dead-letter table does not also hold it').toBe(0);
    expect((await probe(uuid))?.answeredAt ?? null, 'a dead-lettered probe is never answered').toBeNull();
    expect(answersProduced(uuid)).toBe(0);
  });

  test('MSG-05 the same envelope delivered twice to the Drivers API is handled once', async () => {
    test.setTimeout(ANSWER_WINDOW * 2 + 30_000);
    const sent = await sendProbe(0);
    const uuid = sent.probeUuid.toLowerCase();

    await expect.poll(() => handledProbeEnvelope(uuid) !== null, { message: 'the Drivers inbox handled the probe', timeout: ANSWER_WINDOW, ...POLL }).toBe(true);
    const envelope = handledProbeEnvelope(uuid)!;
    const envelopeId = envelopeHeader(envelope, 'id');
    expect(envelopeId, 'the stored envelope carries its id').toMatch(/^[0-9a-f-]{36}$/);

    let before: MessagingProbe | null = null;
    for (const until = Date.now() + ANSWER_WINDOW; Date.now() < until && !before?.answeredAt; ) {
      before = await probe(uuid);
      if (!before?.answeredAt) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    await sqs.sendEnvelope(messaging.driversQueue, envelope, compactUuid(uuid), `e2e-qc776-${randomUUID()}`);
    await expect.poll(() => sqs.depth(messaging.driversQueue), { message: 'the Drivers API took the duplicate off its queue', timeout: ANSWER_WINDOW, ...POLL }).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, QUIET_WAIT));

    expect(Number(queryDriversDb(`SELECT COUNT(*) FROM wolverine.wolverine_incoming_envelopes WHERE id = '${envelopeId}'`)), 'one inbox row for the envelope id').toBe(1);
    expect(driversCount('wolverine_incoming_envelopes', uuid, SENT), 'no second inbox row for the probe').toBe(1);
    expect(driversCount('wolverine_dead_letters', uuid), 'the duplicate was not dead-lettered').toBe(0);
    expect(answersProduced(uuid), 'the Drivers handler answered once').toBe(1);

    expect(before?.answeredAt ?? null, 'the probe was answered before the duplicate was delivered').not.toBeNull();
    expect(hostCount('wolverine_incoming_envelopes', uuid, ANSWERED), 'the host received exactly one MessageProbeAnswered').toBe(1);
    const after = await probe(uuid);
    expect({ attempts: after?.attempts, answeredAt: after?.answeredAt }).toEqual({ attempts: before!.attempts, answeredAt: before!.answeredAt });
  });

  test('MSG-06 both envelopes carry qc-sender, qc-recipient and the probe as SQS group', async () => {
    const sent = await sendProbe(0);
    const uuid = sent.probeUuid.toLowerCase();

    await expect.poll(() => handledProbeEnvelope(uuid) !== null, { message: 'the Drivers inbox stored MessageProbeSent', timeout: ANSWER_WINDOW, ...POLL }).toBe(true);
    const probeSent = handledProbeEnvelope(uuid)!;
    expect({
      sender: envelopeHeader(probeSent, 'qc-sender'),
      recipient: envelopeHeader(probeSent, 'qc-recipient'),
      group: envelopeHeader(probeSent, 'group-id'),
      deduplication: envelopeHeader(probeSent, 'deduplication-id'),
      occurredAt: !!envelopeHeader(probeSent, 'qc-occurred-at'),
    }, 'MessageProbeSent headers').toEqual({
      sender: messaging.hostUuid,
      recipient: messaging.driversUuid,
      group: compactUuid(uuid),
      deduplication: envelopeHeader(probeSent, 'id'),
      occurredAt: true,
    });

    await expect.poll(() => answerEnvelope(uuid) !== null, { message: 'the answer envelope is stored on either side', timeout: ANSWER_WINDOW, ...POLL }).toBe(true);
    const answer = answerEnvelope(uuid)!;
    expect({
      sender: envelopeHeader(answer.body, 'qc-sender'),
      recipient: envelopeHeader(answer.body, 'qc-recipient'),
      group: envelopeHeader(answer.body, 'group-id'),
      deduplication: envelopeHeader(answer.body, 'deduplication-id'),
      occurredAt: !!envelopeHeader(answer.body, 'qc-occurred-at'),
    }, `MessageProbeAnswered headers (read from ${answer.where})`).toEqual({
      sender: messaging.driversUuid,
      recipient: messaging.hostUuid,
      group: compactUuid(uuid),
      deduplication: envelopeHeader(answer.body, 'id'),
      occurredAt: true,
    });
  });
});
