# Changelog

## 0.2.1

### Changed

- `why-diff pr --working-tree` is now `why-diff pr --include-uncommitted` (no alias). The main command keeps `-w, --working-tree`.
- The JSON summary has two new fields: `binaryFiles` and `unattributedBinaryFiles`. The report has a new `includesWorkingTree` field.
- `--fail-on unattributed` now also exits 1 when a changed binary file has no agent edit explaining it.

### Fixed

- Guard: a shell `mv` or `rm` from the session is credited only when the hunk is exactly that operation (a rename with no changed lines, or a whole-file deletion), so a human's later edit in a renamed test no longer blocks the agent.
- Guard: globbed and target-directory shell forms are understood: `rm test/*.test.js`, `rm -f tests/**/*.spec.ts`, `rm -rf test/*` (including what is below the matched directories), `mv -t old a.test.js`, `mv --target-directory=old`, `git mv -k`, `rm -- file`.
- Guard: parallel sessions no longer overwrite each other's entries in `guard-state.json` (lock file, merge with the latest state, atomic rename). The lock always gives up by its deadline, so a broken or foreign lock file can never hang a session; it only skips the dedupe write. A writer removes the lock only while it still holds its own token.
- `why-diff pr` warns about uncommitted changes only when they are actually left out (on the base branch the working tree is reported).
- A literal `--` given as an option value (`-m --`) is no longer taken as the pathspec separator.
- Changed binary files are counted in the summary (terminal and Markdown).
- `-o .why-diff/<file>` creates `.why-diff/.gitignore` only when it is missing, and keeps your own.
- In a shallow clone, the `fetch-depth: 0` hint is added only to missing-revision errors; other git errors pass through unchanged.
- The session time window counts commits correctly when the guard diffs against a session-start revision.
- Action: an invalid `comment-author` prints a warning and the default identity is used.
- Redaction: `password: value` lines with very deep indentation, dotted literals on .env, CLI and YAML lines (`password=foo.bar`, `DB_PASSWORD=my.dotted.word`), and bare `Basic <base64>` credentials without digits (when they decode to `user:pass`) are masked. Code is left alone: `const password = event.target.value;`, `password: input.value,`, `password = config.db.password`.
- `tests-disabled`: a nested `- key:` list inside a CI step (`with:`, `strategy.matrix.include`) no longer ends the step, so `continue-on-error: true` after it is still caught.
- `tests-disabled`: deleting a test together with a same-stem source file is exempt only when the source sits in a related directory: the same directory, a mirrored tree (`test/` and `src/`, `src/test/java` and `src/main/java`, `__tests__/`), or for Python tests (`test_foo.py`, `foo_test.py`) in a top-level test tree, the package anywhere.
- `out-of-scope` labelling no longer grows quadratically with the number of files a prompt touched.

## 0.2.0

### Install and runtime

- The CLI ships as one standalone file, `plugin/bin/why-diff.mjs`, with zero runtime dependencies. `npx -y github:mateuszkania-im/why-diff` runs it without building anything, and releases carry a `why-diff.tgz` tarball for a faster `npx`.
- The plugin's Stop hook runs the bundled file locally: no network, no install.
- `--version` prints the version.

### Finding the right diff and sessions

- Base branch resolution: `--base <ref>`, CI pull request targets (`GITHUB_BASE_REF`, GitLab and Bitbucket variables), `origin/HEAD`, then `main`, `master`, `develop`, `trunk`.
- A shallow clone stops with a hint (`fetch-depth: 0` or `--base`) instead of diffing the wrong range.
- The session time window covers rebased and amended commits.
- Sessions run in other `git worktree`s of the repo are discovered.
- `.why-diff/` is never part of the diff.

### Guard (Claude Code Stop hook)

- Looks only at the session's own exact or partial edits, including commits made during the session.
- Does not block twice for the same findings, keeps its cost bounded, is symlink-safe, and a corrupt state file cannot switch it off.

### Labels and redaction

- New `tests-disabled` label: runner-scoped excludes, swallowed test failures (`|| true`), disabled test scripts, test files renamed away or deleted, pytest `addopts`, `continue-on-error` on CI test steps.
- `out-of-scope` is anchored per prompt, so files related to what a prompt touched are no longer flagged.
- Secrets are masked in prompts, rationales, edit bodies, intent-check reasons, and key-shaped secrets in diff lines. `--redact-prompts` leaves prompt text and rationales out.

### CLI and output

- Invalid `--fail-on`, `--since`, `--classify` values are rejected.
- `-- <paths>` limits the report to paths.
- Binary files are handled.
- JSON reports carry `schemaVersion: 1` and `mode`.
- Home directory paths are shown as `~`.

### Reviewers, CI and teams

- Risk-scan mode: without transcripts (CI, a reviewer's machine) why-diff still reports every risk label, without prompt attribution.
- `why-diff pr` writes the provenance report into the current branch's PR description via `gh`. It never pushes or creates a PR.
- GitHub Action (`mateuszkania-im/why-diff@v0.2.0`): one sticky PR comment plus the job summary, optional `fail-on`, read-only handling of fork PRs. See `docs/github-action.md`.
- Team rules in `.why-diff.json` (or `"whyDiff"` in `package.json`): `protected` paths, `ignore`, and `blockOn` for the guard. Rules are read from the base revision, so a change cannot loosen the rules it is judged by.

## 0.1.0

- First release: per-line attribution of git diffs to Claude Code, Codex and OpenCode transcripts, deterministic risk labels, optional intent check, terminal, Markdown, JSON and HTML reports, Claude Code plugin with the Stop hook guard.
