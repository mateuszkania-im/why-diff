---
name: why-diff
description: Use before committing, opening a PR, or when the user asks what changed and why after an agent session. Traces each diff hunk to the human prompt and tool call that produced it, and flags unrequested edits, test tampering, new dependencies and CI changes.
---

# why-diff

When the user is about to commit or open a pull request after agent work, or asks "what did you change", "why did this change", "did you touch the tests", run:

```bash
npx -y github:mateuszkania-im/why-diff --format md --no-open
```

Read the output and report back:
- the headline numbers (lines traced to a prompt, unrequested hunks, tests touched),
- each `risk` label with file and line,
- hunks with verdict `unrequested`, with the reason.

Be honest about your own scope creep: if a hunk is unrequested, say so and offer to revert it.
For a PR description, paste the markdown output under a "Provenance" heading.
