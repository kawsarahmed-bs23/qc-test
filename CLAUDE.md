# CLAUDE.md — QuarryConnect E2E

Instructions for Claude Code (and other AI agents) working in this repository. The structure follows the
[awesome-testing](https://github.com/learnwithkawsar/awesome-testing) template, adapted to QuarryConnect's
multi-site, multi-environment setup. `README.md` has the environment variables and the test-case table.

## What this repo is

Playwright + TypeScript end-to-end tests for QuarryConnect Admin, its Identity sign-in and the host app, with:

- **Multi-environment config**: `TEST_ENV` (`local | dev | prod`, default `local`) selects `env/<env>.env` plus the git-ignored `env/<env>.secrets.env` and `env/<env>.app.secrets.env`. `config/env.config.ts` validates them with `zod` and fails fast with every problem listed.
- **Fixture-driven page objects**: page objects and API clients are injected into tests via `src/fixtures/pageFixtures.ts`.
- **Risk tags**: `@smoke`, `@write`, `@create`, `@restart` (see Tags).
- **Two browser projects**: `chromium` (Admin, `tests/*.spec.ts`, session from `setup`) and `app` (host app, `tests/app/*.spec.ts`, session from `app-setup`).

## Commands

| Task | Command |
| --- | --- |
| Run locally (default) | `npm run test:local` |
| One case / one file | `npm run test:local -- --grep "ENV-21"` / `npx playwright test tests/05-environment.spec.ts` |
| Admin or host app only | `npm run test:admin` / `npm run test:app` |
| Headed, one worker | `npm run test:local:headed` |
| Dev / prod (read-only) | `npm run test:dev` / `npm run test:prod` / `npm run test:prod:smoke` |
| List tests without running | `npm run test:list` |
| Interactive UI | `npm run test:ui` |
| Open latest report | `npm run report -- local` |
| Type check | `npm run typecheck` |
| Lint (no errors allowed) | `npm run lint` |
| Format / check format | `npm run format` / `npm run format:check` |
| All static checks | `npm run check` |

Run `npm run check` and the affected specs before declaring work done. Keep e2e runs short: the new cases plus the
cases that depend on what changed, never the full suite (~45 min) unless asked. Never pass `--reporter`; it replaces
the configured HTML/JUnit/JSON reporters.

## Architecture rules

1. **Do not instantiate page objects in specs.** Request them as fixtures: `async ({ hostEnvironmentPage, targetHost }) => {}`. ESLint warns on `new XPage(...)` in `tests/**`. Older specs still do it; when you touch one of those tests, move it to fixtures.
2. **Import `test`/`expect` from `@fixtures/pageFixtures`**, never `test` from `@playwright/test` in specs (ESLint error). Setup files (`*.setup.ts`) are the exception.
3. **Register every new page object or API client** in `src/fixtures/pageFixtures.ts`: add it to `TestFixtures` and to `base.extend`, named as the class in camelCase. Only classes built from `page` or `request` alone are fixtures; components that need more arguments are built inside a page object.
4. **New page objects extend `BasePage`** (`src/pages/base.page.ts`) and declare `protected readonly path`. UI page objects live in `src/pages/<area>.page.ts`; API clients in `src/api/<area>.api.ts`. Several related classes may share one file.
5. **Locators live in page objects, not specs.** Specs read like user stories; assertions that encode page knowledge become `assert*`/`expect*` methods on the page object.
6. **Locator priority:** `getByRole` → `getByLabel` → `getByPlaceholder` → `getByText` → `getByTestId` / element ids and `data-*` hooks the app exposes → other CSS (last resort, say why). No XPath.
7. **No hard waits** (`waitForTimeout`), no `{ force: true }`, no `networkidle`. Use web-first assertions (`await expect(locator).toBeVisible()`, `toHaveValue`, `toHaveAttribute`) instead of reading a value and comparing it.
8. **No secrets in code.** Read config through the `env` fixture or `import { env } from '@config/env.config'`. Never read `process.env` in tests or pages. Never print secret values.
9. **Paths:** import with the aliases `@config/*`, `@pages/*`, `@api/*`, `@fixtures/*`, `@setup/*`, `@utils/*`. Build file paths from `ROOT_DIR` / `TEST_DATA_DIR` (exported by `@config/env.config`), never from a module's `__dirname`.
10. **Tests restore what they change** (in `finally`) and use `targetHost.uuid` for host URLs, never a hard-coded UUID or host name.
11. **Test ids:** `<AREA>-NN <plain sentence of what must be true>`, continuing the numbering in that file. Add new ids to the README "Test cases" table.

## Tags

Put tags in the `tag` option: `test('ENV-21 ...', { tag: ['@write'] }, async ({ ... }) => { ... })`.

| Tag | The test | Runs on |
| --- | --- | --- |
| none or `@smoke` | only reads (`@smoke` = fast critical path) | local, dev, prod |
| `@write` | changes data and restores it | local; dev with `ALLOW_WRITES=true`; never prod |
| `@create` | adds rows that cannot be deleted (hosts) | opt-in `ALLOW_CREATE_HOSTS=true` |
| `@restart` | restarts the host API | opt-in `ALLOW_RESTART=true` |

`playwright.config.ts` drops blocked tags through `grepInvert`; prod is hard-wired read-only in `config/env.config.ts`.

## Adding a page object (workflow for agents)

1. **Read the app code** for the feature (Angular component, API controller) so tests target real behaviour.
2. **Inspect the running page** with Playwright MCP (`browser_navigate`, then `browser_snapshot`; prefer the snapshot over screenshots) and pick accessible locators.
3. **Create the page object** in `src/pages/<area>.page.ts`:

   ```ts
   import { expect, type Locator, type Page } from '@playwright/test';
   import { BasePage } from './base.page';

   export class OrdersGridPage extends BasePage {
     protected readonly path = '/dispatch/orders';
     readonly table: Locator;

     constructor(page: Page) {
       super(page);
       this.table = page.getByRole('table', { name: 'Orders' });
     }

     async assertIsVisible(): Promise<void> {
       await expect(this.table).toBeVisible();
     }
   }
   ```

4. **Register the fixture** in `src/fixtures/pageFixtures.ts`.
5. **Write the spec** in `tests/NN-<area>.spec.ts` (Admin) or `tests/app/NN-<area>.spec.ts` (host app), tagged, using only fixtures. Local-only data goes in `seed/<ticket>.apply.sql` / `.remove.sql`, run through `@utils/localDb`.
6. **Verify:** `npm run check`, then run the new cases. If a locator is flaky, re-snapshot and fix the page object; do not add waits or retries.

## File map

```
config/env.config.ts           zod-validated env loader: env, ADMIN_STATE, APP_STATE, ROOT_DIR, TEST_DATA_DIR
env/                           <env>.env (committed) + *.secrets.env (git-ignored)
src/pages/*.page.ts            UI page objects; base.page.ts is the base class for new ones
src/api/*.api.ts               API clients (Admin API, Identity, drivers, host API)
src/fixtures/pageFixtures.ts   test = base.extend<...>(): env, shell, targetHost, page objects, API clients
src/setup/                     globalSetup / globalTeardown
src/utils/                     localDb (sqlcmd seeds), throwawayUsers, totp, identityLog, logger, ...
seed/                          local-only SQL apply/remove scripts
test-data/                     files specs upload
tests/*.spec.ts                Admin specs (project chromium); auth.setup.ts signs in
tests/app/*.spec.ts            host-app specs (project app); app.setup.ts signs in
scripts/                       report opener, local SMTP sink
reports/<env>/<run>/           html, junit.xml, results.json, artifacts (git-ignored)
```
