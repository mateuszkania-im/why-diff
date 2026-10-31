/**
 * Promptfoo custom provider for the why-diff intent classifier.
 *
 * Promptfoo hands us the test vars; the `case` var holds one dataset row as
 * JSON. We rebuild the runtime inputs, run our own prompt builder + backend
 * (src/classify, loaded through tsx so no build step is needed) and return the
 * verdict string as the output, so assertions are a plain `equals`.
 *
 * Config (promptfooconfig.yaml -> providers[].config):
 *   backend: claude-cli | anthropic | openai   (default claude-cli)
 *   model:   backend model id/alias            (default: backend default)
 */
import { tsImport } from 'tsx/esm/api';

const lib = tsImport('./case.ts', import.meta.url);

export default class WhyDiffProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.label = options.label;
    this.backend = this.config.backend ?? 'claude-cli';
    this.model = this.config.model;
    this.classifier = undefined;
  }

  id() {
    return `why-diff:${this.backend}:${this.model ?? 'default'}`;
  }

  async callApi(_prompt, context) {
    const { makeClassifier, classifyCase } = await lib;
    this.classifier ??= makeClassifier(this.backend, this.model);
    const raw = context?.vars?.case;
    const evalCase = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const started = Date.now();
    try {
      const v = await classifyCase(this.classifier, evalCase);
      return {
        output: v.verdict,
        metadata: { reason: v.reason, model: v.model, ms: Date.now() - started },
      };
    } catch (err) {
      return { error: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}` };
    }
  }
}
