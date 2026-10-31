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
      - uses: mateuszkania-im/why-diff@main
        with:
          fail-on: risk    # optional: fail the job on any risk label
```

Both settings are required:

- `permissions: pull-requests: write`, or the comment step fails with
  "Resource not accessible by integration".
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

## Outputs

| Output | Meaning |
|---|---|
| `report` | Path of the Markdown report (also appended to the job summary). |
| `exit-code` | `0` when clean, `1` when a `fail-on` check matched. |

The comment is posted even when a `fail-on` check matches; the job fails after it.
The comment starts with the marker `<!-- why-diff:comment -->`, which is how the
action finds it again. Do not remove the marker if you edit the comment by hand.

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
- `--classify` adds the LLM intent check; `--redact-prompts` leaves prompt text out.
