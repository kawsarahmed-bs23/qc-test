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
| IDADMIN-01…15 | Identity administration API (QC-738; API only apart from the sign-in page checks; needs `ADMIN_API_CLIENT_ID` in `env/<env>.env` and `ADMIN_API_CLIENT_SECRET` in `env/<env>.secrets.env` for the service client seeded by `quarryconnect-identity/sql/seeds/001_bootstrap_identity.sql`; the `@write` cases need Identity's local database via `IDENTITY_SQL_DATABASE`) | No token or a foreign token gets `401`, and a signed-in driver's own token is refused; the service client can't be used at `/connect/authorize`, and a host client can't ask for the `quarryconnect.identity.admin` scope; the service token lists hosts but can't reach the Admin or service clients (`404`). `@write`, everything removed by `seed/identity-admin-api.remove.sql` before and after (the API has no delete): host `e2e-qc738` is created and renamed, and a bad or duplicate key is refused; a `Host` and a `MobileDriver` client are created and bad URIs, CORS origins and duplicate ids are refused; a client that exists only in the database opens the sign-in page at once with the branding just saved through the API; a driver not mapped to the new host is refused there; updating a client replaces its URIs and its id and type can't change; features switch on and off and unknown keys or unsafe branding are refused; deactivating a client stops sign-in through it (`unauthorized_client`); deactivating the host disables every client and takes no new ones. IDADMIN-13…14 use a throwaway driver from `seed/identity-deactivation-user.apply.sql` (it copies the test driver's password hash and is mapped as `Driver` to the mobile client's host; removed after), so the shared accounts are never deactivated: the host's users and the user's details show the mapping and no password data; deactivating the user deletes the stored grants, stops the refresh token and refuses the password grant. IDADMIN-15: the service secret is in no API response and not in Identity's log (`IDENTITY_LOG_DIR`). Each run spends 2 password-grant attempts |
| IDADMIN-16…20 | Identity administration API: host user mappings (QC-739 on the QC-738 API; local only, `@write`; seeds the throwaway user `seed/identity-qc739-member.apply.sql` and removes it and every `e2e-qc739*` host with `seed/identity-qc739.remove.sql` before and after) | Users are found by part of their email, `take` is capped at 50 and an over-long search is `400`, with no password data in the response; a mapping is created (`201`) and updated (`200`), and role `Admin`, a missing organisation, an unknown user or host are refused; a user mapped to two hosts is listed under both and removing one mapping leaves the other (a second remove is `404`); deactivating and reactivating the account keeps its mapping; a host that has had users can't be deleted (`409`), an unused host is deleted with its clients, and a deactivated host takes no new mappings |
| HM-01…05 | Admin: hosts (QC-739; runs against the QC-739 Admin, which calls Identity's administration API and the host API with client-credentials tokens) | The hosts list links each host by UUID and shows its Identity link; the host page shows the UUID and the Identity clients; Add host refuses a bad key, addresses without a scheme and an existing name before anything is written. HM-04 (`@write`, local): when Identity refuses the sign-in client, the Identity host just made is removed and HOST_MASTER is untouched. HM-05 (`@create`): a new host can be signed into at once and deactivating it stops sign-in; it leaves a deactivated `E2E QC-739 …` row in HOST_MASTER, and `seed/identity-qc739.remove.sql` clears its Identity rows |
| HF-01…05 | Admin: host features (QC-739) | Product features come from the host API with their requires/exclusive rules, MFA from Identity; the page locks Statewide dispatch while Dispatch is off and Sage while QuickBooks is on; a direct post that breaks either rule is refused and changes nothing. `@write`, restored: Maps saves through the host API, survives a reload and shows the Admin user as the changer; the MFA switch saves through Identity |
| HE-01…05 | Admin: host environment (QC-739) | Secrets are empty password inputs that only say Set / Not set; a value of the wrong type is refused on its own row and nothing is saved; `@write`, restored: one changed setting (`DispatchSnapshot:RateLimitPermitsPerHour`) is saved alone, the restart-required key is named, and an unchanged save sends nothing; restart needs the confirmation tick; HE-05 (`@restart`) requests a restart and reports it (a host API started with `dotnet run` has to be started again by hand) |
| HU-01…05 | Admin: host users (QC-739; local, `@write`; uses the throwaway user from `seed/identity-qc739-member.apply.sql`, removed after) | An existing user is found and added to the host with a role and then shows as already mapped; changing role and host-admin updates only that mapping; the user page lists the host, and the account is switched off and on without touching the mapping; removing the last mapping leaves the account active; the Users page links to a user by their Identity id |
| MIR-01…04 | Admin: HOST_MASTER copy of host features and environment (QC-737; local only, needs HOST_MASTER via `MASTER_SQL_DATABASE`) | Opening Features copies every product feature and MFA into `app.HostFeatures` and marks `Features` / `Mfa` synced in `app.HostSyncs`; opening Environment copies every setting into `app.HostEnvironmentSettings` with no value for any secret. `@write`, restored: saving Maps updates the copy with the Admin user as `UpdatedBy`; MIR-04 points the host's `ApiBaseUrl` in HOST_MASTER at an unreachable address (restored in `finally`), and both pages then show the saved copy read-only (no Save, secrets shown as "Secret, not stored") while `app.HostSyncs` records the failure and keeps the last good sync time |
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
