# Changelog

## 0.3.5

### Security

Guard bypasses found in a security review of 0.3.4 (the agent is treated as the adversary):

- Moving `.git` away (or the repository away from the session's directory) made the guard treat the session as one outside any repository. When no `.git` is found, the guard now blocks if the transcript carries the SessionStart record or failed marker (whatever the record says), or, without a marker, if a record file for this session changed during or after the session start, or names a root that is the cwd or contains it. With neither, a session outside a repository still finishes.
- With the reftable ref backend (`git refs migrate --ref-format=reftable`), a commit made with plumbing (`commit-tree` plus `update-ref`, a private index) changed none of the dated ref files. The guard now also dates `reftable/` and every table in it, of the common dir and of a worktree, and blocks on an unknown `extensions.refStorage`.
- Git hooks ran inside the guard: `git update-index` on the temporary index ran the repository's `post-index-change` hook (from `.git/hooks` or any `core.hooksPath`), which could put a test back while the guard read it. Every git call now goes through one helper: `core.hooksPath` points nowhere, `core.fsmonitor` and the untracked cache are off, `--no-ext-diff --no-textconv` are on every diff and log, `--no-filters` on `hash-object`, filter drivers are switched off, `log.showSignature` is off, no pager, prompt or lazy fetch, and no system or global config file is read: a fixed list of settings from them that cannot run anything (line endings, the global excludes file, case handling, `safe.directory`, the identity; never `include`) is copied into a config file of why-diff's own that git reads as the global config. Diffs and `git status` use `--ignore-submodules=dirty`, so no `git status` runs inside a submodule with its own config and `submodule.<name>.ignore` cannot hide a moved gitlink.
- On Linux the mount entry of a path is found by its mount ID (`/proc/self/fdinfo`), so a btrfs subvolume, whose `st_dev` never equals mountinfo's device, no longer blocks every session; a submodule's own worktree git dir gets the volume-root check too.
- A user-mounted volume (an HFS+ or ext4 image with crafted dates, attached without root) passed the file system type check: a repository, git dir or base record on a volume a user mounted now always blocks, and without a recorded device a repository root or git dir at the root of its own volume blocks. A `.git` symlink made the index and ref times unreadable, which read as unchanged: the git dir is now found through git, the link's own time counts, and unreadable times count as changed.
- A test directory replaced by a symlink to its moved original hid the deletion of every file under it: the files were dated through the link. Each directory inside the repository is now read with `lstat`; a file under a symlink counts as deleted, dated by the symlink's own change time, and credited when that lies in a tool call window or after the last one.
- Tests inside a submodule were never checked. Every checked-out submodule is now checked like the repository itself, from its own HEAD at session start (kept in the SessionStart record, else chosen like the repository's base), dated by its own work tree, index and ref times, up to 3 levels deep, with the submodule path in the findings. One whose index and refs did not change is checked through `git status` plus its assume-unchanged and skip-worktree entries, so a clean submodule costs a few git calls. One that cannot be read (not checked out while its gitlink changed, files but no repository, a symlink or mount in its place, no pre-session commit while it existed before, deeper than 3 levels) blocks as `unreviewed`.
- Change times could be forged without root through a user-mounted file system (a FAT disk image attached with `hdiutil`, or FUSE), inside the repository or over it. The repository root, the git common dir and the base record must now be on a known local file system type (statfs on Linux, `mount` on macOS, `Get-Volume -FilePath` on the real path on Windows (NTFS or ReFS on a Fixed or Removable drive), run by absolute path from System32 with the path passed as data), so a repository on FAT/exFAT, a network share or FUSE always blocks; and the SessionStart record keeps the devices of the repository root, the git common dir, the record directory and each submodule's root and git dir, and the guard blocks when any of them changed. Submodules get the same type check; one whose git dir is on another device with no recorded device blocks unless unchanged and clean. A path inside the repository on another device than the work tree is no longer dated: when it differs from the base, or is a test or config file, the guard blocks with `unreviewed`. Index and ref files on another device than their git dir, and objects on another device than the git common dir, read as changed during the session.

### Documentation

- README Limitations rewritten as one short bullet per limit; the full guard rules moved to a Guard details section.
- README Limitations: on Windows a file's owner can set its change time (`SetFileInformationByHandle`, verified in CI), so time-based crediting there is best-effort; paths the agent names are always checked.
- README: the threat model now says that file ctime cannot be forged without root on the repository's own file system and that paths on other mounts inside the repository are not trusted; the Guard and Limitations text covers submodules, symlinked directories, the reftable backend, a moved `.git`, and git hooks, filters and global config being off.

## 0.3.4

### Security

Closes the label gaps left documented in 0.3.3. In JavaScript and TypeScript test files, these restructurings of existing assertions now carry a blocking label, so the guard blocks:

- A constant-false guard (`if (false)`, `if (0)`, `if (!true)`, `if (null)`, `if (undefined)`) around existing `expect` / `assert` lines, or right before one, counts as `test-skip-added`.
- An added `try` around existing assertions whose `catch` neither rethrows nor asserts counts as `assertion-removed`. A try that checks `.toThrow` or `rejects` is fine.
- A binding that shadows a test global (`it`, `test`, `describe`, `expect`, `assert`, the hooks...) counts as `test-skip-added`. This covers a top-level `const` / `let` / `var` / `function`, an indented one that the hunk then calls, and an import of those names from anything other than a test framework (vitest, `@jest/globals`, jest-circus, `node:test`, mocha, chai, `bun:test`, ava, tape, uvu, tap / node-tap, every `@playwright/*` package including `experimental-ct-*`, `node:assert`). `require` from a framework, `chai.expect` and `test.extend(...)` / `base.extend<T>(...)` fixtures are fine. A relative import (`./fixtures`) is resolved from the importing file (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`... and `/index.*`): it counts only when the module resolves, can be read, and neither it nor a module it re-exports (one level) imports, requires or re-exports a test framework or calls `.extend(`.
- Existing assertions moved into an added function literal that is never called (an arrow or function expression that starts the line, or a function declaration, whose name appears nowhere else in the file after the change) count as `test-skip-added`. A callback argument such as `it(...)`, `waitFor(() => {` or a continued `forEach(` is not a wrapper. The pipeline now reads the full text of changed JavaScript/TypeScript test files for this check.
- Full-file reads (runner and CI config, test files, the relative modules above) open the file by its real path only when that lies inside the repository's real root, and read it only when the opened descriptor is a regular file within the size cap: a symlinked parent directory pointing out of the repository, a FIFO or a device is never read.

### Documentation

- README Limitations: label heuristics are lexical and can still be evaded by sufficiently indirect code, which is inherent to any checker that does not run the tests.

## 0.3.3

### Security

Guard bypasses found in a security review of 0.3.2 (the agent is treated as the adversary):

- Session base: reflog entries with forged past dates could point the base at an older commit, so the guard diffed from it and missed later changes. Candidates now come from HEAD's reflog (entries dated before the session) and its first-parent history, and the base is the trusted one whose object was written last (an agent cannot write an object that predates the session); on a tie (one pack), the commit the others lead to.
- A base that is no longer an ancestor of HEAD (a `git reset` dropped a pre-session commit) is diffed as is. The guard used to fall back to the merge base, which let a reset re-skip a test.
- A test file untracked by a command that does not name it (a script running `git rm --cached`, the file kept on disk and excluded) was never credited. A file in the base that is gone from the index or HEAD but still on disk now counts as deleted when the index, the branch ref (or `packed-refs`) or HEAD's reflog last changed during one of the session's tool calls.
- A weakening kept only in a commit or only in the index (the working tree put back, or never touched: `update-index --cacheinfo`) passed, because only the working tree was diffed. The guard also diffs the base against HEAD and against the index (blob ids only, no stat data), merges those hunks with the working tree's (identical hunks once), and credits them by the same index and ref change times.
- Run time: 100,000 untracked files written during a call took 37 s, past the 30 s hook timeout. Paths the session named are now checked first; at most 2000 untracked files and 32 MB credited by change time alone are read, the rest block as `unreviewed` unread. `why-diff guard` runs the check in a child process with its own temporary directory and, at 20 s (`WHY_DIFF_GUARD_DEADLINE_MS`), kills it (and every process it started) with SIGKILL, removes the directory and blocks with a clear message: synchronous labelling (2000 files of 200 KB took 63 s) can no longer outrun the hook timeout. The library `runGuard` keeps an in-process, best-effort time limit.
- Labels: `it.skipIf(` / `test.skipIf(` / `describe.skipIf(` and `.runIf(`, bracket access (`it["skip"]`, `it['skip']`, ``it[`skip`]``) and a bare `return;` added as the first statement of a test body count as skips; an `expect(...)` subject changed into a literal, or into the value the assertion used to expect, counts as a weakened assertion, and so do `expect(x).toBe(x)` / `toEqual` / `toStrictEqual` comparing a value with itself (introduced by the change) and a positive `toBe` / `toEqual` / `toStrictEqual` turned into its `.not` form on the same subject.
- Session base record: the plugin now has a SessionStart hook (`why-diff session-start`) that records HEAD's commit outside the repository (`$CLAUDE_PLUGIN_DATA`, else `~/.cache/why-diff`, mode 0600), so truncating the reflogs and resetting to an older commit no longer moves the base. The guard uses the record when its file last changed before the session's first tool call, and blocks when it changed later or when the recorded commit was not written before the session. Without a record it falls back to the reflogs of HEAD and the current branch plus the first-parent history.
- The record cannot be deleted to fall back to the reflogs: `session-start` prints SessionStart hook JSON with a `why-diff:base-record <sha256(session_id)>` marker, and when the transcript shows it and the record is missing or unreadable, the guard blocks ("base record missing"). A record that cannot be dated (no tool call with a readable time) fails closed. Record roots are compared by real path; a different repository keeps the reflog fallback, reported with `WHY_DIFF_DEBUG=1`.
- An earlier session could disable the record (an unwritable data directory) and fall back to the reflogs: in a repository, at startup or `/clear`, `session-start` now always prints a marker, `why-diff:base-record <hash>` or `why-diff:base-record-failed <hash>`, and the guard blocks on the failed one (and, with no record and no marker, on a record directory that exists but cannot be written). The record also keeps the index as a tree (`git write-tree`), so changes the human staged before the session are not credited to the agent when an IDE refreshes the index.
- `core.worktree` (with a `.git` file pointing back) could point git at a clean copy and hide every change: the guard blocks when the work tree git reports is not the directory holding the `.git` entry, and when the session's directory lies inside the recorded repository but git finds another one.
- A reflog flooded with more pre-session commits than the candidate cap (10,000) fails closed instead of being cut, and HEAD's first-parent candidate never takes a slot under the cap.
- Index and ref dating no longer uses only the latest change time: a path is credited when any of the index, the branch ref, HEAD's reflog and `packed-refs` changed during a tool call, or later than the last one (a `git status` from an IDE rewrites the index afterwards and used to hide the agent's change). These files are read before the guard runs any git command.

### Documentation

- README: the SessionStart base record, and the reflog fallback without it.
- README Limitations: label heuristics can be evaded by restructuring code (`if (false)`, try/catch, a shadowed `it`, an arrow never called); the guard catches common weakenings, not every semantic one.

## 0.3.2

### Security

Guard bypasses found in a security review of 0.3.1 (the agent is treated as the adversary):

- Fail closed: a cwd with a `.git` entry at or above it (checked on the file system, so a corrupt `.git/HEAD` or a `.git` file pointing nowhere cannot make it look like no repository) is checked; once the session has touched it, any error while checking it (a truncated or corrupt `.git/index`, a temporary index that cannot be built, a git failure) blocks with "why-diff could not check this session: <reason>". It used to let the agent finish. Errors are no longer swallowed while listing changed, untracked or flagged files.
- A forged index entry (the old blob id with the new file's stat data) no longer hides a change: the guard diffs every file of the session through a temporary index rebuilt from blob ids alone, without stat data or flags, so git hashes the working tree content. If that index cannot be built, the guard blocks (it used to mark the files `unreviewed` without a hunk, which blocked nothing). Tracked files whose change time falls in a tool call window are checked whatever `git diff` reports.
- No unbounded argv: thousands of paths (an agent writing many files) made git fail with E2BIG and the guard pass. Path lists are split to fit the command line, `update-index` reads paths on stdin, and a long list is matched once over the whole tree instead of per chunk.
- Sparse checkout: a missing skip-worktree file is excused only when the sparse patterns leave it out (cone directories in cone mode, the full patterns otherwise), so flagging and deleting an in-cone test file blocks. `core.sparseCheckout` and `core.sparseCheckoutCone` count only from the repository's own config (local or worktree scope, and the file holding the setting, the repository's config or a file included into it, must predate the session), never from `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` or the environment, and the patterns file must predate the session.
- An untracked file over 2 MB (or one that cannot be read) is no longer skipped silently: it shows as a binary stub with the `unreviewed` risk label, so the guard blocks on it when the session touched it, and reports list it as a risk.
- Inherited `GIT_*` environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`...) are dropped from every git process why-diff starts; only the ones it sets itself reach git.

### Fixed

- Sparse checkouts: files outside the sparse patterns are no longer taken as deleted when the session merely touched the repository root.
- The temporary index never writes a shared index into `.git` when `core.splitIndex` is on.
- Missing files are checked one directory at a time and in parallel batches: the guard takes about 0.5 s on a 100,000-entry sparse index.

### Changed

- The npm package ships the CLI once (tarball 324 KB -> 289 KB).
- why-diff ignores `GIT_DIR` / `GIT_WORK_TREE` and the other `GIT_*` variables: run it from inside the working tree.

## 0.3.1

### Security

Guard bypasses found in a security review of 0.3.0 (the agent is treated as the adversary):

- Changes made by background or detached work are credited: a Bash call with `run_in_background` or a `backgroundTaskId`, a command that detaches a process (a single `&` outside quotes, `nohup`, `setsid`, `disown`, `at`, `crontab`, `systemd-run`, `launchctl`, `tmux`, `screen`, `coproc`, `docker run -d`, `docker compose up -d`, `systemctl start`, `pm2 start`, read with the shell lexer, by basename, behind wrappers and inside `sh -c` / `eval` / command substitutions), and a call with no result keep their time window open until the guard runs.
- Time windows come from every tool call of the session (Edit, Write, MCP tools, WebFetch, subagents...), not only Bash, so a later edit or write cannot move a file's change time out of the windows. Claude Code sessions expose them as `toolWindows` (was `shellWindows`).
- A deleted file whose parent was replaced by a file (ENOTDIR) or a symlink loop (ELOOP) is still dated by the nearest existing path.
- Windows uses ctime too (the NTFS change time, which `utimes` cannot set).
- Git cannot be configured to hide a change: every diff runs without textconv, external diff, fsmonitor, the user attributes file, replace refs, grafts, a changed `bigFileThreshold` or prefix settings, and with every filter driver switched off (through `GIT_CONFIG_*`, so any name works). Files that attributes mark binary are diffed again as text unless git's own content rule says binary; no file cap. A file whose text cannot be produced gets the new `unreviewed` risk label, and the guard blocks on it.
- Edit paths are canonicalised: true case through `realpath.native` and case-insensitive matching on a case-insensitive file system (whatever `core.ignorecase` says); on Windows, `\\?\` and `\\.\` prefixes, `::$DATA` and trailing dots and spaces are dropped.
- The session base no longer trusts committer dates: it comes from HEAD's reflog (then first-parent history), and only commits whose objects were provably written before the session (loose, or in a pre-session pack and index of the repository's own store) qualify. No such commit, a changed `.git/shallow` or pack index: the guard blocks and says it could not check. A base that is not an ancestor of HEAD becomes the merge base.
- Index flags cannot hide a change: files flagged `assume-unchanged` or `skip-worktree` (`git update-index`) are diffed again through a temporary copy of the index with the flags cleared (the real index is untouched); if that fails they get the `unreviewed` label. They are also candidates for crediting by time. A skip-worktree file missing from the working tree is taken as sparse (not deleted) only when the sparse checkout setup (`.git/config`, `config.worktree`, `info/sparse-checkout`) predates the session.
- No dedupe across turns: the agent could pre-record the state (running `why-diff guard` itself, writing `.why-diff/guard-state.json`, or appending to its transcript). Every Stop with risky hits blocks; `stop_hook_active` still lets the agent finish within a turn, and a repeat block gets a short "still present" message. `.why-diff/guard-state.json` is no longer written.

### Fixed

- Markdown: quoted prompts have links, images and headings escaped; Markdown and JSON drop escape sequences with their payload (OSC 8 link targets), zero-width characters, bidi controls and the BOM.
- Notes mode: noted hunks are indexed per file (it was quadratic: 50 notes of 13k hunks against 5k diff hunks took over 20 s) and capped at 50,000 across notes.
- Windows: `--classify` finds `claude.exe`, `claude.cmd` or `claude.bat`, never the extensionless npm shell script.

## 0.3.0

### Added

- `why-diff notes`: stores the branch's provenance (per hunk: file, line range, match, label kinds, intent verdict with `--classify`, and the prompt, secrets masked) as a git note on HEAD under `refs/notes/why-diff`, and prints the `git push origin refs/notes/why-diff` hint. `--dry-run` prints the JSON.
- Notes mode: without transcripts, why-diff reads the notes on the commits of the range and gives the hunks they cover their prompt (`source: "notes"`, report `mode: "notes"`); the rest stays a risk scan. Notes are untrusted: over 1 MB they are ignored, the shape is validated and text is sanitised. Labels and `--fail-on` come only from the diff.
- The GitHub Action fetches `refs/notes/why-diff` before the report.
- Guard: changes a shell command makes without naming the path (a script computing it, `node fix.js`, `rsync --delete`, an environment variable) are credited by time: the file's change time (ctime on POSIX, mtime on Windows) inside one of the session's Bash calls, with 2 s of slack; a deletion is dated by the nearest existing directory above it. Claude Code sessions expose these windows as `shellWindows`.
- CI runs on Windows (Node 22) too.

### Changed

- A Bash call that failed still counts as having run; only Claude Code's own refusal message, as a plain error result, means it did not.
- `--fail-on unattributed` applies only to transcript provenance, not to notes mode.
- Repo roots also match in their native real path form (Windows 8.3 short names).

### Fixed

- Windows: `--classify` with the Claude Code CLI installed through npm (`claude.cmd`) now runs: the npm shim is resolved to `node <cli.js>`, so no argument passes through a shell. Any other `.cmd` or `.bat` gives a clear error instead.

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
