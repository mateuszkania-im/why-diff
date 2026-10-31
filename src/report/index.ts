/**
 * Report renderers. One entry point, four formats.
 */
import type { Report } from '../types.js';
import { renderHtml } from './html.js';
import { renderJson } from './json.js';
import { renderMarkdown, type MarkdownOptions } from './markdown.js';
import { renderTerminal, type TerminalOptions } from './terminal.js';

export { renderHtml } from './html.js';
export { renderJson } from './json.js';
export { renderMarkdown, type MarkdownOptions } from './markdown.js';
export { renderTerminal, detectColor, detectWidth, type TerminalOptions } from './terminal.js';
export { headline, groupByPrompt, collectRisks, reportHash, escapeHtml, type Headline, type PromptGroup, type Grouped, type RiskItem } from './shared.js';

export type ReportFormat = 'terminal' | 'md' | 'html' | 'json';

export const REPORT_FORMATS: readonly ReportFormat[] = ['terminal', 'md', 'html', 'json'];

/** Options for every format; each renderer picks the keys it understands. */
export type RenderOptions = TerminalOptions & MarkdownOptions;

export function isReportFormat(s: string): s is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(s);
}

export function renderReport(report: Report, format: ReportFormat, opts: RenderOptions = {}): string {
  switch (format) {
    case 'terminal':
      return renderTerminal(report, opts);
    case 'md':
      return renderMarkdown(report, opts);
    case 'html':
      return renderHtml(report);
    case 'json':
      return renderJson(report);
    default: {
      const never: never = format;
      throw new Error(`Unknown report format: ${String(never)}`);
    }
  }
}
