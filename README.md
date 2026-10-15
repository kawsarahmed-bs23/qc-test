# QuarryConnect E2E

Browser tests for **QuarryConnect Admin** (`admin.*`) and its sign-in through **Identity** (`id.*`). They use a real Chromium browser. The project lives at the workspace root on purpose: it tests the deployed sites from the outside and belongs to no single app repo.

- Playwright + TypeScript, page objects in `pages/`, specs in `tests/`.
- One codebase, three environments: `local`, `dev`, `prod`.
- Every run writes a dated report to `reports/<env>/<timestamp>/`:
  - an HTML report;
  - JUnit and JSON results;
  - screenshots, videos and traces for failures.

## Setup

```powershell
cd quarryconnect-e2e
npm install
npm run install:browsers
```

Add the test accounts for an environment. Copy `env/example.secrets.env` to `env/<env>.secrets.env`; the file is git-ignored. You need:

| Variable | Needed | Notes |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | A dedicated Identity test user with the **Admin** role and **no two-step verification**. Never a real person's account. |
| `DRIVER_EMAIL` / `DRIVER_PASSWORD` | optional | Any non-admin user. Without it the permission-denied test is skipped. |

In CI, set the same names as pipeline secrets instead of files.

## Run

```powershell
npm run test:local      # against https://localhost:7090 / :7050
npm run test:dev
npm run test:prod
npm run test:smoke      # only @smoke, uses TEST_ENV (default local)
npm run test:headed     # watch the browser
npm run report -- local # open the latest HTML report for an environment
```

Extra Playwright arguments pass through:

```powershell
npx cross-env TEST_ENV=dev ALLOW_WRITES=true playwright test tests/04-features.spec.ts
```

## Environments and safety

`env/<env>.env` holds the URLs, the host under test (`HOST_NAME`, as shown in the Admin host list) and the safety switches. Each test is tagged by what it is allowed to do.

| Tag | What it does | local | dev | prod |
| --- | --- | --- | --- | --- |
| *(none)*, `@smoke` | Reads only | ✅ | ✅ | ✅ |
| `@write` | Changes a value through the UI, verifies it, then **restores the original** in a `finally` block | ✅ | opt-in `ALLOW_WRITES=true` | **never** |
| `@create` | Adds a host to HOST_MASTER (there is no delete, so rows stay) | opt-in `ALLOW_CREATE_HOSTS=true` | opt-in | **never** |
| `@restart` | Restarts the host API from the Environment page | opt-in `ALLOW_RESTART=true` | opt-in | **never** |

Production is hard-wired read-only in `config/environment.ts`, so no flag can turn writes on there. Write tests only ever touch a short allow-list of harmless settings:
- the Maps feature;
- the number prefix;
- the primary colour;
- `DispatchSnapshot:RateLimitPermitsPerHour` and a few driver-location intervals.

They never touch keys such as `HostOrganisationId`, JWT or CORS. Tests run one at a time (one worker) because they share one host.

## Test cases

