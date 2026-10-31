# why-diff usage gaps: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make why-diff behave correctly in the places teams actually use it (CI, pull requests, worktrees, rebased branches, the Stop hook), and give reviewers and teams a supported path: a GitHub Action, a `why-diff pr` command and a small team config.

**Architecture:** Fixes stay inside the existing pipeline (`git.ts` diff/target/window, `adapters/claude.ts` discovery, `labels.ts` rules, `report/*` renderers, `cli.ts`). The guard moves from `cli.ts` into `src/guard.ts` so it can be unit-tested. A composite GitHub Action (`action.yml`) runs the committed standalone bundle `plugin/bin/why-diff.mjs`.

**Tech Stack:** TypeScript (Node 20+, ESM), commander, vitest, esbuild bundle (`scripts/build.mjs`).

**Spec:** the audit at `/private/tmp/claude-501/whydiff-audit/` (repro scripts `t-*.sh`, transcript generator `mk.mjs`, runner `wd`) and the findings list copied into the "Findings" section below.

## Global Constraints

- Node >= 20, ESM, zero runtime dependencies (everything bundled by `scripts/build.mjs`).
- Every behaviour change starts with a failing vitest test (superpowers:test-driven-development). Never touch the real `~/.claude`: tests use temp dirs and the `home` option / a fake `HOME`.
- Tests that need git build throwaway repos under `os.tmpdir()`; transcripts are written with `test/helpers/claude-fixture.ts`.
- After any `src/` change: `npm run typecheck && npm test && npm run build` (the build regenerates `plugin/bin/why-diff.mjs`, which must be committed).
- The guard must never break the user's session: any internal error means exit 0.
- Report text is English; no em dashes in new user-facing strings.
- Commit after each task with a conventional message; no attribution lines.

## Findings (from the audit)

H1 guard blames the agent for human edits (file-only hunks count). H2 guard misses committed agent edits. H3 CI/non-main repos: wrong base, empty "100% traced", shallow clone raw error, `GITHUB_BASE_REF` ignored. H4 `.why-diff/report.html` shows up as untracked in the next run. H5 prompts/rationales leak secrets into md/json/html. H6 sibling `git worktree` sessions never found. H7 rebase/squash drops older sessions (window starts at base tip time). M8 disabling tests (config excludes, `|| true`, `--passWithNoTests`, pytest `-k not`/`--deselect`, renaming a test file away) not flagged. M9 `--fail-on` unvalidated; `unrequested` without classifier never fails; `unattributed` fails every CI run with no transcripts. M10 `--classify HEAD~1` swallows the range. M11 `out-of-scope` floods multi-module work. M12 guard reads huge untracked files whole. M13 guard re-blocks every turn; without `transcript_path` falls back to all sessions. M14 no way to carry provenance with a branch, no Action. Low: binary changes invisible; `--since yesterday` accepted silently; no pathspec; repo name from origin URL; JSON has no schema version and has absolute paths; README says "builds".

## Review Focus

- A CI checkout (`actions/checkout` default: depth 1, detached HEAD, `GITHUB_BASE_REF=main`) must produce a real risk scan or a clear "fetch-depth: 0" error, never "100% traced" on 0 lines. Pinned in Task 1.
- A human's uncommitted risky edit in a file the agent also touched must not block the agent. Pinned in Task 3.
- The guard must exit 0 within the hook timeout when an untracked 100 MB file exists. Pinned in Task 3.
- A prompt containing `sk-ant-...` or `password=...` must not appear in any output format. Pinned in Task 4.
- A PR from a teammate without transcripts must not fail `--fail-on risk` because of the `unattributed` label. Pinned in Task 8.

---

### Task 1: Base and window resolution (H3, H4, H7)

**Files:**
- Modify: `src/git.ts` (`resolveDefaultTarget`, `commitTimes`, `listUntracked`, new `isShallow`)
- Modify: `src/pipeline.ts` (`BuildOptions.base`, shallow error), `src/cli.ts` (`--base <ref>`), `src/report/shared.ts` (`headline`)
- Test: `test/git.test.ts`, `test/report.test.ts`

**Interfaces:**
- Produces: `BuildOptions.base?: string`; CLI `--base <ref>`; `isShallow(cwd): Promise<boolean>`; `resolveDefaultTarget(cwd, env = process.env)`.

