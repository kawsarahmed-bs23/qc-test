import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';
import { ADMIN_STATE, APP_STATE, env } from './config/environment';

process.env.RUN_ID ??= new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

const runDir = path.join('reports', env.name, process.env.RUN_ID);

const blockedTags: string[] = [];
if (!env.allowWrites) blockedTags.push('@write');
if (!env.allowCreateHosts) blockedTags.push('@create');
if (!env.allowRestart) blockedTags.push('@restart');

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(runDir, 'artifacts'),
  fullyParallel: false,
  workers: 1,
  retries: env.name === 'local' ? 0 : 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  grepInvert: blockedTags.length ? new RegExp(blockedTags.join('|')) : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(runDir, 'html'), open: 'never' }],
    ['junit', { outputFile: path.join(runDir, 'junit.xml') }],
    ['json', { outputFile: path.join(runDir, 'results.json') }],
  ],
  metadata: {
    environment: env.name,
    adminUrl: env.adminUrl,
    identityUrl: env.identityUrl,
    host: env.hostName,
    blockedTags: blockedTags.join(', ') || 'none',
  },
  use: {
    baseURL: env.adminUrl,
    ignoreHTTPSErrors: env.ignoreHttpsErrors,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/auth\.setup\.ts/, /[\\/]app[\\/]/],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: ADMIN_STATE },
    },
    {
      name: 'app-setup',
      testMatch: /app[\\/]app\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: env.appUrl ?? undefined },
    },
    {
      name: 'app',
      dependencies: ['app-setup'],
      testMatch: /app[\\/].*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        baseURL: env.appUrl ?? undefined,
        storageState: APP_STATE,
      },
    },
  ],
});