| ID | Area | Checks |
| --- | --- | --- |
| AUTH-01…08 | Sign-in | Signed-out redirect to Identity; every page protected; admin sign-in; non-admin gets Permission denied, also on deep links; sign-out ends the session; old Identity `/Admin` panel returns 404; Identity `/` sends an admin to the Admin site |
| DASH-01…07 | Dashboard | KPI cards; host card (meter, chips, quick links); sidebar is Dashboard, All Hosts, Activity; host list → overview with four tabs; activity page; unknown host UUID → 404; old `/branding` URL redirects to Host settings |
| HOST-01…05 | Hosts | Every area compared with live and reachable; UUID-only URLs; duplicate name/client id rejected; field validation; `@create` missing-database host shows Failed + Retry |
| FEAT-00…04 | Features | No summary cards; QuickBooks vs SAGE and Statewide-needs-Dispatch warnings block Save; server rejects a bypassed conflict; toggle → pushed to live → persists → overview in sync → restored |
| ENV-01…05 | Environment | No summary cards; groups; sensitive values locked; filter; invalid number rejected; restart-required save opens the 10 s countdown, "Not now" stops it and leaves a reminder; `@restart` restart and wait until the host API is back |
| SET-01…08 | Host settings | Company, Address, Email, S3, OCR, QuickBooks, chart of accounts, Images and branding sections; secrets write-only; Save disabled until a change; invalid zip rejected by the host API; save → HOST_MASTER refreshed → restored (skipped without a billing address); every logo has preview and upload; upload + delete in an empty slot; overview Refresh pulls host settings |
| BRAND-00…03 | Sign-in branding (in Host settings) | Lives in Host settings, logo from uploaded images; live preview; invalid colour rejected; save → pushed to Identity → persists → restored |
| PWD-01…14 | Mobile password grant (QC-706; since QC-725 the test driver needs a `Driver` row in `app.UserHosts` for the mobile client's host) and refresh-token revocation (QC-708; API only, no browser; needs `MOBILE_CLIENT_ID` and, for PWD-02, `DRIVERS_API_URL` with the drivers API running; PWD-06…08 are `@write` and change then restore the test driver in Identity's local database via `IDENTITY_SQL_DATABASE`) | A driver's email + password returns a 15-minute `at+jwt` drivers API token (role `Driver`, `amr` `pwd`) and a refresh token; the drivers API `/me` accepts it; a refresh rotates the pair and the old refresh token is refused; unknown email and non-driver are refused; deactivated is refused; two-step verification gives `mfa_required`; a wrong password counts towards lockout and a locked driver is refused. PWD-10…13 (QC-708): a security-stamp change (what a password change does) stops the refresh token and deletes the driver's stored grants; a deactivated driver can't refresh and the grants are deleted; a refresh token the app revokes is refused; signing out on the Identity web pages leaves the mobile refresh token working. PWD-14: a real password reset through the Identity forgot/reset pages stops the refresh token, deletes the grants and refuses the old password; it reads the reset link from Identity's log (`IDENTITY_LOG_DIR`, Development with no mail server) and restores the original password hash and stamp by SQL in `finally`. PWD-10, PWD-11 and PWD-14 are `@write` and restore what they change. PWD-09 (per-IP throttle) is skipped: tripping it blocks password grants from the machine for 15 minutes. Each run spends 13 of the 20 attempts per IP per 15 minutes; restart Identity to reset the count |
| RESET-01…05 | Forgot password (QC-709; local only; reads reset links from Identity's log via `IDENTITY_LOG_DIR`, Development with no mail server) | An unknown email gets the normal confirmation and nothing is sent; a 4th request for one address within 15 minutes is throttled but the page looks the same; a deactivated driver gets the normal confirmation and nothing is sent (`@write`); a reset signs the driver out of another browser (`app.UserSessions.EndReason = password-reset`) and the used link and an altered link are refused (`@write`, password hash and stamp restored by SQL in `finally`). RESET-05 (link older than 2 hours) is skipped: the token time can't be set from outside. Reset requests are throttled per IP (20/hour) and per address (3 per 15 minutes); each run uses 8 of the IP's 20 and 2 of the driver address's 3 (with PWD-14), so restart Identity before back-to-back runs |
| HOSTMAP-01…09 | Host and user mapping (QC-725; local only; needs `HOST_CLIENT_ID` / `SECOND_HOST_CLIENT_ID` with their redirect URIs for two host clients on different Identity hosts, and Identity's local database via `IDENTITY_SQL_DATABASE`; the browser cases catch the client callback, so nothing has to listen on the redirect URIs) | A mapped driver's host access token carries `OrganisationId` and `role` from `app.UserHosts`; a driver with no mapping at a host sees "doesn't have access to this site" on its sign-in page; a session from one host is not reused at a host the driver isn't mapped to; each host client's sign-in page shows its own host's branding; the schema has no `AspNet` names and the unused tables are gone. `@write`, mapping restored in `finally`: a driver mapped to two hosts gets each host's organisation and role (reaches two-step enrolment instead when the second host has the `mfa` feature on); `IsHostAdmin` on a mapping forces two-step enrolment at that host and `mfa_required` on the password grant; the password grant needs the `Driver` role at the client's host; deactivating the mapping stops the mobile refresh token and sign-in at that host. The browser cases leave signed-in `host.local` sessions, so a later password reset (PWD-14, RESET-04) sends a back-channel logout per session to the host API; run the host API (`https://localhost:7026`) or each call waits about 4 s |
| TZ-01…04 | Host app: app time zone (QC-654; `tests/app/`, local only, browser forced to `Asia/Dhaka`, expected times from `APP_TIME_ZONE` in `env/<env>.env`, seeds `seed/app-time-zone.apply.sql` + the Plan vs Live seed and removes both after) | Communications prints the API's app-zone time for a message, not the browser's; Plan vs Live prints the API's app-zone "captured" time; every date-time the API sends for those screens (messages, drivers list, queue, Ticket Activity, Plan vs Live, Dispatch Home) is `MM/dd/yyyy hh:mmtt`; Ticket Activity prints the last-ticket and haul times exactly as the API sends them (no "Invalid date") |
| PVL-01…04 | Host app: Schedule — Plan vs Live (`tests/app/`, local only, seeds `seed/plan-vs-live.apply.sql` and removes it after) | A time-shifted assignment draws its plan bar behind its live bar; an unchanged one draws no plan bar; hovering the plan bar shows only the plan text (QC-658); hovering the live bar brings its text back in front |
| SEEN-01…06 | Host app: Communications — read receipts (QC-685; `tests/app/`, local only, seeds `seed/comms-seen-by.apply.sql` with two seen inbound and a read and an unread outbound message, and removes them after) | Every read receipt is a double-tick icon with no text; on a driver message it is green and hovering shows "Seen by {dispatcher} · {time}"; on a message the driver read it is green with "Seen by driver · {time}"; unread or SMS-only is gray with "Not seen yet" / "No read receipt (SMS)" on hover; the tick sits bottom-right clear of the time with tags left; the footer has a 6px gap and 10px clear space under the text |

Logo tests write to the host's S3 bucket. The local host shares bucket `quarryconnect-dev` and organisation 30 with dev, so SET-07 only uses an empty logo slot and deletes it again.

## Reports

```
reports/
  local/
    2026-10-04_12-55-01/
      html/index.html      ← open with: npm run report -- local
      junit.xml            ← for CI test tabs
      results.json
      artifacts/           ← per-test screenshots, videos, traces (failures only)
```

The HTML report's header shows the environment, URLs, host and which tags were blocked. Open a failed test's trace with `npx playwright show-trace <trace.zip>`.

## Adding tests

In Claude Code, run `/e2e-test <feature or ids>` from the workspace root. The project skill in `.claude/skills/e2e-test` writes the cases in this project's style, runs them and reports. Or follow the rules below by hand.

- Put selectors in `pages/`. Prefer the element ids the Admin site exposes (`#features-save`, `#tab-environment`, `data-*` hooks) over CSS that might change.
- Use the `targetHost` fixture (`fixtures/test.ts`) for the host's UUID. It is looked up by `HOST_NAME`, never hard-coded.
- Anything that changes data gets the `@write` tag and restores the original value in `finally`.
