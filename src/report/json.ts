/**
 * JSON renderer: the report as pretty-printed JSON with a trailing newline.
 * Key order follows the Report type so diffs between runs stay readable.
 */
import type { Report } from '../types.js';
import { mapStrings, stripControls } from './shared.js';

export function renderJson(report: Report): string {
  return JSON.stringify(mapStrings(report, stripControls), null, 2) + '\n';
}
