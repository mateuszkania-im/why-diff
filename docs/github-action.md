# GitHub Action

The why-diff action runs on every pull request and posts one comment with the
risk labels for the diff: skipped or weakened tests, tests turned off in config,
removed assertions, new dependencies, CI and config changes, lint suppressions,
`any` casts and secret-like strings. The comment is sticky: later pushes update
the same comment instead of adding new ones.

CI has no agent transcripts, so the action runs in **risk-scan mode**: lines are
not traced to prompts and nothing is reported as unattributed. To show reviewers
which prompt wrote which hunk, the PR author runs `why-diff pr` on their own
machine, where the transcripts live (see below).

## Example workflow

Save as `.github/workflows/why-diff.yml`:

```yaml
name: why-diff
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # needed to post and update the comment

jobs:
  why-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history, so the base branch and merge base exist
      - uses: mateuszkania-im/why-diff@v0.2.1
        with:
          fail-on: risk    # optional: fail the job on any risk label
```

Both settings are required:

- `permissions: pull-requests: write`, or the comment step logs a warning
  ("Resource not accessible by integration") and the report stays in the job summary.
- `actions/checkout` with `fetch-depth: 0`. A shallow clone has no merge base
  with the target branch, and why-diff stops with a hint instead of diffing the
  wrong range.

Node.js 20 or newer must be on the runner (it is on GitHub-hosted runners). The
action runs the committed standalone build `plugin/bin/why-diff.mjs`, so there is
no `npm install` step.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `fail-on` | `''` | Fail the job if: `risk`, `tests`, `unattributed` (comma list). Empty never fails. `unattributed` is ignored in risk-scan mode, with a note in the log. |
| `comment` | `'true'` | Post or update the sticky comment. Set `'false'` to only write the job summary. |
| `base` | `${{ github.base_ref }}` | Branch the PR targets. why-diff compares `origin/<base>...HEAD`. |
| `token` | `${{ github.token }}` | Token used to post the comment (becomes `GH_TOKEN`). Pass a personal access token or a GitHub App token to post as another identity. |
| `comment-author` | `''` | Login that owns the sticky comment, for example `my-app[bot]`. Empty: the token's own login when `gh api user` works, else `github-actions[bot]`. An invalid login is ignored with a warning and the default is used. |

## Outputs

| Output | Meaning |
|---|---|
| `report` | Path of the Markdown report (also appended to the job summary). |
| `exit-code` | `0` when clean, `1` when a `fail-on` check matched. |

The report always goes to the job summary. The comment is posted even when a
`fail-on` check matches; the job fails after it. Posting the comment never fails
the job by itself: if a `gh api` call fails (for example a missing permission),
the step logs a warning and the report stays in the job summary.

The comment starts with the marker `<!-- why-diff:comment -->`. The action only
updates a marker comment written by its own identity (`github-actions[bot]`, or
the token's user when you pass a personal access token), so a marker comment
planted by someone else is ignored and the action posts its own.

A GitHub App token posts as `<app>[bot]`, and `gh api user` does not work for
App tokens. Without `comment-author` the action then looks for a comment by
`github-actions[bot]`, finds none, and posts a new comment on every run. Set
`comment-author: <app>[bot]` to keep updating a single comment.

## Pull requests from forks

On a pull request from a fork, GitHub gives the workflow a read-only token, so
the action cannot comment. It detects this (the PR head repository differs from
the base repository), prints a notice, and leaves the report in the job summary.
`fail-on` still applies.

Do not switch the workflow to `pull_request_target` to get a write token for
forks. That event runs with a write token and your secrets, and diffing the PR
means checking out the fork's code (including its git config, hooks and
scripts), so untrusted code would run with write access to your repository.

## Provenance from the PR author: `why-diff pr`

The author of an agent-written PR has the transcripts. Running

```sh
npx github:mateuszkania-im/why-diff pr
```

on the PR branch builds the full provenance report (each hunk traced to the
prompt that wrote it) and writes it into the PR description, between
`<!-- why-diff:start -->` and `<!-- why-diff:end -->`. Running it again replaces
that section; the rest of the description is left as it is.

- It needs the GitHub CLI (`gh`), logged in.
- It only edits the description of the PR that already exists for the current
  branch (`gh pr edit --body-file -`). It never pushes and never creates a PR.
- `--dry-run` prints the new description without changing anything.
- `--base <ref>` sets the target branch (default: auto-detected).
- By default the report covers committed work only (`<base>...HEAD`), matching
  what reviewers see in the PR. Add `--include-uncommitted` to include uncommitted
  changes; why-diff warns on stderr when the tree is dirty, the flag is absent and
  uncommitted changes are actually left out (on the base branch itself the
  working tree is reported).
- `--session <files...>`, `--harness <list>`, `--since <date>` and `--scan-all`
  pick the transcripts, as in the main command.
- If the description is too long for the section, it is shrunk to fit GitHub's
  65 536-character limit; if there is no room at all, nothing is changed and the
  command exits with an error.
- `--classify` adds the LLM intent check; `--redact-prompts` leaves prompt text out.