- [ ] Step 1: failing tests in `test/git.test.ts`:
  - `resolveDefaultTarget uses GITHUB_BASE_REF`: repo with `main` and branch `feat` checked out detached at feat's tip, env `{ GITHUB_BASE_REF: 'main' }` gives `base` = `main` or `origin/main` and label `main...HEAD + working tree`.
  - `resolveDefaultTarget finds develop and trunk`: repo whose only other branch is `develop` (then `trunk`) gives that base.
  - `resolveDefaultTarget prefers origin's default branch`: `refs/remotes/origin/HEAD` pointing at `origin/develop` is used.
  - `commitTimes uses the earliest author date in the range`: commit A authored 2 days ago on a branch, rebased onto a base commit made now (`GIT_COMMITTER_DATE` now, `GIT_AUTHOR_DATE` 2 days ago); `since` <= A's author date.
  - `listUntracked ignores .why-diff/`: untracked `.why-diff/report.html` and `x.js` give `['x.js']`.
- [ ] Step 2: run `npx vitest run test/git.test.ts`, expect the new tests to FAIL.
- [ ] Step 3: implement. Base candidates in order: explicit `base` arg, `GITHUB_BASE_REF`, `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `BITBUCKET_PR_DESTINATION_BRANCH` (each tried as `origin/<x>` then `<x>`), the target of `refs/remotes/origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`, `origin/develop`, `develop`, `origin/trunk`, `trunk`. `commitTimes`: `since` = min(base time, earliest `%aI` from `git log --format=%aI <countRange>`). `listUntracked`: drop paths starting with `.why-diff/`; when the CLI writes into `.why-diff/`, also write `.why-diff/.gitignore` containing `*`.
- [ ] Step 4: failing test in `test/git.test.ts` `shallow clone gives a fetch-depth hint`: `git clone --depth 1 file://<repo>` then `buildReport({ cwd, range: 'origin/main...HEAD' })` rejects with a message containing `fetch-depth: 0`; and with no range and no resolvable base in a shallow clone, `buildReport` rejects with the same hint instead of returning an empty report.
- [ ] Step 5: implement `isShallow` (`git rev-parse --is-shallow-repository`) and wrap `GitError`s from `getDiff`/`mergeBase` in shallow repos with: `this is a shallow clone; fetch full history (actions/checkout: fetch-depth: 0) or pass --base`.
- [ ] Step 6: failing test in `test/report.test.ts` `headline does not claim 100% with no added lines`: a report with `addedLines: 0` renders `no added lines` in terminal and md, not `100%`. Then implement in `headline()`.
- [ ] Step 7: `npm run typecheck && npm test && npm run build`; commit `fix: resolve CI/PR base branches, full rebase window, shallow-clone hint, ignore .why-diff`.

### Task 2: Worktree discovery (H6)

**Files:**
- Modify: `src/git.ts` (new `worktreeRoots(cwd): Promise<string[]>`), `src/adapters/claude.ts` and `src/adapters/codex.ts` discover (accept extra roots), `src/pipeline.ts` (pass roots; attribution remap already exists in `attribute.ts` `repoRelativePath`)
- Test: `test/claude-adapter.test.ts`, `test/git.test.ts`

**Interfaces:**
- Produces: `DiscoverOptions.extraRoots?: string[]`; `worktreeRoots(cwd)` returns absolute paths of all worktrees from `git worktree list --porcelain` except the current root.

- [ ] Step 1: failing test: repo R, `git worktree add ../R-wt -b wt`, a fixture transcript with cwd `../R-wt` editing `R-wt/src/a.js`; after merging `wt` into R's branch, `buildReport({ cwd: R, home })` attributes the hunk (`match: 'exact'`). Also: a worktree removed after the session (path no longer listed) is still found when its transcript cwd is a sibling named `<repo>-*` or under `<repo>/.claude/worktrees/`? Only the listed-worktree case is required; document the removed-worktree case in README Limitations.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement: pipeline calls `worktreeRoots`, adapters treat each extra root like the repo root for cwd matching, and attribution maps file paths under an extra root to the same repo-relative path.
- [ ] Step 4: tests green, build, commit `feat: discover sessions from sibling git worktrees`.

### Task 3: Guard correctness and cost (H1, H2, M12, M13)

