<!-- PR title: "QC-###: Short summary". One ticket per PR. -->

## Ticket
Jira: QC-###

## What changed and why
<!-- The behaviour change in a few lines, and the reason for it. -->

## Related PRs
<!-- PRs in other quarryconnect-* repos this one needs, and the order they must merge in. Write "None" if there are none. -->
- 

## How I tested it
<!-- Author: what you ran and what you saw. Attach screenshots for UI changes. -->
- 

---

## Reviewer checklist
<!--
Reviewer: tick only what you actually checked.
If an item doesn't apply, leave it unticked and write "N/A" after it.
If you couldn't check something, leave it unticked and say why under Reviewer notes.
-->

### General
- [ ] Title and commits start with `QC-###:` and the PR covers that one ticket only
- [ ] Targets the right branch (`develop` for ticket work; `staging` / `master` only for releases)
- [ ] I read the whole diff: no unrelated refactoring, debug code, commented-out code or leftover files
- [ ] No secrets, passwords, keys, tokens, connection strings or personal data in the diff
- [ ] Related PRs in other repos are reviewed too, and the merge order is agreed
- [ ] Naming and placement match the surrounding code

### Run
- [ ] I ran the new or changed specs locally and they pass
- [ ] I ran the full suite, and any failures are pre-existing (listed under Reviewer notes)

### Specs
- [ ] Each test has a stable id in its title (e.g. `HOST-12`) and tests one behaviour
- [ ] Page interactions go through page objects in `pages/`, not raw selectors in specs
- [ ] Selectors use ids, `data-testid`s or roles, not CSS paths or text likely to change
- [ ] No fixed waits (`waitForTimeout`); waits are on a condition
- [ ] Tests don't depend on each other's order or data
- [ ] Any data a test changes is restored afterwards

### Hygiene
- [ ] No credentials in code; secrets stay in `env/*.secrets.env` (gitignored)
- [ ] `reports/`, `test-results/` and `.auth/` are not committed

### Sign-off
- [ ] Everything ticked above I checked myself; anything not ticked is explained below

## Reviewer notes
<!-- What you ran, what you couldn't check, follow-ups to raise as tickets. -->
