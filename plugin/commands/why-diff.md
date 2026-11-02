---
description: Trace every hunk of the current diff back to the prompt that caused it, and flag unrequested changes and test tampering
argument-hint: "[git range] [--classify]"
allowed-tools: Bash(node:*), Bash(npx -y @mateuszkania-im/why-diff:*), Bash(npx -y github:mateuszkania-im/why-diff:*), Bash(why-diff:*), Read
---

Run why-diff on this repository and help the user review the result. The CLI ships inside this plugin as `${CLAUDE_PLUGIN_ROOT}/bin/why-diff.mjs` (one file, no dependencies). Below, `WHY_DIFF` means `node "${CLAUDE_PLUGIN_ROOT}/bin/why-diff.mjs"`; if that file is missing, use `npx -y @mateuszkania-im/why-diff` instead.

1. Run: `WHY_DIFF $ARGUMENTS --format md --no-open -q` (with no range, why-diff picks the branch range plus the working tree).
2. Also write the interactive page: `WHY_DIFF $ARGUMENTS --format html --out .why-diff/report.html --no-open -q`.
3. Summarise for the user in a few lines: the share of added lines that trace to a prompt, hunks nobody asked for, and every `risk` label (test edits, skipped tests, removed assertions, CI changes, secrets). Quote file:line for each.
4. Do not fix anything unless the user asks. If tests were weakened, say so plainly.
5. Tell the user they can open `.why-diff/report.html` to review hunk by hunk (j/k to move, x to mark reviewed).
