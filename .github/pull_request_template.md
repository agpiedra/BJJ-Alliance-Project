## What and why

<!-- What was broken or missing, and why this change fixes it. -->

## Closeout (see "Shipping a change" in README.md)

- [ ] **Base is `main` and this PR is not stacked on another branch.** If it depends on an unmerged PR, that PR merges first and this one starts after.
- [ ] **UI changes verified in a real browser as a genuinely registered user** (register -> approve -> accept -> sign in), not a seed user. Not a UI change: say so.
- [ ] **Marker to verify on `main` after the merge** — a file and a distinctive string that exists only once this has landed:

  - file: `<path>`
  - string: `<marker>`

  After merging: `git fetch origin && git show origin/main:<path> | grep -c "<marker>"` must be >= 1 **before any branch is deleted.**
- [ ] Verification debris cleared from the dev database (and storage), with what remains stated below.

## Verification

<!-- Tests run, browser checks, mutation checks. -->

## Not verified / not in this PR

<!-- Be explicit. -->
