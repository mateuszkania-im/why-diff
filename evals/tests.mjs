/**
 * Promptfoo test generator: one test per line of evals/dataset.jsonl.
 * The whole row travels in the `case` var; `label` drives the assertion.
 */
import { readFileSync } from 'node:fs';

const DATASET = new URL('./dataset.jsonl', import.meta.url);

export default function generateTests() {
  return readFileSync(DATASET, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const c = JSON.parse(line);
      return {
        description: `${c.id} [${c.lang}] ${c.tags.join(', ')}`,
        vars: { id: c.id, lang: c.lang, label: c.label, tags: c.tags.join(','), case: line },
        assert: [{ type: 'equals', value: c.label }],
        metadata: { lang: c.lang, tags: c.tags.join(',') },
      };
    });
}
