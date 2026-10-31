# Changelog

## 0.2.2

### Changed

- JSON and HTML reports store edit paths relative to the repo root (tildified when outside it) and `repo.root` with `~` for the home directory, so a shared report does not carry your user name.
- `why-diff pr` treats `<!-- why-diff:start -->` / `<!-- why-diff:end -->` as markers only on a line of their own. A description with unbalanced markers (a start without an end, an end before the start, two sections) is not edited: `pr` exits 2 and says why.
- Markdown: each quoted prompt is capped at 1500 characters; when the report is still too long, whole prompt groups are dropped (with a "more prompts not shown" line) before anything is cut.
- `chmod`, `chown` and `touch` no longer explain changed lines; a bare `.` path explains files below it only for restores and formatters.

### Fixed

- Guard: long pasted prompts no longer make it slow. Path tokens are read in linear time (and from at most 64 KB of each prompt), and system-reminder and slash-command tags are stripped without backtracking, so a 300 KB prompt is checked in well under the hook timeout.
- Guard: test files rewritten through the shell now block: `sed -i`, `perl -i`, `>` and `>>`, `tee`, `cp` onto the file, `truncate`, and inline `python -c` / `node -e` / heredoc scripts that write a literal path. A file the agent never named in a command is still never credited.
- Shell commands: brace lists, variables assigned earlier on the same line, `export`, `for` loops over literal lists, `bash -c`, `sh -c`, `eval`, `find -delete`, `find -exec`, `ls|find ... | xargs`, `git clean -f`, `sudo -u <user>`, `rimraf`, `shred -u`, `dd of=`, `install` and `busybox` are followed. Expansion has one shared budget across nesting levels, so no command can make it slow.
- File names in Unicode NFD (as macOS hands them over) attribute exactly against git's NFC paths.
- Untracked symlinks are shown as git shows them (the link target, mode 120000); the file they point at is never read.
- A Python directory with `__init__.py` at the base revision counts as a source package for test/source pairing, whatever its name (`tools/`, `bench/`).
- Transcripts starting with a UTF-8 BOM keep their first line in every adapter. `--session` on a directory or a missing file gives a clear error. Windows drive paths compare case-insensitively and in both slash styles, including `--scan-all`.
- Markdown: lone carriage returns break quoted prompts into lines instead of joining them; `@mentions` and `#123` references in prompt text no longer ping people or link issues.

### Security

- Prompts, file names, branch names and label details can no longer send escape sequences to your terminal: control characters show as visible glyphs (`␛`), C1 controls and bidi overrides as `�`. The HTML title is cleaned the same way; Markdown and JSON drop C0/C1 controls (keeping tab and newlines).
- Markdown truncation never leaves a `<details>` open, so text after the why-diff section in a PR description stays outside it.
- Redaction: PGP private key blocks are masked and labelled `secret-like`; `mysql -p<password>`, `curl -u user:<password>` and run-together names such as `PGPASSWORD=` are masked. Known library calls after a secret name (`getpass.getpass`, `keyring.get_password`, `secrets.token_hex`, `os.environ`) and type annotations in code (`token: Token;`) are left alone, but other values under those module names and capitalised values on config lines are still masked. An scp-style git remote (`git@github.com:org/repo.git`) is not treated as an e-mail address.

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
- Redaction: `password: value` lines with very deep indentation, dotted values after a secret name, and bare `Basic <base64>` credentials without digits (when they decode to `user:pass`) are masked. In prompts, rationales and intent reasons a dotted value (`password = my.secret.pass;`) is masked whatever its shape unless it starts at a code root (`body.`, `config.`, `event.`, ...) or is a call; in edit bodies only .env, CLI and YAML lines are (`password=foo.bar`, `DB_PASSWORD=my.dotted.word`), so code such as `const password = event.target.value;` is left alone.
- `tests-disabled`: a nested `- key:` list inside a CI step (`with:`, `strategy.matrix.include`) no longer ends the step, so `continue-on-error: true` after it is still caught.
- `tests-disabled`: deleting a test together with a same-stem source file is exempt only when the source sits in a related directory: the same directory, a mirrored tree (`test/` and `src/`, `src/test/java` and `src/main/java`, `__tests__/`), or for a Python test (`test_foo.py`, `foo_test.py`) in a top-level test tree, the only same-stem source gone in the diff when it is at the repo root, under `src/` or `lib/`, or in a package directory (not `tools/`, `scripts/` and similar).
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
