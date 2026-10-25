import { deflateSync } from 'zlib';
import type { APIRequestContext } from '@playwright/test';
import { env } from '../config/environment';
import type { BrandingImageType } from './HostManagementPages';

export const HOST_BRANDING_PUBLIC_PATH = 'api/host-branding/public/';

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface PublicImageAnswer {
  status: number;
  location: string | null;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function solidPng(name: string, width = 8, height = 8, rgb: [number, number, number] = [44, 114, 238]): UploadFile {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const buffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return { name, mimeType: 'image/png', buffer };
}

export function oversizedPng(name: string, bytes = 5 * 1024 * 1024 + 1): UploadFile {
  const png = solidPng(name);
  return { ...png, buffer: Buffer.concat([png.buffer, Buffer.alloc(bytes - png.buffer.length)]) };
}

export function publicImageUrl(apiBaseUrl: string, type: BrandingImageType): string {
  return `${apiBaseUrl.replace(/\/?$/, '/')}${HOST_BRANDING_PUBLIC_PATH}${type}`;
}

export class HostBrandingApi {
  constructor(private readonly request: APIRequestContext) {}

  private hostApi(path: string): string {
    if (!env.appApiUrl) {
      throw new Error('APP_API_URL is not set.');
    }
    return `${env.appApiUrl}/api/host-branding${path}`;
  }

  async publicImage(type: string): Promise<PublicImageAnswer> {
    const response = await this.request.get(this.hostApi(`/public/${type}`), { maxRedirects: 0, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    return { status: response.status(), location: response.headers()['location'] ?? null };
  }

  async anonymousHostStatuses(type: BrandingImageType): Promise<Record<string, number>> {
    const options = { maxRedirects: 0, ignoreHTTPSErrors: env.ignoreHttpsErrors };
    const file = solidPng('e2e-qc775.png');
    return {
      'GET api/host-branding': (await this.request.get(this.hostApi(''), options)).status(),
      'PUT api/host-branding/login-subtitle': (await this.request.put(this.hostApi('/login-subtitle'), { ...options, data: { loginSubtitle: 'E2E QC-775 anonymous' } })).status(),
      [`POST api/host-branding/${type}`]: (await this.request.post(this.hostApi(`/${type}`), { ...options, multipart: { file } })).status(),
      [`DELETE api/host-branding/${type}`]: (await this.request.delete(this.hostApi(`/${type}`), options)).status(),
    };
  }

  async adminStatuses(hostUuid: string, type: BrandingImageType, accessToken: string | null): Promise<Record<string, number>> {
    if (!env.adminApiUrl) {
      throw new Error('ADMIN_API_URL is not set.');
    }
    const base = `${env.adminApiUrl}/api/hosts/${hostUuid}/branding`;
    const options = {
      maxRedirects: 0,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      headers: (accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) as Record<string, string>,
    };
    const file = solidPng('e2e-qc775.png');
    return {
      'GET branding': (await this.request.get(base, options)).status(),
      'PUT branding': (await this.request.put(base, { ...options, data: { displayName: 'E2E QC-775 anonymous' } })).status(),
      [`POST branding/images/${type}`]: (await this.request.post(`${base}/images/${type}`, { ...options, multipart: { file } })).status(),
      [`DELETE branding/images/${type}`]: (await this.request.delete(`${base}/images/${type}`, options)).status(),
      'POST branding/copy-from-host': (await this.request.post(`${base}/copy-from-host`, options)).status(),
    };
  }

  async adminDeleteImage(hostUuid: string, type: BrandingImageType, accessToken: string): Promise<number> {
    const response = await this.request.delete(`${env.adminApiUrl}/api/hosts/${hostUuid}/branding/images/${type}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    return response.status();
  }
}
