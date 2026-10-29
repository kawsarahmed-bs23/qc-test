import type { APIRequestContext } from '@playwright/test';
import { env } from '../config/environment';

export const SQS_PROTOCOL_ATTRIBUTE = 'wolverine-protocol-version';

export interface MessagingProbe {
  probeUuid: string;
  failTimes: number;
  sentAt: string;
  answeredAt: string | null;
  attempts: number | null;
}

export interface ProbeAnswer {
  status: number;
  probe: MessagingProbe | null;
  text: string;
}

export interface SqsMessage {
  MessageId: string;
  Body: string;
  ReceiptHandle: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, { StringValue?: string; DataType: string }>;
}

export class MessagingProbeApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password } });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  async send(failTimes: number, rollback = false): Promise<ProbeAnswer> {
    const response = await this.request.post(`${hostApiUrl()}/api/messaging/probes`, {
      headers: this.headers(),
      data: { failTimes, rollback },
    });
    return answer(response.status(), await response.text());
  }

  async get(probeUuid: string): Promise<ProbeAnswer> {
    const response = await this.request.get(`${hostApiUrl()}/api/messaging/probes/${probeUuid}`, { headers: this.headers() });
    return answer(response.status(), await response.text());
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

export class LocalStackSqs {
  constructor(private readonly request: APIRequestContext) {}

  async isUp(): Promise<boolean> {
    if (!env.localStackUrl) return false;
    try {
      const response = await this.request.get(`${env.localStackUrl}/_localstack/health`, { timeout: 5_000 });
      return response.ok();
    } catch {
      return false;
    }
  }

  async queueUrl(queueName: string): Promise<string> {
    return (await this.call<{ QueueUrl: string }>('GetQueueUrl', { QueueName: queueName })).QueueUrl;
  }

  async depth(queueName: string): Promise<number> {
    const attributes = (await this.call<{ Attributes: Record<string, string> }>('GetQueueAttributes', {
      QueueUrl: await this.queueUrl(queueName),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    })).Attributes;
    return Number(attributes.ApproximateNumberOfMessages) + Number(attributes.ApproximateNumberOfMessagesNotVisible) + Number(attributes.ApproximateNumberOfMessagesDelayed);
  }

  async receive(queueName: string, visibilityTimeout: number): Promise<SqsMessage[]> {
    const result = await this.call<{ Messages?: SqsMessage[] }>('ReceiveMessage', {
      QueueUrl: await this.queueUrl(queueName),
      MaxNumberOfMessages: 10,
      VisibilityTimeout: visibilityTimeout,
      MessageAttributeNames: ['All'],
      AttributeNames: ['All'],
    });
    return result.Messages ?? [];
  }

  async remove(queueName: string, receiptHandle: string): Promise<void> {
    await this.call('DeleteMessage', { QueueUrl: await this.queueUrl(queueName), ReceiptHandle: receiptHandle });
  }

  async sendEnvelope(queueName: string, body: Buffer, groupId: string, deduplicationId: string): Promise<string> {
    const result = await this.call<{ MessageId: string }>('SendMessage', {
      QueueUrl: await this.queueUrl(queueName),
      MessageBody: body.toString('base64'),
      MessageGroupId: groupId,
      MessageDeduplicationId: deduplicationId,
      MessageAttributes: { [SQS_PROTOCOL_ATTRIBUTE]: { DataType: 'String', StringValue: '1.0' } },
    });
    return result.MessageId;
  }

  private async call<T>(target: string, body: Record<string, unknown>): Promise<T> {
    if (!env.localStackUrl) {
      throw new Error('LOCALSTACK_URL is not set.');
    }
    const response = await this.request.post(`${env.localStackUrl}/`, {
      headers: {
        'X-Amz-Target': `AmazonSQS.${target}`,
        'Content-Type': 'application/x-amz-json-1.0',
        Authorization: 'AWS4-HMAC-SHA256 Credential=test/20261029/us-east-1/sqs/aws4_request, SignedHeaders=host, Signature=x',
      },
      data: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(`SQS ${target} answered ${response.status()}: ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export function envelopeHeader(body: Buffer, name: string): string | null {
  const key = Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'latin1')]);
  const at = body.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length;
  const length = body[start];
  return body.subarray(start + 1, start + 1 + length).toString('utf8');
}

export function sqsEnvelope(message: SqsMessage): Buffer {
  return Buffer.from(message.Body, 'base64');
}

export function compactUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

function answer(status: number, text: string): ProbeAnswer {
  let probe: MessagingProbe | null = null;
  try {
    probe = status === 200 ? ((JSON.parse(text).data ?? null) as MessagingProbe | null) : null;
  } catch {
    probe = null;
  }
  return { status, probe, text };
}

function hostApiUrl(): string {
  if (!env.appApiUrl) {
    throw new Error('APP_API_URL is not set.');
  }
  return env.appApiUrl;
}
