import { randomUUID } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import { isDriversApiReachable } from '@api/password-grant.api';
import { env } from '@config/env.config';

const BEARER = { Authorization: 'Bearer e2e-retired-paths-not-a-real-token' };

test.describe('Drivers API: the old invite paths and /me/host are gone (QC-952)', { tag: ['@regression'] }, () => {
  test.beforeEach(async ({ request }) => {
    test.skip(!env.driversApiUrl, 'DRIVERS_API_URL is not set.');
    test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
  });

  test('RETIRED-01 GET /invites is no longer routed: 404 with or without a token', async ({ request }) => {
    expect((await request.get(`${env.driversApiUrl}/invites`)).status(), 'no token').toBe(404);
    expect((await request.get(`${env.driversApiUrl}/invites`, { headers: BEARER })).status(), 'a token').toBe(404);
  });

  test('RETIRED-02 POST /invites/accept is no longer routed: 404 with or without a token', async ({ request }) => {
    const data = { code: 'i-abc' };
    expect((await request.post(`${env.driversApiUrl}/invites/accept`, { data })).status(), 'no token').toBe(404);
    expect((await request.post(`${env.driversApiUrl}/invites/accept`, { data, headers: BEARER })).status(), 'a token').toBe(404);
  });

  test('RETIRED-03 POST /invites/{inviteUuid}/accept and /decline are no longer routed: 404 with or without a token', async ({ request }) => {
    const inviteUuid = randomUUID();
    for (const action of ['accept', 'decline']) {
      const url = `${env.driversApiUrl}/invites/${inviteUuid}/${action}`;
      expect((await request.post(url)).status(), `${action}, no token`).toBe(404);
      expect((await request.post(url, { headers: BEARER })).status(), `${action}, a token`).toBe(404);
    }
  });

  test('RETIRED-04 GET /me/host is no longer routed: 404 with or without a token or an X-Host-Uuid', async ({ request }) => {
    const url = `${env.driversApiUrl}/me/host`;
    expect((await request.get(url)).status(), 'no token').toBe(404);
    expect((await request.get(url, { headers: { ...BEARER, 'X-Host-Uuid': randomUUID() } })).status(), 'a token and a host').toBe(404);
  });

  test('RETIRED-05 the kept /me paths still exist and ask for a token: 401 without one', async ({ request }) => {
    for (const path of ['/me', '/me/hosts', '/me/settings']) {
      expect((await request.get(`${env.driversApiUrl}${path}`)).status(), path).toBe(401);
    }
  });
});
