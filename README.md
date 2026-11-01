# why-diff

**`git diff` tells you what your coding agent changed. `why-diff` tells you why.**

Every hunk of an agent's diff, traced back to the prompt you typed and the tool call that wrote it. Hunks nobody asked for, tests that were skipped, weakened or turned off, new dependencies and CI edits are flagged before you commit.

```bash
npx -y github:mateuszkania-im/why-diff            # branch + working tree, in your terminal
npx -y github:mateuszkania-im/why-diff --html     # interactive review page
npx -y github:mateuszkania-im/why-diff --classify # + "did I actually ask for this?" check per hunk
```

Node 20+. Works with **Claude Code**, **Codex** and **OpenCode** transcripts. Runs locally. No account, no server, no telemetry. The examples below use `why-diff` for short (see [Install](#install)).

<!-- STUDY:START -->
> **What we measured** ([full study](docs/STUDY.md), 78 headless Claude Code sessions, raw data in `bench/`):
> Claude Code (Sonnet) **never edited a test in 72 runs**, even when the failing test was wrong. It refused all 24 impossible tasks.
> Add one sentence to the prompt ("just make the suite green") and it **edited the tests in 5 of 6** impossible tasks (p < 0.001).
> **why-diff flagged all 5 as test changes**, and 3 of them as skipped tests or weakened assertions, including `3240 → 3300`, `false → true` and a deleted `expect`.
> Attribution on the benchmark: **340 / 340 agent-written lines traced to the exact edit and prompt.**
<!-- STUDY:END -->

![why-diff review page on a real Claude Code session](docs/screenshot-demo.png)

<sub>A real Claude Code session: two prompts plus one line added by hand. Every hunk links to the prompt, the tool call and the agent's own explanation. Dark mode, filters and keyboard review included.</sub>

---

## Why this exists

**The problem.** Reviewing agent-written code is now the bottleneck. A 400-line diff from a 20-minute session mixes three things you can't tell apart in `git diff`:

1. what you asked for,
2. what the agent decided was "implied" (imports, wiring, a drive-by refactor),
3. what it did to make the build green: `it.skip`, a loosened `toBe` to `toBeTruthy`, `"strict": false`, `|| true` after the test command.

`git blame` says the agent wrote all of it. The commit message is the agent's own summary. Neither tells you which prompt a line came from, or whether any prompt asked for it.

**Transcripts are the missing link.** Claude Code, Codex and OpenCode already record every `Edit`, `Write` and `apply_patch` with the exact old and new text, next to the prompt that led to it. The record exists on your machine; nothing reads it at review time. `why-diff` joins that record with your git diff, line by line.

**Instruction files are not enough.** `AGENTS.md` and `CLAUDE.md` tell the agent what to do. They don't check what it did. In [our study](docs/STUDY.md) Claude Code never edited a test in 72 runs, with or without a CLAUDE.md rule against it. One sentence of pressure in the prompt ("just get `npm test` fully green") was enough for it to edit the tests in 5 of 6 tasks it could not solve honestly. An instruction can be outweighed by the next prompt, and nothing tells you when that happened. why-diff flagged all 5 of those runs as test changes, and 3 of them as skipped tests or weakened assertions, because it looks at the result instead of the request.

**What it is not.**

- Not a code reviewer. It doesn't judge whether the code is correct, fast or well designed.
- Not a linter. The risk labels point at things a human should look at (a removed assertion, a new dependency, a CI change); they don't enforce style.
- Not telemetry. Transcripts are read locally and nothing is sent anywhere. The only network calls are the optional `--classify` intent check, to the model backend you pick, and `why-diff pr`, which edits your PR description through `gh`.

## How is this different from code review?

Claude Code's Code Review tab and AI pull request reviewers answer "is this code good?". why-diff answers "where did each change come from, and was it asked for?".

- **Provenance, not opinion.** Attribution and risk labels are deterministic: the same diff and transcripts give the same report. Only the optional intent check uses a model.
- **Across sessions, PRs and CI.** One report covers every agent session that touched the branch, can go into the PR description, and runs as a risk scan in CI.
- **They combine.** The report is context for a reviewer, human or AI: it tells them which hunks nobody asked for and which tests changed, so they know where to look first.

## What you get

The same session in the terminal (`why-diff --classify`). One git hunk in `src/cart.js` mixed both prompts and my manual line; why-diff splits it:

```
why-diff  why-diff-demo  working tree                 fix/discount · 1 Nov 2026

  91% of added lines trace to a prompt · 1 hunk nobody asked for
  tests touched ⚠ · 1 unattributed hunk
  4 hunks in 2 files · +11 −5 · 1 session (claude-code) · 2 prompts
  intent by haiku

RISKS (2)
  ✖ test-modified  test/cart.test.js:L16-23
      Agent changed a test file
  ▲ unattributed  src/cart.js:L18-20
      No agent edit explains these lines (human edit or unrecorded tool) althou…

PROMPTS (2)

❯ “The discount test in test/cart.test.js is failing. Fix it so all tests pa…”
  claude-code · 17:44 · session 5ec472ce · 1 hunk · +3 −2
    src/cart.js:L6-10  +3 −2
      exact · ✓ requested

❯ “Now make the receipt show prices with two decimals and a dollar sign, e.g…”
  claude-code · 17:44 · session 5ec472ce · 2 hunks · +7 −3
    src/cart.js:L11-19  +4 −2
      exact · ✓ requested
    test/cart.test.js:L16-23  +3 −1
      exact · ≈ implied · ✖ test-modified

UNATTRIBUTED (1)  no agent edit explains these
    src/cart.js:L18-20  +1
      none · ✗ unrequested · ▲ unattributed

why-diff v0.3.0 · generated 1 Nov 2026, 03:12 UTC
```

- **Per-line provenance.** Each added line is owned by the edit that *introduced* it (not the one that merely had it as context). Hunks that mix several prompts, or your own manual edits, are split into segments.
- **Deterministic risk labels** (no LLM): test files changed, `.skip/.only/xit/@pytest.mark.skip/t.Skip` added, tests disabled (config excludes, `|| true` on a test command, `continue-on-error` on a test step, test files renamed away or deleted), assertions removed or weakened (`toBe` → `toBeDefined`, `.not` dropped, expected number changed), snapshots, new dependencies, lockfiles, CI and build config, `eslint-disable` / `@ts-ignore` / `noqa`, new `any`, secret-looking strings (masked), files no prompt mentioned.
- **Optional intent check** (`--classify`): a small model reads your prompts and each hunk (by reference id, it never rewrites code) and answers *requested / implied / unrequested / unclear* with a one-line reason. It uses your local `claude` CLI by default, so no API key is needed. Anthropic and any OpenAI-compatible endpoint (including Ollama) also work. Prompts and agent rationales are secret-masked before they are sent. Results are cached in `.why-diff/`.
- **Four outputs:** terminal, Markdown for the PR description, JSON, and a single-file HTML review page (prompt timeline, filters, `j`/`k` navigation, `x` to mark reviewed, light/dark).

## Use it

### After a session

Run it in the repo when the agent stops, before you commit:

```bash
why-diff                 # branch vs its base + uncommitted work, in the terminal
why-diff --html          # .why-diff/report.html: prompt timeline, filters, j/k, x to mark reviewed
why-diff -w              # only uncommitted changes
why-diff -- src          # only these paths
```

The base branch is auto-detected (`origin/HEAD`, then `main`, `master`, `develop`, `trunk`); pass `--base <ref>` to choose. Sessions run in other `git worktree`s of the same repo are found too. The `.why-diff/` folder (HTML report, intent cache) is never part of the diff.

### As a PR author: `why-diff pr`

The transcripts live on your machine, so the author is the one who can attach provenance to a PR:

```bash
why-diff pr              # writes the report into the current branch's PR description
why-diff pr --dry-run    # print the new description, change nothing
```

It needs a logged-in `gh`, edits only the description of the PR that already exists for the branch (between `<!-- why-diff:start -->` and `<!-- why-diff:end -->`), and never pushes or creates a PR. Running it again replaces that section. It reports committed work (`<base>...HEAD`) like the PR itself; add `--include-uncommitted` to include uncommitted changes. Add `--redact-prompts` to leave your prompt text out.

### As a PR author: `why-diff notes`

Provenance can also travel with the commits, as a git note that reviewers, CI and the GitHub Action read without any transcript:

```bash
why-diff notes                     # git note on HEAD under refs/notes/why-diff
git push origin refs/notes/why-diff
why-diff notes --dry-run           # print the note JSON instead
```

The note is compact JSON per hunk (file, line range, match, label kinds, verdict with `--classify`, and the prompt cut to 1500 characters with secrets masked; `--redact-prompts` leaves the text out). Without transcripts, `why-diff` reads the notes on the commits of the range (fetch them with `git fetch origin refs/notes/why-diff:refs/notes/why-diff`) and runs in **notes mode**: hunks a note covers show their prompt, the rest stays a risk scan. Labels are always computed from the diff, never taken from the note. Commit or rebase again and the note stays on the old commit: run `why-diff notes` again.

### As a reviewer or in CI: the GitHub Action

CI has no transcripts, so there why-diff runs in **risk-scan mode**: no prompt attribution and no `unattributed` label, but every risk label (skipped or weakened tests, tests turned off in config, new dependencies, CI changes, suppressions, secret-like strings) on the PR diff. The action posts it as one sticky PR comment and the job summary.

```yaml
# .github/workflows/why-diff.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  why-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required: a shallow clone has no merge base
      - uses: mateuszkania-im/why-diff@v0.3.5
        with:
          fail-on: risk    # optional
```

The action fetches `refs/notes/why-diff` first, so provenance the author pushed with `why-diff notes` shows up in the comment. Fork PRs get the job summary only. Inputs, outputs and the security notes are in [docs/github-action.md](docs/github-action.md). Outside GitHub Actions, the CLI reads the target branch from GitLab (`CI_MERGE_REQUEST_TARGET_BRANCH_NAME`) and Bitbucket (`BITBUCKET_PR_DESTINATION_BRANCH`) variables. A reviewer can also run `why-diff` on a checked-out PR branch locally and get the same risk scan.

### As a team: `.why-diff.json` and the Stop hook

Put team rules in `.why-diff.json` at the repo root (or a `"whyDiff"` key in `package.json`):

```json
{ "protected": ["migrations/**"], "ignore": ["generated/**"], "blockOn": ["lockfile"] }
```

- `protected`: agent edits under these paths get a `protected-path` risk label (in a risk scan, every hunk there does).
- `ignore`: paths dropped from the report, counted as "N hunks ignored by config". Never a protected path, the rules file itself, a rename whose old path is not ignored, or, in the guard, anything the agent edited.
- `blockOn`: label kinds added to the guard's blocking list.

Rules are read from the base revision (the merge base of a PR, the start of the session for the guard), so a change cannot loosen the rules it is judged by, and any change to the rules file is labelled. Globs support `*`, `**` and `?`; a name without `/` matches a file or directory of that name anywhere; `{`, `[` and `!` are rejected. Matching is case-insensitive on macOS and Windows. If the base branch already has a rules file, that file is used as it is: edits to it in your branch (`ignore`, `protected` or `blockOn`) have no effect until they are merged, and the edit itself is labelled `protected-path`. Only when the base has no rules file yet does the working-tree file apply, and then without `ignore`: `protected` and `blockOn` take effect, and why-diff prints a note that `ignore` takes effect once it is committed to the base branch.

With the [Claude Code plugin](#claude-code-plugin) installed, the Stop hook guard applies these rules in every session: if the agent skipped, weakened, disabled or deleted a test, touched CI or a protected path, or added something that looks like a secret, it is not allowed to finish silently.

## Install

```bash
npx -y github:mateuszkania-im/why-diff --version
```

That runs the committed standalone file `plugin/bin/why-diff.mjs` (one file, zero dependencies, nothing to build). From v0.2.0 each release also has a tarball, which skips the git clone and is faster:

```bash
npx -y https://github.com/mateuszkania-im/why-diff/releases/download/v0.3.5/why-diff.tgz --version
```

Tip: `alias why-diff="npx -y github:mateuszkania-im/why-diff"`.

## Claude Code plugin

```text
/plugin marketplace add mateuszkania-im/why-diff
/plugin install why-diff@why-diff
```

You get:

- **`/why-diff`**: a review of the current diff, summarised by Claude with every risk quoted as `file:line`.
- **A skill** Claude uses before committing or opening a PR, so it reports its own scope creep.
- **A SessionStart hook** (`why-diff session-start`): records the commit HEAD points at when a session starts, as `{session_id, root, head, at}` in `<dataDir>/sessions/<sha256(session_id)>.json` (mode 0600; `dataDir` is `$CLAUDE_PLUGIN_DATA`, else `~/.cache/why-diff`), outside the repository the agent can rewrite. The guard diffs from that commit when the record's file last changed before the session's first tool call, and blocks when it changed later ("base record modified during session") or when the recorded commit's object was not written before the session. Its only output is SessionStart hook JSON whose context carries `why-diff:base-record <sha256(session_id)>`, or `why-diff:base-record-failed <sha256(session_id)>` when the record could not be written (printed in every repository at startup and `/clear`, nothing outside one), so the transcript shows what happened: if the record is later missing or unreadable, or could not be written, the guard blocks, and so it does when there is no record and the record directory exists but cannot be written. The record also keeps the index at session start as a tree (`git write-tree`), so changes staged before the session are not taken for the agent's. The record's root is compared by real path; a session that moved to another repository gets the reflog fallback there (`WHY_DIFF_DEBUG=1` prints how the base was chosen). It never blocks or fails the session itself.
- **A Stop hook guard** (`why-diff guard`): it looks only at the changes this session made (including commits made during the session, and changes inside submodules) and blocks on `test-skip-added`, `tests-disabled`, `assertion-removed`, `secret-like`, `ci-changed`, `protected-path` and `unreviewed`, plus `blockOn` from `.why-diff.json` (`--on` replaces the list). It tells the agent to revert or tell you plainly. Within one turn it blocks once (Claude Code's `stop_hook_active`); while the risky change stays, every later turn blocks again with a short "still present" note, because nothing the agent could write (a state file, its own transcript) can switch a block off. An internal error means "let it stop", except where git could be made to hide content (a filter it cannot switch off, an unreadable config, no commit provably from before the session): then it blocks and says so. It runs the CLI bundled in the plugin, locally, with no network and no install.

## Intent check accuracy

The classifier has its own eval: 128 hand-labelled hunks (TS/React/Next, Node, Python, Go), with tricky cases such as tests edited to pass, drive-by renames, loosened config and necessary imports. It runs in Promptfoo.

| Model | Accuracy (4 classes) | Unrequested: precision | Unrequested: recall |
|---|---|---|---|
| Claude Haiku (via `claude -p`) | **78.1%** | 74.4% | **100%** (32/32) |

Full confusion matrix in [evals/RESULTS.md](evals/RESULTS.md). Rerun with `npm run eval`. The weak class is *unclear*: the model rarely admits it can't tell. Treat `unrequested` as "look at this", not as a verdict.

## CLI

```text
why-diff [range] [options] [-- <paths>]

  range                  git range or commit (default: branch vs its base + working tree)
  -- <paths>             only these paths, e.g. why-diff -- src
  --base <ref>           branch or ref to compare against (default: auto-detected, incl. CI PR targets)
  -w, --working-tree     only uncommitted changes
  -f, --format <f>       terminal | md | html | json
  --html                 write .why-diff/report.html and open it
  -o, --out <file>       write to a file
  --no-open              do not open the HTML report
  -c, --classify [b]     intent check: auto | claude-cli | anthropic | openai
  -m, --model <m>        model for the intent check (default: haiku)
  --harness <list>       claude-code,codex,opencode
  -s, --session <files>  explicit transcript files
  --since <date>         only sessions after this date (default: the commit the range starts from, minus 6 h)
  --scan-all             also scan transcripts started outside the repo that edited files in it (slower)
  --fail-on <what>       risk | unrequested | tests | unattributed  (comma list; exit 1, for CI/hooks)
  --redact-prompts       omit prompt text and agent rationales (secrets are always masked)
  -v, --verbose          show the agent's rationale, commands and label details
  -q, --quiet            no progress output
  -V, --version          print the version

why-diff pr [options]    put the report into the current branch's PR description (gh pr edit)
                         --dry-run, --base, --include-uncommitted, --classify, --redact-prompts, transcript options as above
why-diff notes [options] store the branch's provenance as a git note on HEAD (refs/notes/why-diff)
                         --dry-run, --base, --classify, --redact-prompts, transcript options as above
why-diff guard [--on k]  Claude Code Stop hook (reads the hook payload from stdin)
why-diff session-start   Claude Code SessionStart hook: records the session's base commit for the guard
```

Invalid values for `--fail-on`, `--since`, `--classify` and `--format` are rejected with an error instead of being ignored. Binary files are listed but not diffed: the summary counts them (`summary.binaryFiles`, and `summary.unattributedBinaryFiles` for those no agent edit names), and `--fail-on unattributed` also fails on a changed binary file that no agent Write or shell command explains. Home directory paths in reports are shortened to `~` (`repo.root`, session paths) and edit paths are stored relative to the repo root. JSON output carries `schemaVersion: 1` and `mode` (`provenance`, `risk-scan`, or `notes` when git notes supplied the prompts; such hunks carry `source: "notes"`).

Secrets are masked everywhere they could leak: prompts, agent rationales, edit bodies, intent-check reasons, and key-shaped secrets in diff lines. `--redact-prompts` goes further and leaves prompt text and rationales out entirely, for reports you share.

Put the Markdown in a new PR by hand (or use `why-diff pr` on an existing one):

```bash
why-diff main...HEAD --format md --classify > provenance.md
gh pr create --body-file provenance.md
```

## How it works

```
transcripts (~/.claude/projects, ~/.codex/sessions, opencode storage)
   │  adapters: prompts + Edit/Write/MultiEdit/apply_patch/bash mutations → FileEdit[]
   ▼
git diff (range + working tree + untracked) → hunks
   │  attribution: per added line, the latest edit that introduced it (exact pass,
   │  then whitespace-insensitive pass); deletions by the edit that removed them;
   │  hunks split into segments by owning prompt (short runs fold into their
   │  neighbours, new files dominated by one prompt stay whole); human lines stay unattributed
   ▼
deterministic labels (tests, deps, CI, suppressions, secrets, scope)
   ▼
optional intent check (reference ids, batched, cached)
   ▼
terminal · markdown · json · html
```

Shell edits (`sed -i`, `cat > file <<EOF`, `npm install`) are parsed from the command line. When the content can be recovered (heredocs, `echo >`), they match exactly. Otherwise they are attributed at file level and labelled `bash-edit`.

Reports stay small on big diffs: every edit a hunk references is stored once in `report.edits` (keyed by id, `oldText`/`newText`/`command` cut to 2 KB and flagged `truncated`), hunks carry `editIds` plus a text-free `edits` summary, and diff lines longer than 2 KB are cut. File-level labels (`test-modified`, `lockfile`, `ci-changed`, ...) are reported once per file in the risk lists even when the file was split into many segments.

## Limitations

- Provenance needs the transcripts, and they live only on the machine of whoever ran the agent. A reviewer or CI without them gets a risk scan (the same risk labels, no `unattributed` label) unless the author shared provenance with `why-diff notes` (git notes, which need push access to the repo, so not from a fork) or `why-diff pr`. Notes describe the commit they were written on: after new commits or a rebase, hunks the old note does not cover stay risk-scanned until the author runs `why-diff notes` again. A note's prompts are the author's claim; labels and `--fail-on` never depend on them.
- In a risk scan, `protected-path` applies to every hunk under a protected path, because there is no way to tell agent edits from human ones.
- The intent check judges whole hunks: a requested 17-line function next to an accidental one-line change can be marked `unrequested` as a whole. Its verdicts also vary between runs on borderline cases. Use it to point your attention, not as a score.
- Transcript formats are not public contracts. Adapters are tested against current Claude Code (2.1.x) and Codex (0.16x) files and will need updates.
- Lines written by scripts the agent ran (`node fix.js`, codegen, formatters) can't be traced line by line in the report, and show as `file-only` matches (or as unattributed when the command names no path). The guard still catches them by time, see below.
- Binary files are attributed by path only: an agent Write or shell command that names the file (`cp logo.png assets/`) counts as explaining it, whatever bytes it wrote.
- The guard credits a shell command for a file only when the command itself names that path: literally, by a glob (`*`, `?`, `**`), by a brace list (`test/{a,b}.test.js`), through a variable assigned a literal earlier on the same command line (`D=test; rm $D/*.js`), a `for` loop over a literal list, `bash -c` / `sh -c` / `eval`, `find ... -delete` / `-exec`, or a literal `ls` / `find` piped into `xargs`. A shell delete or rename counts only when the hunk is exactly that operation. An in-place rewrite (`sed -i`, `perl -i`, `>`, `tee`, `cp` onto the file, `truncate`, an inline `python -c` / `node -e` / heredoc script that opens a literal path for writing) counts for every change in that file, so a human edit made afterwards in the same file is credited to the agent too. A change no command names (a path a script computes, `node fix.js`, `os.remove(name)`, `rsync --delete`, a variable from the environment or an earlier call, an MCP tool that writes files) is credited by time instead: when the file's change time (ctime, which a command cannot backdate the way it can mtime; on Windows the NTFS change time) lies within 2 seconds of any of the session's tool calls (Bash, Edit, Write, MCP tools, WebFetch, subagents, every call), from the call to its result, the change counts as the agent's, for every hunk of the file not otherwise explained. A call that runs in the background (`run_in_background`, a `backgroundTaskId`), a command that detaches a process (a single `&`, `nohup`, `setsid`, `disown`, `at`, `crontab`, `systemd-run`, `launchctl`, `tmux`, `screen`, `coproc`, `docker run -d`, `docker compose up -d`, `systemctl start`, `pm2 start`, PowerShell `Start-Process`), and a call with no result recorded keep their window open until the guard runs. A deleted file is dated by the nearest path above it that still exists, and counts only when the hunk is the whole deletion. A human edit made outside every agent tool call is never credited, because it moves the change time out of the windows. The honest edges: a human edit made while an agent tool call runs (a long test run, a `sleep`, a subagent, a background or detached command until the guard runs) is credited to the agent, and so is any other change in that window, such as a `git stash pop` the agent ran over your uncommitted work. A process that a script or interpreter detaches by itself (`subprocess.Popen(..., start_new_session=True)`, `spawn(..., { detached: true })`) and that writes after its call returned, outside every later window, is not credited. A `**` in a shell path is credited as matching across directories (and `rm -r` with a glob as covering everything below the matches), even though bash without `globstar` expands `**` like `*`.
- The guard diffs from the commit HEAD pointed at when the session started, as the plugin's SessionStart hook recorded it. Without that record (the plugin installed mid-session, a resumed session that started before it, the guard run by hand) the base falls back to reflog heuristics: committer dates and the reflogs are the agent's to set, so it takes the candidates from the reflogs of HEAD and the current branch (more than 10,000 pre-session commits there blocks) and HEAD's first-parent history, trusts only a commit whose object was provably written before the session, and among those picks the one whose object was written last (a reset that drops commits does not move the base back; if HEAD was moved before the session to a commit older than one it pointed at earlier, the guard diffs from that newer one and can block on differences the session did not make). A trusted object is a loose object, or one in a pack whose pack and index files are older than the session, in the repository's own object store (never one found only through alternates). If there is none (a repository created, or every object repacked, during the session; a `.git/shallow` or pack index changed during it), the guard blocks and says it could not check.
- Git is run so that repository settings cannot change what it shows or run anything: no hooks (`core.hooksPath` points nowhere, so not even `post-index-change` runs while the guard builds its temporary index), no textconv, external diff, fsmonitor, filter drivers (`clean` / `process` / `smudge`), untracked cache, signature check, pager, prompt or lazy fetch, no user attributes file, replace refs or grafts, no system or global config file: only a fixed list of settings from them that can never run anything (line endings, the global excludes file, case and Unicode handling, `safe.directory`, the identity; never `include`) is copied into a config file of why-diff's own that git reads as the global one, so the repository's own config still takes precedence, and no inherited `GIT_*` environment variable (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`...). Files flagged `assume-unchanged` or `skip-worktree` are diffed as if unflagged. The guard goes further: every file the session touched is diffed through a temporary index that keeps only blob ids, so git hashes the working tree content instead of trusting the index's stat data or flags, and a tracked file whose change time falls in a tool call window is checked even when `git diff` lists nothing. A skip-worktree file missing from the working tree counts as sparse, not deleted, only when the sparse patterns leave it out (cone directories, or the full patterns), `core.sparseCheckout` comes from the repository's own config (not `~/.gitconfig`, `$XDG_CONFIG_HOME` or the environment), and both the config file holding it and the patterns file predate the session. Any change to the repository's config during the session (even `git config core.editor vi`) therefore makes the guard treat every skip-worktree file missing from the working tree as deleted: in a sparse checkout it can block on test files outside the cone. Pathspec lists too long for one command line are split, or matched once over the whole tree. A file that `.gitattributes` or `.git/info/attributes` marks binary is diffed again as text unless its content is binary by git's own rule (a NUL byte in the first 8000 bytes); NUL bytes later in a text file show as `␀`. A file whose text still cannot be produced (over 64 MB of diff) gets the `unreviewed` risk label, and the guard blocks on it.
- Besides the working tree, the guard diffs the base against HEAD and against the index, so a weakening kept only in a commit or only staged blocks too. A file that differs there, or that was untracked (gone from the index or HEAD, still on disk) by a command that never named it, is credited to the agent when the index, the branch ref, HEAD's reflog or `packed-refs` changed during one of its tool calls or after the last one; a human commit, `git rm --cached` or even an IDE's `git status` made while an agent call runs or after the agent's last call is credited too, so staged or committed changes from before the session can block then.
- The guard reads at most 2000 untracked files (32 MB in all) credited by change time alone; any more block as `unreviewed` without being read. `why-diff guard` runs the check in a child process and kills it after 20 seconds, then blocks and says so; called as a library, `runGuard` has only a best-effort time limit that cannot interrupt synchronous work. The guard also blocks when git's work tree is not the directory holding the `.git` entry (`core.worktree`, or a `.git` file elsewhere pointing back).
- File change times are the guard's evidence, and they are only as good as the file system that reports them: a FAT or exFAT image, a FUSE or a network file system mounted by the user (no root needed) can report any time. What is checked: the SessionStart record keeps the device (`st_dev`) of the repository root, of the git common dir and of the record directory, and the guard blocks when any of them is on another device now (a file system mounted over it during the session). Without a record (or with one from an older version), the repository root and the git common dir must be on a known local file system type (`apfs`, `hfs`, `ext2/3/4`, `xfs`, `btrfs`, `zfs`, `ntfs`, `tmpfs`, `overlay`), read with `statfs` on Linux and from `mount` on macOS; any other type, or one that cannot be read, blocks as unreviewed. The base record must be on such a file system too. Inside the repository, a tracked or untracked path on another device than the work tree root is never dated: when it differs from the base, or is a test or config file, the guard blocks with `unreviewed`; index and ref files are compared with the device of the git dir they belong to, objects with the git common dir (so a linked worktree on another volume works). On Windows the file system type is taken to be NTFS. A directory inside the repository replaced by a symlink is never followed: every tracked file under it counts as deleted, dated by the symlink's own change time (credited when that lies in a tool call window or after the last one). With the reftable ref backend, `reftable/` and its tables are dated like the files backend's refs; an unknown ref backend blocks.
- Submodules are checked like the repository itself, up to 3 levels deep, with the submodule path in the findings. Each one's base is its own HEAD at session start, kept in the SessionStart record (`submodules`), or else chosen like the repository's own base (reflogs and first-parent history, by object write times), so a checkout that is behind its gitlink (a pull without `git submodule update`) is not taken for the agent's change. A submodule whose index and refs did not change during the session is checked through `git status` (stat data with change times compared): only the files it lists, and the paths the session named, are dated, and a clean one costs a few git calls. A submodule that cannot be read blocks as `unreviewed`: not checked out while its recorded commit changed during the session, a submodule directory holding files but no repository, a symlink or mount in its place, no commit from before the session to compare against while it existed before, or nested deeper than 3 levels.
- If the session started in a repository, the guard blocks when no `.git` is found any more: moving `.git` or the repository away does not turn the session into one outside a repository. The proof is the SessionStart marker in the transcript (always blocks, whatever the record says), or, without a marker, a record file for this session that changed during or after the session start (the agent may have written it) or that names a root that is the cwd or contains it.
- Label heuristics are lexical and can still be evaded by sufficiently indirect code, which is inherent to any checker that does not run the tests.
- When the guard cannot finish checking a session that touched the repository (any `.git` entry at or above the cwd counts as one, even one git cannot read) (an unreadable or truncated index, a temporary index it cannot build, any other error), it blocks and says why rather than letting the agent finish. A session with no tool calls never blocks.
- The guard trusts the session transcript, which the agent can rewrite (it is a file in your home directory). An agent that edits its own transcript to remove or alter its tool calls can hide changes from the guard; the guard is a check against careless or quietly risky edits, not a sandbox.
- `chmod`, `chown` and `touch` never explain changed lines, and a bare `.` explains files below it only for restores (`git checkout -- .`) and formatters (`prettier --write .`).
- In a prompt longer than 64 KB (a pasted log or file), only the first and last 32 KB are read for path-like tokens; mentions of file names are still found anywhere. Markdown reports quote each prompt up to 1500 characters, with links, images and headings escaped. Notes mode reads at most 50,000 noted hunks across the notes of a range (newest first).
- Sessions started in another folder (a sibling project, a workspace root) that edited the repo by absolute path are found only with `--scan-all`, which byte-scans every transcript modified in the window.
- Sessions run in a `git worktree` are found while that worktree still exists (`git worktree list`), or when it was nested under the repo. Once a worktree outside the repo is removed, its transcripts are generally not found (`--scan-all` only matches edits by absolute path under the repo root), so review before pruning worktrees.
- If an agent edited a file earlier and those edits were later reverted, a line you then type by hand in that file can show as a `file-only` match to that old prompt. It still carries the `unattributed` label, so it doesn't pass as agent work.
- Claude Code deletes transcripts after 30 days by default (`cleanupPeriodDays`). Review before that, or raise it.
- The guard is a Claude Code Stop hook only. Codex and OpenCode sessions are covered by the CLI and the Action, not blocked live.
- Secret masking is pattern-based. It catches common key formats and `name = value` assignments, not every possible secret. Don't treat a report as safe to publish just because nothing was masked.
- The intent check is a model judgement (see accuracy above), not a gate. The deterministic labels are the gate.
- OpenCode support is implemented from its source code and fixtures, not yet battle-tested.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck
npm run build
npm run eval      # classifier eval (uses your local claude CLI)
```

Reproduce the study: see the "Rerun" section of [docs/STUDY.md](docs/STUDY.md) (`bench/run.ts`, `bench/aggregate.ts`).

## License

MIT © Mateusz Kania
