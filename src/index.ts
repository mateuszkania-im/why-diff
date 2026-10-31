/** Public library API of why-diff. */
export * from './types.js';
export { buildReport, ADAPTERS, type BuildOptions } from './pipeline.js';
export { parseUnifiedDiff } from './diff-parse.js';
export { attribute } from './attribute.js';
export { labelHunks, isTestFile, isLockfile } from './labels.js';
export { summarize } from './summary.js';
export { claudeCodeAdapter } from './adapters/claude.js';
export { codexAdapter } from './adapters/codex.js';
export { opencodeAdapter } from './adapters/opencode.js';
export { createClassifier, classifyHunks, summarizeIntent, type ClassifierKind } from './classify/index.js';
export { renderReport, renderHtml, renderMarkdown, renderTerminal, renderJson, type ReportFormat } from './report/index.js';