**Files:**
- Create: `src/guard.ts` exporting `runGuard(payload: GuardPayload, opts: GuardOptions): Promise<GuardResult>`
- Modify: `src/cli.ts` (guard subcommand becomes a thin wrapper), `src/git.ts` (`getDiff` accepts `paths?: string[]` pathspec for both tracked and untracked; untracked files larger than 2 MB are skipped), `src/pipeline.ts` (`BuildOptions.paths`, `BuildOptions.baseRev`)
- Test: `test/guard.test.ts`

**Interfaces:**
- Produces: `interface GuardPayload { transcript_path?: string; cwd?: string; stop_hook_active?: boolean; session_id?: string }`, `interface GuardOptions { blocking: Set<LabelKind>; home?: string; stateDir?: string }`, `interface GuardResult { block: boolean; message?: string; hits: string[] }`. `BuildOptions.paths?: string[]`, `BuildOptions.baseRev?: string`.

- [ ] Step 1: failing tests in `test/guard.test.ts` (temp repo + fixture transcript):
  - `does not block on a human's uncommitted it.skip in a file the agent also edited` (audit `t-guard.sh`): `block === false`.
  - `blocks when the agent's own edit adds it.skip`: `block === true`, message names the file and `test-skip-added`.
  - `blocks on an agent edit that was committed during the session`: agent edit adds `it.skip`, then a commit after session start; `block === true`.
  - `does not block twice for the same hits`: second call with the same state dir returns `block === false`; a new risky edit afterwards blocks again.
  - `exits quietly without transcript_path`: `block === false`.
  - `skips huge untracked files`: an untracked 50 MB file outside the transcript's paths; run completes in under 3 s and `block === false`.
- [ ] Step 2: run `npx vitest run test/guard.test.ts`, expect FAIL (module missing, then behaviour).
- [ ] Step 3: implement `runGuard`: no `transcript_path` gives no block; parse only that transcript; paths = files the transcript's non-failed edits touched (repo-relative); base = last commit at or before the session's `startedAt` (`git rev-list -1 --before=<startedAt> HEAD`, fallback HEAD); build the report with `{ workingTree: true, baseRev, paths, sessionFiles: [transcript_path] }`; a hit is a label in `blocking` on a hunk whose `match` is `exact` or `partial` and whose `editIds` all belong to that session; state file `<repo>/.why-diff/guard-state.json` keyed by session id stores a hash of the sorted hit strings, and an unchanged hash does not block. All errors: `block: false`.
- [ ] Step 4: tests green; wire CLI (`exit 2` + stderr message when `block`); build; commit `fix(guard): only the session's own exact edits, include its commits, no repeat blocks, bounded cost`.

### Task 4: Redact secrets in prompts and rationales (H5)

**Files:**
- Create: `src/redact.ts` exporting `redactSecrets(text: string): string` (reuse the secret patterns already used by the `secret-like` label in `src/labels.ts`; move them into `redact.ts` and import them from `labels.ts`), `redactReport(report: Report, mode: 'secrets' | 'prompts'): Report`
- Modify: `src/pipeline.ts` (always apply `'secrets'`), `src/cli.ts` (`--redact-prompts` applies `'prompts'`: prompt text becomes `[prompt N redacted]`, rationales dropped)
- Test: `test/redact.test.ts`

- [ ] Step 1: failing tests: `redactSecrets('use key sk-ant-api03-abcdef... now')` masks the key (`sk-ant-…` kept as prefix, rest replaced by `•`), `password=hunter2xyz` and `DATABASE_URL=postgres://u:p@h/db` masked; an email address is masked; ordinary text unchanged. `renderReport(redactReport(r,'secrets'),'md')` for a report whose prompt contains `sk-ant-api03-XXXX` does not contain `XXXX`, same for `json` and `html`. With `'prompts'`, no prompt text appears at all.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: green, build, commit `fix: mask secrets in prompts and rationales; add --redact-prompts`.

### Task 5: Test-disabling detection (M8)

**Files:**
- Modify: `src/types.ts` (new `LabelKind` `'tests-disabled'`, severity `risk`, not in `FILE_LEVEL_LABELS`), `src/labels.ts`, `src/diff-parse.ts` (emit a zero-line hunk for pure renames and for deletions of files), `src/summary.ts` (`touchedTests` includes `tests-disabled`), guard default blocking list in `src/cli.ts`/`src/guard.ts` adds `tests-disabled`
- Test: `test/labels.test.ts`, `test/diff-parse.test.ts`

