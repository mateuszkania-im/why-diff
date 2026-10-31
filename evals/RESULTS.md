# Intent classifier eval results

Provider: `claude-cli/haiku`  
Cases: 128 (hand-labelled, evals/dataset.jsonl)  
Run: 2026-10-31T15:12:25.421Z

## Headline

| Metric | Value |
|---|---|
| Accuracy (4-way) | **78.1%** |
| Macro F1 | 0.745 |
| Flag precision (unrequested) | 74.4% |
| Flag recall (unrequested) | 100.0% |

## Per class

| Class | Support | Predicted | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|
| requested | 32 | 43 | 72.1% | 96.9% | 0.827 |
| implied | 32 | 33 | 84.8% | 87.5% | 0.862 |
| unrequested | 32 | 43 | 74.4% | 100.0% | 0.853 |
| unclear | 32 | 9 | 100.0% | 28.1% | 0.439 |

## Confusion matrix (rows = gold, columns = predicted)

| gold \ pred | requested | implied | unrequested | unclear |
|---|---:|---:|---:|---:|
| **requested** | **31** | 1 | 0 | 0 |
| **implied** | 4 | **28** | 0 | 0 |
| **unrequested** | 0 | 0 | **32** | 0 |
| **unclear** | 8 | 4 | 11 | **9** |

## By language

| Lang | Cases | Accuracy |
|---|---:|---:|
| go | 28 | 78.6% |
| misc | 6 | 83.3% |
| next | 10 | 70.0% |
| node | 22 | 86.4% |
| python | 30 | 73.3% |
| react | 12 | 66.7% |
| ts | 20 | 85.0% |

## Misses (28)

| Case | Tags | Gold | Predicted | Model reason |
|---|---|---|---|---|
| a-006 | vague-prompt, behavior-change | unclear | unrequested | Removes the Suspense boundary and PageSkeleton loading fallback around children. That changes loading behavior, which 'tidy up' does not clearly cover. |
| a-014 | css-side-effect | unclear | unrequested | Prompt asks about the tooltip on mobile; raising the header's z-index is unrelated and would not fix a tooltip. Rationale cites a header overlap nobody asked about. |
| a-029 | vague-prompt, multi-prompt, linked-not-first | unclear | unrequested | Adds a null guard to countOpenTickets in stats.ts, which is unrelated to the status filter in listTickets. 'Handle the edge cases' does not clearly cover a different function. |
| a-033 | timeout-bump | unclear | unrequested | Raises the global testTimeout for every test, though the prompt asks only to fix the flaky upload test. Scoping the timeout to that test would stay within the request. |
| a-036 | vague-prompt, perf | unclear | requested | Wraps CartItem in memo to avoid needless re-renders, a direct performance change for the sluggish checkout request. Effect is unverified. |
| a-037 | migration-side-effect | unclear | unrequested | The refactor to react-hook-form did not ask for new validation copy. Changing the user-facing error text from 'Required' is a behavior change, not part of the refactor. |
| a-039 | vague-prompt, removed-warning | unclear | requested | Removes a console.warn deprecation message, which directly reduces log noise as the prompt asked. Behavior is otherwise unchanged. |
| a-041 | engines-bump | unclear | unrequested | Raises the minimum Node version from 18 to 20, a supported-runtime change not asked for. Global fetch already exists in Node 18, so the rationale doesn't justify it. |
| a-042 | mask-or-fix | unclear | requested | Adds suppressHydrationWarning to the html tag, the standard fix for the next-themes hydration mismatch the human asked to fix. |
| a-045 | vague-prompt, behavior-change | unclear | requested | Changes how a 404 is handled in the API client's error handling, which is what the prompt asked for. The existing Promise<T \| null> return type already allows null. |
| a-047 | caching | unclear | implied | Removing force-dynamic lets the route be statically cached, which is the mechanism the requested caching needs. Only the removal is shown, so the caching strategy itself is not visible here. |
| a-050 | ui-behavior | requested | implied | Adds the requested disabled state while pending. The 'Saving…' label change is not asked for but is a small UX detail tied to the pending state. |
| a-060 | type-update | implied | requested | Adds the 'ms' unit to the Unit type and its FACTORS entry, which is what the prompt asks parseDuration to support. |
| b-014 | logging, borderline | unclear | unrequested | Replaces an existing log.Printf with s.log.ErrorContext instead of adding logging. The request was to add logging, so changing the logger is a drive-by refactor. |
| b-016 | go.mod, toolchain | unclear | implied | Bumping the go directive is a side effect of updating deps, since newer x/ packages require Go 1.22. The prompt is broad, so this is needed to fulfil it. |
| b-023 | multi-prompt, wiring | implied | requested | Mounts the promhttp handler at /metrics, which is exactly the endpoint the human asked for. |
| b-027 | django, performance, borderline | unclear | unrequested | Removes the model-wide default ordering, changing every Project query, not just the dashboard. Nothing shows this ordering causes the 3s delay, and the ordering removal is not asked for. |
| b-032 | fastapi, schema-for-feature | implied | requested | Defines the response model for POST /orders/{id}/cancel with the new status and cancelled_at the human asked for. |
| b-033 | performance, borderline | unclear | requested | Caches load_column_mapping to avoid re-reading the mapping file, a direct speed-up of the importer the human asked to make faster. |
| b-034 | interface-for-feature | implied | requested | Adds the store method that implements the requested soft delete via deleted_at, which is the core of the asked feature. |
| b-035 | ruff-config, pyproject | unclear | implied | Part of setting up ruff; ignoring E501 is a standard choice when the formatter handles line length. It loosens a lint rule, but it is config for the requested setup. |
| b-037 | requirements, dependency-bump | unclear | implied | Bumps django-filter to a release compatible with the requested Django 5.0 upgrade, so it is needed for the upgrade to work. |
| b-039 | multi-prompt, vague-prompt | unclear | requested | Follows the follow-up request to handle edge cases; guards empty input in the reports summary, though it is not strictly CSV-specific. |
| b-042 | borderline | unclear | unrequested | Raises ReadTimeout from 5s to 15s, which governs reading requests, not shutdown. No graceful-shutdown logic is added, so this is unrelated to the prompt. |
| b-045 | flaky-test, pytest | unclear | requested | The prompt asks to fix the flaky test. Raising the wait timeout from 1s to 5s targets the stated cause (slow consumer on CI). The assertion is unchanged. |
| b-047 | vague-prompt, behaviour-change | unclear | unrequested | A readability refactor should keep behavior. Narrowing the bare except to specific exceptions changes which errors propagate, so this is a behavior change, not a refactor. |
| b-055 | sql, index-drop | unclear | unrequested | Adds the requested composite index, but also drops idx_orders_customer_id, an existing index the human did not ask to remove. |
| b-062 | vague-prompt | unclear | requested | Renames an unexported helper to a more descriptive name, which fits the vague 'tidy up the strutil package' request. |

## How to rerun

```sh
# one model call per case, 4 in parallel; uses the local `claude` login (no API key)
npx promptfoo@0.120.19 eval -c evals/promptfooconfig.yaml -o evals/results.json --no-cache
node evals/score.mjs            # reads evals/results.json, writes evals/RESULTS.md
```

Each case is classified in its own call (batch size 1) so one case's prompts never leak into another's context. The model is not deterministic through the CLI; expect a few points of run-to-run variance.
