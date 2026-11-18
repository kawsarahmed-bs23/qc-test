import * as fs from 'fs';
import * as path from 'path';
import { expect } from '@playwright/test';
import { env, ROOT_DIR } from '@config/env.config';
import { BasePage } from './base.page';

export const UI_FAVICON_FILE = path.join(ROOT_DIR, '..', 'quarryconnect-ui', 'public', 'favicon.ico');

export function uiFaviconBytes(): Buffer {
  return fs.readFileSync(UI_FAVICON_FILE);
}

export class HostFaviconPage extends BasePage {
  protected readonly path = '/#/this-page-does-not-exist';

  async iconDeclaredByTheApp(): Promise<Buffer> {
    const html = await (await this.page.request.get(`${env.appUrl}/`)).text();
    const href = /<link[^>]+rel="icon"[^>]*href="([^"]+)"/i.exec(html)?.[1] ?? /<link[^>]+href="([^"]+)"[^>]*rel="icon"/i.exec(html)?.[1];
    expect(href, "the app's index.html declares an icon").toBeTruthy();
    const response = await this.page.request.get(new URL(href!, `${env.appUrl}/`).toString());
    expect(response.ok(), `${href} is served`).toBe(true);
    return Buffer.from(await response.body());
  }

  async rootFaviconBytes(): Promise<Buffer> {
    const response = await this.page.request.get(`${env.appUrl}/favicon.ico`);
    expect(response.ok(), '/favicon.ico is served').toBe(true);
    return Buffer.from(await response.body());
  }
}