- [ ] Step 1: failing tests (each asserts a `tests-disabled` label on the hunk):
  - vitest/jest config adds an `exclude`/`testPathIgnorePatterns`/`modulePathIgnorePatterns` entry;
  - `package.json` `"test"` script gains `--passWithNoTests`, `|| true`, `|| exit 0`;
  - `pytest.ini`/`pyproject.toml`/`setup.cfg` `addopts` gains `-k "not ...`, `--deselect`, `--ignore`;
  - CI workflow step gains `continue-on-error: true` on a test step, or `|| true` after a test command;
  - a pure rename `test/a.test.js` to `test/a.test.js.disabled` produces one hunk with `tests-disabled`;
  - deleting a test file produces a hunk labelled `tests-disabled` (in addition to `test-modified`).
  - negative: adding an `exclude` for `node_modules` or `dist` is not flagged.
- [ ] Step 2: run, FAIL. Step 3: implement. Step 4: green, build, commit `feat: flag disabled tests (config excludes, swallowed failures, renamed or deleted test files)`.

### Task 6: out-of-scope precision (M11)

**Files:** Modify `src/labels.ts` (`outOfScopeReason`, `ScopeIndex`). Test `test/labels.test.ts`.

- [ ] Step 1: failing tests: (a) 20 prompts each saying "build module mN" with the agent writing `src/mN/index.ts`, `src/mN/util.ts`, `src/mN/types.ts`: zero `out-of-scope` labels; (b) a prompt about `src/cart.js` and an agent edit to `infra/terraform/main.tf`: still `out-of-scope`.
- [ ] Step 2: FAIL. Step 3: implement: a file is in scope when it was created by the agent in the same prompt, or shares a directory with a file the same prompt mentions or created, or its directory/basename stem is mentioned in any prompt. Step 4: green, build, commit `fix: out-of-scope only for files unrelated to anything the prompt touched`.

### Task 7: CLI hardening and small output fixes (M9, M10, Low)

**Files:** Modify `src/cli.ts`, `src/git.ts` (pathspec), `src/pipeline.ts`, `src/report/json.ts`, `src/report/*` (binary files), `src/diff-parse.ts` (binary hunk). Test: `test/cli.test.ts` (runs `src/cli.ts` via `node --import tsx` or the built bundle in temp repos), `test/report.test.ts`, `test/diff-parse.test.ts`.

**Interfaces:** Produces `Report.schemaVersion: 1`; `BuildOptions.paths` (shared with Task 3).

- [ ] Step 1: failing tests:
  - `--fail-on risks` exits 2 with `unknown --fail-on value "risks" (use risk, unrequested, tests, unattributed)`;
  - `--fail-on unrequested` without `--classify` exits 2 with `--fail-on unrequested needs --classify`;
  - `why-diff --classify HEAD~1` treats `HEAD~1` as the range and classifies with `auto` (assert range label `HEAD~1` in json output with `--classify` backend stubbed via env `WHY_DIFF_CLASSIFIER=none-test` or by asserting the range only);
  - `--since yesterday` exits 2 with `invalid --since date`;
  - `why-diff -- src` limits hunks to `src/`;
  - binary file change appears as a hunk with `binary` detail in json (`hunk.lines` empty, header `Binary file changed`) and is listed in md;
  - json has `schemaVersion: 1`; session `path` in json starts with `~/` when under HOME;
  - `repo.name` is the basename of the repo root.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: green, build, commit `fix(cli): validate --fail-on/--since/--classify, pathspec, binary files, schemaVersion`.

### Task 8: No-transcript mode, `why-diff pr`, GitHub Action (M14, part of M9)

