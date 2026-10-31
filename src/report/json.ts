/**
 * JSON renderer: the report as pretty-printed JSON with a trailing newline.
 * Key order follows the Report type so diffs between runs stay readable.
 */
import type { Report } from '../types.js';

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}
