# Changelog

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
- GitHub Action (`mateuszkania-im/why-diff@main`): one sticky PR comment plus the job summary, optional `fail-on`, read-only handling of fork PRs. See `docs/github-action.md`.
- Team rules in `.why-diff.json` (or `"whyDiff"` in `package.json`): `protected` paths, `ignore`, and `blockOn` for the guard. Rules are read from the base revision, so a change cannot loosen the rules it is judged by.

## 0.1.0

- First release: per-line attribution of git diffs to Claude Code, Codex and OpenCode transcripts, deterministic risk labels, optional intent check, terminal, Markdown, JSON and HTML reports, Claude Code plugin with the Stop hook guard.