**Files:**
- Modify: `src/pipeline.ts` (when `summary.sessionsFound === 0`, drop `unattributed` labels and set `report.mode = 'risk-scan'`), `src/types.ts` (`Report.mode: 'provenance' | 'risk-scan'`), `src/report/markdown.ts` and `terminal.ts` (risk-scan heading `## why-diff risk scan` with a one-line note `No agent transcripts here, so lines are not traced to prompts. The PR author can add provenance with \`why-diff pr\`.`), `src/cli.ts` (`--fail-on unattributed` in risk-scan mode is ignored with a stderr note)
- Create: `src/pr.ts` exporting `upsertSection(body: string, section: string): string` (between `<!-- why-diff:start -->` and `<!-- why-diff:end -->`), CLI subcommand `why-diff pr [--base <ref>] [--classify]` that runs the report for `<base>...HEAD` plus working tree, renders md and calls `gh pr view --json body` / `gh pr edit --body-file -`; with `--dry-run` it prints the new body.
- Create: `action.yml` (composite): inputs `fail-on` (default empty), `comment` (default `true`), `base` (default `${{ github.base_ref }}`); runs `node "$GITHUB_ACTION_PATH/plugin/bin/why-diff.mjs" "origin/$BASE...HEAD" --format md -q > why-diff.md`, then upserts one sticky PR comment marked `<!-- why-diff:comment -->` via `gh api` (needs `pull-requests: write`), then reruns with `--fail-on` when set. Document required `fetch-depth: 0`.
- Create: `.github/workflows/why-diff.yml` example in `docs/` (not in this repo's own workflows), and an `action-smoke` job in `ci.yml` that runs the action against this repo's PRs is optional.
- Test: `test/pr.test.ts`, `test/report.test.ts`

- [ ] Step 1: failing tests: `upsertSection` inserts at the end when absent, replaces when present, keeps the rest byte-identical; a report built in a repo with zero sessions has `mode: 'risk-scan'`, no `unattributed` labels, md starts with `## why-diff risk scan`, and `--fail-on risk` passes when the only risk was `unattributed`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: green; validate `action.yml` with `npx -y @action-validator/cli action.yml` if available, else YAML parse; build; commit `feat: risk-scan mode without transcripts, why-diff pr, GitHub Action`.

### Task 9: Team rules config (from the AGENTS.md discussion)

**Files:** Create `src/config.ts` exporting `loadConfig(repoRoot): Promise<WhyDiffConfig>` reading `.why-diff.json` (or `"whyDiff"` key in `package.json`); modify `src/labels.ts` (new `LabelKind` `'protected-path'`, severity `risk`), `src/pipeline.ts`, guard default blocking adds `protected-path`. Test `test/config.test.ts`.

**Interfaces:** `interface WhyDiffConfig { protected?: string[]; blockOn?: LabelKind[]; ignore?: string[] }` (`protected`/`ignore` are globs matched with `path.matchesGlob` (Node >= 22) or a small built-in glob-to-regex for Node 20).

- [ ] Step 1: failing tests: `protected: ["migrations/**", ".github/**"]` and an agent edit to `migrations/001.sql` gives `protected-path`; `ignore: ["generated/**"]` removes hunks under `generated/`; `blockOn` replaces the guard's default list; invalid JSON gives a clear error naming the file.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: green, build, commit `feat: .why-diff.json team rules (protected paths, ignore, guard labels)`.

### Task 10: README, release, final verification

**Files:** `README.md`, `docs/STUDY.md` link check, `package.json` version `0.2.0`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` version `0.2.0`.

- [ ] Step 1: README: new top section "Why this exists" (the problem, why transcripts are the missing link, why instructions files like AGENTS.md/CLAUDE.md are not enough, what it is not); "Use it" section with four flows: after a session, PR author (`why-diff pr`), reviewer/CI (Action, risk-scan mode, `fetch-depth: 0`), team rules (`.why-diff.json` + Stop hook); install via release tarball; remove "builds"; update Limitations (removed worktrees, transcripts local to the author, risk-scan without provenance).
- [ ] Step 2: `npm run typecheck && npm test && npm run build && npm run check:bundle && claude plugin validate .`; all green.
- [ ] Step 3: `npm pack`, create GitHub release `v0.2.0` with asset `why-diff.tgz`; verify `npx -y https://github.com/mateuszkania-im/why-diff/releases/download/v0.2.0/why-diff.tgz --version` prints `0.2.0` from an empty dir; verify the Action on a throwaway PR in this repo.
- [ ] Step 4: rerun the audit scripts `t-*.sh` from `/private/tmp/claude-501/whydiff-audit/` and record before/after in the final report.
