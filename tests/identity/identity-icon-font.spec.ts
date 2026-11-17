// QC-983: Identity's password eye icon showed its ligature text ("visi") until the Material Symbols font arrived. The shared
// layout now asks Google Fonts for display=block, which keeps the text hidden until the font has loaded. Reads the public
// sign-in page only; no sign-in. Identity cases are owned by another developer and are NOT run by the QC-983 e2e workflow.
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';

test.describe('Identity icon font (QC-983)', { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);

  test('IDFONT-01 the Material Symbols stylesheet link of the Identity layout asks for display=block', async ({ request }) => {
    const response = await request.get(`${env.identityUrl}/Account/Login`, { ignoreHTTPSErrors: env.ignoreHttpsErrors });
    expect(response.status()).toBe(200);
    const html = await response.text();
    const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((match) => match[0]).filter((link) => /Material\+Symbols/i.test(link));
    expect(links, 'the layout links the Material Symbols stylesheet').not.toHaveLength(0);
    for (const link of links) {
      expect(link).toMatch(/[?&;]display=block/);
    }
  });
});
