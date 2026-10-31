/**
 * HTML renderer: a single self-contained, interactive review page.
 *
 * Security model: the only values interpolated into markup server-side are
 * the <title> (HTML-escaped) and the report JSON inside a
 * <script type="application/json"> block with `<`, `>`, `&` and the U+2028/9
 * separators escaped as \uXXXX so no payload can close the script element.
 * Everything else is rendered client-side through DOM APIs (textContent,
 * createElement); innerHTML is never used with report content.
 */
import type { Report } from '../types.js';
import { escapeHtml, headline, plural, reportHash } from './shared.js';

export function renderHtml(report: Report): string {
  const hash = reportHash(report);
  const h = headline(report);
  const s = report.summary;
  const title = `${report.repo.name} · ${report.range} · why-diff`;
  const payload = safeJson({ report, hash });
  const summaryLine = [
    h.noAddedLines ? 'no added lines' : `${h.tracedPct}% of added lines trace to a prompt`,
    h.intentRan ? `${plural(h.unrequestedHunks, 'hunk')} nobody asked for` : null,
    h.touchedTests ? 'tests touched' : 'tests untouched',
    `${plural(s.hunks, 'hunk')} in ${plural(s.files, 'file')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="why-diff ${escapeHtml(report.version)}">
<title>${escapeHtml(title)}</title>
<script>${THEME_BOOT}</script>
<style>${CSS}</style>
</head>
<body data-report-hash="${hash}">
<a class="skip" href="#main">Skip to hunks</a>
<header class="top" id="top"></header>
<div class="layout">
  <nav class="rail" id="rail" aria-label="Prompts timeline"></nav>
  <main id="main" class="main" aria-label="Diff hunks" tabindex="-1"></main>
</div>
<footer class="foot" id="foot"></footer>
<dialog id="help" class="help" aria-labelledby="help-title"></dialog>
<noscript><div class="noscript"><strong>why-diff</strong> · ${escapeHtml(report.repo.name)} · ${escapeHtml(report.range)}<br>${escapeHtml(summaryLine)}<br>This report is rendered in the browser and needs JavaScript. Run <code>why-diff --format md</code> for a static version.</div></noscript>
<script id="why-diff-data" type="application/json">${payload}</script>
<script>${APP_JS}</script>
</body>
</html>
`;
}

/** JSON that is safe inside a <script> element regardless of content. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/** Runs before first paint: honours #dark/#light in the URL, then the stored choice. */
const THEME_BOOT = `(function(){try{var ks=location.hash.slice(1).split(',');var t=ks.indexOf('dark')>=0?'dark':ks.indexOf('light')>=0?'light':localStorage.getItem('why-diff:theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

const CSS = `
:root{
  --bg:#f5f5f3;--surface:#ffffff;--surface-2:#efefec;--surface-3:#e7e7e3;
  --fg:#17191e;--fg-2:#5b5f66;--fg-3:#8a8f97;
  --line:#e3e3df;--line-2:#cfcfca;
  --accent:#4f63d2;--accent-bg:rgba(79,99,210,.10);
  --ok:#1f8a4c;--warn:#b0741a;--risk:#c93b3b;--info:#6b7280;
  --add-bg:#e9f6ed;--add-gut:#d3ebdb;--add-fg:#1e6b3a;
  --del-bg:#fcecec;--del-gut:#f5d3d3;--del-fg:#a23636;
  --claude:#c2572f;--codex:#0f7a6d;--opencode:#6d4fd2;
  --shadow:0 0 0 1px var(--line),0 1px 2px rgba(20,20,30,.04);
  --shadow-hover:0 0 0 1px var(--line-2),0 6px 16px rgba(20,20,30,.07);
  --radius:10px;--top-h:200px;
  --font:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,"JetBrains Mono",Consolas,"Liberation Mono",monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e0f12;--surface:#15171c;--surface-2:#1c1f25;--surface-3:#23262e;
  --fg:#e6e7e9;--fg-2:#9a9ea6;--fg-3:#6c717a;
  --line:#262931;--line-2:#363a44;
  --accent:#8191f2;--accent-bg:rgba(129,145,242,.14);
  --ok:#43cf7c;--warn:#e2a94b;--risk:#f26b65;--info:#9aa0a8;
  --add-bg:rgba(67,207,124,.10);--add-gut:rgba(67,207,124,.18);--add-fg:#8fe3b1;
  --del-bg:rgba(242,107,101,.10);--del-gut:rgba(242,107,101,.18);--del-fg:#f6a29e;
  --claude:#e57f5f;--codex:#43bdab;--opencode:#a596f2;
  --shadow:0 0 0 1px var(--line);--shadow-hover:0 0 0 1px var(--line-2),0 8px 20px rgba(0,0,0,.35);
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#0e0f12;--surface:#15171c;--surface-2:#1c1f25;--surface-3:#23262e;
  --fg:#e6e7e9;--fg-2:#9a9ea6;--fg-3:#6c717a;
  --line:#262931;--line-2:#363a44;
  --accent:#8191f2;--accent-bg:rgba(129,145,242,.14);
  --ok:#43cf7c;--warn:#e2a94b;--risk:#f26b65;--info:#9aa0a8;
  --add-bg:rgba(67,207,124,.10);--add-gut:rgba(67,207,124,.18);--add-fg:#8fe3b1;
  --del-bg:rgba(242,107,101,.10);--del-gut:rgba(242,107,101,.18);--del-fg:#f6a29e;
  --claude:#e57f5f;--codex:#43bdab;--opencode:#a596f2;
  --shadow:0 0 0 1px var(--line);--shadow-hover:0 0 0 1px var(--line-2),0 8px 20px rgba(0,0,0,.35);
  color-scheme:dark;
}
*{box-sizing:border-box}
html{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
button{font:inherit;color:inherit}
code,kbd,pre{font-family:var(--mono)}
a{color:var(--accent)}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:8px;top:-40px;background:var(--fg);color:var(--bg);padding:6px 10px;border-radius:6px;z-index:50}
.skip:focus{top:8px}
.noscript{max-width:720px;margin:40px auto;padding:20px;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);line-height:1.7}

/* ---------- top strip ---------- */
.top-inner{max-width:1440px;margin:0 auto;padding:12px 28px 0}
.toolbar{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--line)}
.toolbar-inner{max-width:1440px;margin:0 auto;padding:10px 28px 10px}
.brand-row{display:flex;align-items:center;gap:14px;min-height:32px}
.brand{display:inline-flex;align-items:center;gap:9px;font-weight:650;letter-spacing:-.01em;font-size:15px}
.brand svg{display:block}
.crumbs{display:flex;align-items:center;gap:8px;color:var(--fg-2);font-size:13px;min-width:0;flex-wrap:wrap}
.crumbs .sep{color:var(--fg-3)}
.crumbs code{font-size:12px;background:var(--surface-2);padding:2px 7px;border-radius:6px;color:var(--fg)}
.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.ibtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;min-width:30px;padding:0 9px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);color:var(--fg-2);cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.ibtn:hover{color:var(--fg);border-color:var(--fg-3)}
.ibtn svg{display:block}
.ibtn .lbl{font-size:12px;font-weight:500}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0 14px}
.stat{position:relative;background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 14px 12px;min-width:0;display:flex;flex-direction:column;gap:1px}
.stat .k{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--fg-3)}
.stat .v{font-size:27px;font-weight:600;letter-spacing:-.025em;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--fg)}
.stat .v small{font-size:14px;font-weight:500;color:var(--fg-3);letter-spacing:0;margin-left:2px}
.stat .sub{font-size:12px;color:var(--fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat .bar{height:4px;border-radius:2px;background:var(--surface-3);margin-top:9px;overflow:hidden}
.stat .bar i{display:block;height:100%;border-radius:2px;background:var(--ok);transition:width .4s ease}
.stat.tone-ok .v{color:var(--ok)}.stat.tone-warn .v{color:var(--warn)}.stat.tone-risk .v{color:var(--risk)}
.stat.tone-warn .bar i{background:var(--warn)}.stat.tone-risk .bar i{background:var(--risk)}
.stat.tone-muted .v{color:var(--fg-3)}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.filters + .filters{margin-top:8px}
.flabel{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-3);margin-right:2px}
.search{position:relative;flex:1 1 240px;min-width:200px;max-width:380px}
.search input{width:100%;height:30px;padding:0 30px 0 32px;border-radius:8px;border:1px solid var(--line-2);background:var(--surface);color:var(--fg);font:inherit;font-size:13px}
.search input::placeholder{color:var(--fg-3)}
.search input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-bg)}
.search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--fg-3);pointer-events:none}
.search kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--fg-3);border:1px solid var(--line-2);border-radius:4px;padding:0 5px;line-height:16px;pointer-events:none}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface);color:var(--fg-2);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s,color .12s,border-color .12s,box-shadow .12s}
.chip:hover{border-color:var(--fg-3);color:var(--fg)}
.chip[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.chip[aria-pressed="true"] .dot{background:currentColor}
.chip .n{font-variant-numeric:tabular-nums;opacity:.65}
.chip .dot{width:7px;height:7px;border-radius:50%;background:var(--d,var(--fg-3));flex:none}
.chip.mono{font-family:var(--mono);font-size:11.5px}
.chip.reset{border-style:dashed}
.progress{display:flex;align-items:center;gap:10px;margin-left:auto;font-size:12px;color:var(--fg-2);font-variant-numeric:tabular-nums}
.progress .bar{width:140px;height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden}
.progress .bar i{display:block;height:100%;background:var(--accent);border-radius:3px;transition:width .25s ease}
.progress.done .bar i{background:var(--ok)}
.progress.done{color:var(--ok)}

/* ---------- layout ---------- */
.layout{max-width:1440px;margin:0 auto;padding:22px 28px 60px;display:grid;grid-template-columns:296px minmax(0,1fr);gap:28px;align-items:start}
.rail{position:sticky;top:calc(var(--top-h) + 18px);max-height:calc(100vh - var(--top-h) - 30px);overflow:auto;padding:2px 4px 8px 2px;scrollbar-width:thin;min-width:0}
.main{min-width:0}
.rail h2,.sec-title{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--fg-3);margin:0 0 10px}
.timeline{list-style:none;margin:0;padding:0;position:relative}
.timeline::before{content:"";position:absolute;left:11px;top:10px;bottom:14px;width:2px;background:var(--line)}
.tl{position:relative;padding-left:30px;margin:0 0 8px}
.tl::before{content:"";position:absolute;left:7px;top:15px;width:10px;height:10px;border-radius:50%;background:var(--bg);border:2px solid var(--line-2);z-index:1}
.tl[data-harness]::before{border-color:var(--h)}
.tl.is-active::before{background:var(--accent);border-color:var(--accent)}
.tl.all::before{border-style:dashed}
.tl.unattr::before{border-color:var(--warn)}
.tlb{display:block;width:100%;text-align:left;background:var(--surface);border:0;border-radius:var(--radius);box-shadow:var(--shadow);padding:10px 12px 10px;cursor:pointer;transition:box-shadow .12s,transform .12s}
.tlb:hover{box-shadow:var(--shadow-hover)}
.is-active .tlb{box-shadow:0 0 0 2px var(--accent)}
.tl-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--fg-3);margin-bottom:6px;font-variant-numeric:tabular-nums}
.tl-meta .time{margin-left:auto}
.tl-text{font-size:13px;line-height:1.45;color:var(--fg);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.tl-foot{display:flex;gap:10px;margin-top:8px;font-size:11.5px;color:var(--fg-2);font-variant-numeric:tabular-nums}
.tl-foot .r{color:var(--risk);font-weight:600}
.tl-foot .w{color:var(--warn);font-weight:600}
.tl-foot .muted{color:var(--fg-3)}
.tl.all .tl-text,.tl.unattr .tl-text{font-weight:600;font-size:12.5px}

/* ---------- harness + badges ---------- */
[data-harness="claude-code"]{--h:var(--claude)}[data-harness="codex"]{--h:var(--codex)}[data-harness="opencode"]{--h:var(--opencode)}
.harness{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:1px 8px 1px 6px;border-radius:999px;background:color-mix(in srgb,var(--h,var(--info)) 13%,transparent);color:var(--h,var(--info));white-space:nowrap}
.harness::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}

/* ---------- groups ---------- */
.group{margin-bottom:40px;scroll-margin-top:calc(var(--top-h) + 16px)}
.group-head{margin-bottom:14px}
.group-meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:12px;color:var(--fg-2);margin-bottom:8px;font-variant-numeric:tabular-nums}
.group-meta .idx{font-weight:600;color:var(--fg)}
.group-meta .flag{color:var(--risk);font-weight:600}
.bubble{position:relative;margin:0;background:var(--surface);border-radius:14px 14px 14px 4px;box-shadow:var(--shadow);padding:12px 16px;max-width:820px;font-size:14.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg)}
.bubble::before{content:"";position:absolute;left:-1px;bottom:-1px;width:10px;height:10px;background:var(--surface);clip-path:polygon(0 100%,100% 100%,100% 0);box-shadow:var(--shadow)}
.bubble.sys{font-style:italic;color:var(--fg-2);border-radius:var(--radius)}
.bubble.sys::before{display:none}
.group-empty{font-size:13px;color:var(--fg-3);padding:4px 2px}
.results{font-size:12.5px;color:var(--fg-2);margin:0 0 14px;display:flex;align-items:center;gap:10px}
.results .cnt{font-variant-numeric:tabular-nums;color:var(--fg);font-weight:600}
.empty{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:40px 20px;text-align:center;color:var(--fg-2)}
.empty b{display:block;color:var(--fg);font-size:15px;margin-bottom:4px}

/* ---------- hunk card ---------- */
.hunk{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);margin:0 0 12px;overflow:hidden;transition:box-shadow .12s,opacity .15s;scroll-margin-top:calc(var(--top-h) + 16px);outline:none}
.hunk:hover{box-shadow:var(--shadow-hover)}
.hunk.is-current,.hunk:focus-visible{box-shadow:0 0 0 2px var(--accent),var(--shadow)}
.hunk.is-reviewed{opacity:.6}
.hunk.is-reviewed:hover,.hunk.is-reviewed.is-current,.hunk.is-reviewed:focus-within{opacity:1}
.hunk-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;border-bottom:1px solid var(--line)}
.check{display:inline-flex;align-items:center;cursor:pointer;flex:none}
.check input{width:16px;height:16px;margin:0;accent-color:var(--accent);cursor:pointer}
.path{font-family:var(--mono);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.path .dir{color:var(--fg-3)}.path .base{color:var(--fg);font-weight:600}
.path .old{color:var(--fg-3);text-decoration:line-through;margin-right:6px}
.status{font-size:10px;letter-spacing:.07em;text-transform:uppercase;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--surface-2);color:var(--fg-2)}
.status.added{color:var(--ok)}.status.deleted{color:var(--risk)}.status.renamed{color:var(--accent)}
.range{font-family:var(--mono);font-size:12px;color:var(--fg-2);white-space:nowrap}
.counts{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.counts .a{color:var(--ok)}.counts .d{color:var(--risk);margin-left:6px}
.spacer{flex:1 1 auto}
.verdict{font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid transparent;white-space:nowrap;letter-spacing:.01em}
.verdict.requested{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.verdict.implied{color:var(--accent);background:var(--accent-bg)}
.verdict.unrequested{color:#fff;background:var(--risk)}
.verdict.unclear{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.verdict.none{color:var(--fg-3);border-color:var(--line-2)}
.hunk-sub{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 14px;border-bottom:1px solid var(--line);font-size:12px;color:var(--fg-2);background:color-mix(in srgb,var(--surface-2) 55%,transparent)}
.match{display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.match .mdot{width:7px;height:7px;border-radius:50%;background:var(--fg-3)}
.match .mdot.exact{background:var(--ok)}.match .mdot.partial,.match .mdot.file-only{background:var(--warn)}.match .mdot.none{background:var(--risk)}
.cov{width:72px;height:5px;border-radius:3px;background:var(--surface-3);overflow:hidden;box-shadow:inset 0 0 0 1px var(--line)}
.cov i{display:block;height:100%;background:var(--ok);border-radius:3px}
.cov.partial i,.cov.file-only i{background:var(--warn)}.cov.none i{background:var(--risk)}
.label{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap}
.label::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.label.risk{color:var(--risk);background:color-mix(in srgb,var(--risk) 11%,transparent)}
.label.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 13%,transparent)}
.label.info{color:var(--fg-2);background:var(--surface-3)}
.edit-meta{margin-left:auto;font-size:11.5px;color:var(--fg-3);white-space:nowrap}
.edit-meta code{font-size:11px;color:var(--fg-2)}
.flags{margin:0;padding:8px 14px 2px;list-style:none;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
.flags li{display:flex;gap:8px;font-size:12.5px;line-height:1.45;padding-bottom:6px}
.flags .k{font-family:var(--mono);font-size:11.5px;white-space:nowrap;font-weight:600}
.flags .risk .k{color:var(--risk)}.flags .warn .k{color:var(--warn)}
.flags .d{color:var(--fg-2)}
.notes{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:0;border-bottom:1px solid var(--line)}
.notes.single{grid-template-columns:1fr}
.note{padding:10px 14px;min-width:0}
.note + .note{border-left:1px solid var(--line)}
.note .nk{font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--fg-3);margin-bottom:4px;display:flex;gap:6px;align-items:center}
.note .nk .m{font-weight:500;text-transform:none;letter-spacing:0;font-family:var(--mono);font-size:10.5px}
.note q{font-size:13px;line-height:1.5;color:var(--fg);quotes:"\\201C" "\\201D"}
.note q::before,.note q::after{color:var(--fg-3)}
.note .cmd{display:inline-block;margin-top:6px;font-family:var(--mono);font-size:12px;background:var(--surface-2);padding:4px 9px;border-radius:6px;color:var(--fg)}
.note .cmd::before{content:"$ ";color:var(--fg-3)}
.note .reason{font-size:13px;line-height:1.5;color:var(--fg-2)}
details.diff>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:7px 14px;font-family:var(--mono);font-size:11.5px;color:var(--fg-3);user-select:none}
details.diff>summary::-webkit-details-marker{display:none}
details.diff>summary::before{content:"";width:0;height:0;border-left:5px solid var(--fg-3);border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .12s;flex:none}
details.diff[open]>summary::before{transform:rotate(90deg)}
details.diff>summary .hdr{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.diff>summary .ln-n{margin-left:auto;white-space:nowrap}
.code{font-family:var(--mono);font-size:12px;line-height:1.6;overflow-x:auto;border-top:1px solid var(--line);tab-size:2}
.ln{display:grid;grid-template-columns:46px 46px 18px minmax(0,1fr);min-width:max-content}
.ln .no{text-align:right;padding:0 8px 0 4px;color:var(--fg-3);user-select:none;font-size:11px;background:var(--surface-2)}
.ln .sign{text-align:center;user-select:none;color:var(--fg-3)}
.ln pre{margin:0;font:inherit;white-space:pre;padding-right:18px}
.ln.add{background:var(--add-bg)}.ln.add .no{background:var(--add-gut)}.ln.add .sign{color:var(--add-fg);font-weight:600}
.ln.del{background:var(--del-bg)}.ln.del .no{background:var(--del-gut)}.ln.del .sign{color:var(--del-fg);font-weight:600}
.more{display:block;width:100%;border:0;border-top:1px solid var(--line);background:var(--surface-2);color:var(--fg-2);font-size:12px;padding:7px;cursor:pointer}
.more:hover{color:var(--fg)}

/* ---------- footer + help ---------- */
.foot{max-width:1440px;margin:0 auto;padding:0 28px 40px;color:var(--fg-3);font-size:12px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
kbd{display:inline-block;min-width:18px;padding:0 5px;border-radius:4px;border:1px solid var(--line-2);border-bottom-width:2px;background:var(--surface);font-size:11px;line-height:18px;text-align:center;color:var(--fg-2)}
.help{border:0;border-radius:14px;padding:0;background:var(--surface);color:var(--fg);box-shadow:0 0 0 1px var(--line),0 24px 60px rgba(0,0,0,.25);width:min(440px,92vw)}
.help::backdrop{background:rgba(10,10,14,.45);backdrop-filter:blur(2px)}
.help-in{padding:18px 20px 20px}
.help h2{margin:0 0 12px;font-size:15px;display:flex;align-items:center}
.help h2 button{margin-left:auto}
.help table{width:100%;border-collapse:collapse;font-size:13px}
.help td{padding:6px 0;border-top:1px solid var(--line)}
.help td:first-child{width:80px;color:var(--fg-2)}
.help p{margin:12px 0 0;font-size:12px;color:var(--fg-3)}

/* ---------- responsive ---------- */
@media (max-width:1040px){
  .layout{grid-template-columns:minmax(0,1fr);gap:18px}
  .rail{position:static;max-height:none;overflow:visible;min-width:0}
  .main{min-width:0}
  .timeline{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 10px;scroll-snap-type:x proximity}
  .timeline::before{display:none}
  .tl{padding-left:0;margin:0;flex:0 0 250px;scroll-snap-align:start}
  .tl::before{display:none}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:640px){
  .top-inner,.toolbar-inner,.layout,.foot{padding-left:16px;padding-right:16px}
  .stat .v{font-size:22px}
  .notes{grid-template-columns:1fr}
  .note + .note{border-left:0;border-top:1px solid var(--line)}
  .progress{margin-left:0;width:100%}
  .progress .bar{flex:1}
  .edit-meta{margin-left:0}
  .brand .word{display:none}
}
@media print{
  .toolbar{position:static}.rail,.filters,.ibtn,.check,.skip{display:none!important}
  .layout{display:block}.hunk{break-inside:avoid;box-shadow:none;border:1px solid #ccc}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;

const APP_JS = `
(function () {
  'use strict';
  var root = document.documentElement;
  var payload = JSON.parse(document.getElementById('why-diff-data').textContent);
  var R = payload.report, HASH = payload.hash;
  var LS_REV = 'why-diff:reviewed:' + HASH, LS_THEME = 'why-diff:theme';
  var NS = 'http://www.w3.org/2000/svg';

  // ---------- tiny DOM helpers: text nodes and attributes only, no HTML strings ----------
  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  function add(parent, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(parent, c[i]); return; }
    if (typeof c === 'string' || typeof c === 'number') parent.appendChild(document.createTextNode(String(c)));
    else parent.appendChild(c);
  }
  function icon(paths, size) {
    var s = document.createElementNS(NS, 'svg');
    size = size || 15;
    s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    (Array.isArray(paths) ? paths : [paths]).forEach(function (d) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    return s;
  }
  var ICON = {
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'],
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    auto: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 3v18', 'M12 7a5 5 0 0 1 0 10'],
    help: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
    close: 'M18 6 6 18M6 6l12 12'
  };
  function logo() {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '20'); s.setAttribute('height', '20'); s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
    var rows = [[3, 11, 'var(--fg-3)'], [7, 14, 'var(--ok)'], [11, 8, 'var(--risk)'], [15, 12, 'var(--fg-3)']];
    rows.forEach(function (r) {
      var rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', '3'); rect.setAttribute('y', r[0]); rect.setAttribute('width', r[1]); rect.setAttribute('height', '2.4'); rect.setAttribute('rx', '1.2'); rect.setAttribute('fill', r[2]);
      s.appendChild(rect);
    });
    return s;
  }

  // ---------- formatting ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(iso) { var d = new Date(iso); return isNaN(d) ? iso : pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(iso) { var d = new Date(iso); return isNaN(d) ? iso : d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function fmtDateTime(iso) { return fmtDate(iso) + ', ' + fmtTime(iso) + ' UTC'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function counts(h) { var a = 0, d = 0; for (var i = 0; i < h.lines.length; i++) { if (h.lines[i].type === 'add') a++; else if (h.lines[i].type === 'del') d++; } return { added: a, removed: d }; }
  function range(h) {
    var start = h.status === 'deleted' ? h.oldStart : h.newStart, len = h.status === 'deleted' ? h.oldLines : h.newLines;
    return len <= 1 ? 'L' + start : 'L' + start + '\\u2013' + (start + len - 1);
  }
  var SEV = { risk: 0, warn: 1, info: 2 };
  function sortLabels(ls) { return ls.slice().sort(function (a, b) { return SEV[a.severity] - SEV[b.severity] || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0); }); }
  function isRisky(a) { return a.labels.some(function (l) { return l.severity === 'risk'; }) || (a.intent && a.intent.verdict === 'unrequested'); }
  function harnessOf(a) { return a.prompt ? a.prompt.harness : (a.edits[0] ? a.edits[0].harness : null); }
  // Hunks carry text-free edit refs; the full (2 KB-capped) record sits in R.edits.
  function fullEdit(ref) { return (R.edits && R.edits[ref.id]) || ref; }
  function sessionsText() {
    var found = S.sessionsFound === undefined ? S.sessions : S.sessionsFound;
    if (S.sessions > 0) return plural(S.sessions, 'session') + ' \\u00b7 ' + plural(S.prompts, 'prompt');
    if (found > 0) return 'no agent session contributed to this diff (' + plural(found, 'session') + ' found)';
    return 'no agent sessions found: check the harness, the time window (--since), pass --session, or try --scan-all';
  }

  // ---------- grouping ----------
  var prompts = R.prompts.slice().sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : a.index - b.index; });
  var groups = [], byPrompt = {}, unattributed = [];
  prompts.forEach(function (p) { var g = { prompt: p, hunks: [] }; byPrompt[p.id] = g; groups.push(g); });
  R.hunks.forEach(function (a) {
    var pid = a.prompt && a.prompt.id;
    if (!pid) { unattributed.push(a); return; }
    var g = byPrompt[pid];
    if (!g) { g = { prompt: a.prompt, hunks: [] }; byPrompt[pid] = g; groups.push(g); }
    g.hunks.push(a);
  });
  var allHunks = R.hunks;
  var S = R.summary;
  var tracedPct = S.addedLines > 0 ? Math.round(S.agentLines / S.addedLines * 100) : 0;
  var intentRan = !!S.intent || allHunks.some(function (a) { return a.intent; });
  var classifierModel = (function () { for (var i = 0; i < allHunks.length; i++) if (allHunks[i].intent) return allHunks[i].intent.model; return null; })();
  var verdictCounts = { requested: 0, implied: 0, unrequested: 0, unclear: 0 };
  var labelCounts = {}, labelSev = {}, harnessCounts = {};
  allHunks.forEach(function (a) {
    if (a.intent) verdictCounts[a.intent.verdict]++;
    a.labels.forEach(function (l) { labelCounts[l.kind] = (labelCounts[l.kind] || 0) + 1; labelSev[l.kind] = l.severity; });
    var hz = harnessOf(a); if (hz) harnessCounts[hz] = (harnessCounts[hz] || 0) + 1;
  });
  var riskyCount = allHunks.filter(isRisky).length;
  var searchIndex = {};
  allHunks.forEach(function (a) {
    var parts = [a.hunk.file, a.hunk.oldFile || '', a.match, a.labels.map(function (l) { return l.kind + ' ' + l.detail; }).join(' '), a.prompt ? a.prompt.text : 'unattributed'];
    a.edits.forEach(function (e) { var f = fullEdit(e); parts.push(f.rationale || '', f.command || '', f.tool); });
    if (a.intent) parts.push(a.intent.verdict, a.intent.reason);
    a.hunk.lines.forEach(function (l) { parts.push(l.text); });
    searchIndex[a.hunk.id] = parts.join('\\n').toLowerCase();
  });

  // ---------- persisted state ----------
  var reviewed = {};
  try { (JSON.parse(localStorage.getItem(LS_REV) || '[]') || []).forEach(function (id) { reviewed[id] = true; }); } catch (e) {}
  function saveReviewed() { try { localStorage.setItem(LS_REV, JSON.stringify(Object.keys(reviewed))); } catch (e) {} }
  function hashTokens() { return location.hash.slice(1).split(',').filter(Boolean); }
  var themeMode = (function () {
    var ks = hashTokens();
    if (ks.indexOf('dark') >= 0) return 'dark';
    if (ks.indexOf('light') >= 0) return 'light';
    try { var t = localStorage.getItem(LS_THEME); if (t === 'dark' || t === 'light') return t; } catch (e) {}
    return 'system';
  })();

  var state = { q: '', labels: {}, verdicts: {}, harness: {}, risksOnly: hashTokens().indexOf('risks') >= 0, hideReviewed: false, promptId: null };
  var cards = {}; // hunk id -> element
  var order = []; // hunk ids in document order
  var current = null;

  // ---------- top strip ----------
  var top = document.getElementById('top');
  var themeBtn, searchEl, progressEl, chipEls = [];
  function renderTop() {
    var inner = el('div', { class: 'top-inner' });
    var brand = el('div', { class: 'brand' }, logo(), el('span', { class: 'word', text: 'why-diff' }));
    var crumbs = el('div', { class: 'crumbs' },
      el('code', { text: R.repo.name }),
      R.repo.branch ? [el('span', { class: 'sep', text: '/' }), el('code', { text: R.repo.branch })] : null,
      el('span', { class: 'sep', text: '\\u00b7' }),
      el('code', { text: R.range }),
      el('span', { class: 'sep', text: '\\u00b7' }),
      el('span', { text: plural(S.hunks, 'hunk') + ' in ' + plural(S.files, 'file') + ' \\u00b7 ' + sessionsText() })
    );
    themeBtn = el('button', { class: 'ibtn', type: 'button', onclick: cycleTheme });
    var helpBtn = el('button', { class: 'ibtn', type: 'button', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: openHelp }, icon(ICON.help), el('kbd', { text: '?' }));
    inner.appendChild(el('div', { class: 'brand-row' }, brand, crumbs, el('div', { class: 'top-actions' }, themeBtn, helpBtn)));

    // stats
    var noAdded = S.addedLines === 0;
    var tone = noAdded ? 'ok' : tracedPct >= 90 ? 'ok' : tracedPct >= 60 ? 'warn' : 'risk';
    var stats = el('div', { class: 'stats', role: 'group', 'aria-label': 'Headline numbers' });
    stats.appendChild(stat('Agent-traced', noAdded ? 'n/a' : tracedPct + '%', S.agentLines + ' of ' + S.addedLines + ' added lines explained by an agent edit', tone, tracedPct));
    if (intentRan) {
      var classified = allHunks.filter(function (a) { return a.intent; }).length;
      stats.appendChild(stat('Unrequested', String(verdictCounts.unrequested), (verdictCounts.unrequested === 0 ? 'nothing the prompts did not ask for' : plural(verdictCounts.unrequested, 'hunk') + ' nobody asked for') + ' \\u00b7 ' + classified + ' of ' + allHunks.length + ' classified', verdictCounts.unrequested > 0 ? 'risk' : 'ok'));
    } else {
      stats.appendChild(stat('Unrequested', '\\u2014', 'intent check not run (pass --classify)', 'muted'));
    }
    var testKinds = [];
    if (S.labels['test-skip-added']) testKinds.push('skip added');
    if (S.labels['assertion-removed']) testKinds.push('assertion weakened');
    if (S.labels['snapshot-updated']) testKinds.push('snapshot updated');
    if (S.labels['test-modified']) testKinds.push(plural(S.labels['test-modified'], 'test file') + ' changed');
    stats.appendChild(stat('Tests touched', S.touchedTests ? 'Yes' : 'No', S.touchedTests ? testKinds.join(' \\u00b7 ') : 'no test files in this diff', S.touchedTests ? (S.labels['test-skip-added'] || S.labels['assertion-removed'] ? 'risk' : 'warn') : 'ok'));
    var unattrFiles = {}; unattributed.forEach(function (a) { unattrFiles[a.hunk.file] = 1; });
    var uf = Object.keys(unattrFiles);
    stats.appendChild(stat('Unattributed', String(S.unattributedLines), S.unattributedLines === 0 ? 'every added line traces to an agent edit' : plural(S.unattributedLines, 'added line') + (uf.length ? ' \\u00b7 ' + uf.join(', ') : ' outside agent edits'), S.unattributedLines > 0 ? 'warn' : 'ok'));
    inner.appendChild(stats);
    top.appendChild(inner);
    var bar = el('div', { class: 'toolbar' });
    var tinner = el('div', { class: 'toolbar-inner' });
    bar.appendChild(tinner);
    top.appendChild(bar);
    inner = tinner;

    // filters row 1
    var f1 = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filters' });
    searchEl = el('input', { type: 'search', placeholder: 'Search files, code, rationale\\u2026', 'aria-label': 'Search hunks', autocomplete: 'off', spellcheck: 'false' });
    searchEl.addEventListener('input', function () { state.q = searchEl.value.trim().toLowerCase(); applyFilters(); });
    f1.appendChild(el('div', { class: 'search' }, icon(ICON.search, 14), searchEl, el('kbd', { text: '/' })));
    f1.appendChild(chip('Risks only', riskyCount, function () { return state.risksOnly; }, function () { state.risksOnly = !state.risksOnly; }, 'var(--risk)'));
    if (intentRan) ['unrequested', 'unclear', 'implied', 'requested'].forEach(function (v) {
      if (!verdictCounts[v]) return;
      f1.appendChild(chip(v, verdictCounts[v], function () { return !!state.verdicts[v]; }, function () { state.verdicts[v] = !state.verdicts[v]; }, verdictColor(v)));
    });
    var hz = Object.keys(harnessCounts);
    if (hz.length > 1) hz.forEach(function (name) {
      f1.appendChild(chip(name, harnessCounts[name], function () { return !!state.harness[name]; }, function () { state.harness[name] = !state.harness[name]; }, 'var(--h)', { 'data-harness': name }));
    });
    f1.appendChild(chip('Hide reviewed', null, function () { return state.hideReviewed; }, function () { state.hideReviewed = !state.hideReviewed; }));
    var resetBtn = el('button', { class: 'chip reset', type: 'button', text: 'Clear filters', onclick: resetFilters });
    resetBtn.dataset.reset = '1';
    f1.appendChild(resetBtn);
    progressEl = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(allHunks.length), 'aria-label': 'Reviewed hunks' }, el('span', { class: 'txt' }), el('span', { class: 'bar' }, el('i')));
    inner.appendChild(f1);

    // filters row 2: labels
    var kinds = Object.keys(labelCounts).sort(function (a, b) { return SEV[labelSev[a]] - SEV[labelSev[b]] || (a < b ? -1 : 1); });
    if (kinds.length) {
      var f2 = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by label' }, el('span', { class: 'flabel', text: 'Labels' }));
      kinds.forEach(function (k) {
        f2.appendChild(chip(k, labelCounts[k], function () { return !!state.labels[k]; }, function () { state.labels[k] = !state.labels[k]; }, labelSev[k] === 'risk' ? 'var(--risk)' : labelSev[k] === 'warn' ? 'var(--warn)' : 'var(--fg-3)', { class: 'chip mono' }));
      });
      f2.appendChild(progressEl);
      inner.appendChild(f2);
    } else {
      f1.appendChild(progressEl);
    }
    updateThemeBtn();
  }
  function stat(k, v, sub, tone, barPct) {
    var node = el('div', { class: 'stat tone-' + tone }, el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }), el('div', { class: 'sub', text: sub, title: sub }));
    if (typeof barPct === 'number') { var bar = el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i')); bar.firstChild.style.width = Math.max(0, Math.min(100, barPct)) + '%'; node.appendChild(bar); }
    return node;
  }
  function verdictColor(v) { return v === 'requested' ? 'var(--ok)' : v === 'implied' ? 'var(--accent)' : v === 'unrequested' ? 'var(--risk)' : 'var(--warn)'; }
  function chip(label, count, isOn, toggle, dotColor, extra) {
    var attrs = { class: 'chip', type: 'button', 'aria-pressed': isOn() ? 'true' : 'false' };
    if (extra) for (var k in extra) attrs[k] = extra[k];
    var dot = dotColor ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null;
    if (dot) dot.style.setProperty('--d', dotColor);
    var b = el('button', attrs, dot, el('span', { text: label }), count !== null && count !== undefined ? el('span', { class: 'n', text: String(count) }) : null);
    b.addEventListener('click', function () { toggle(); applyFilters(); });
    chipEls.push({ el: b, isOn: isOn });
    return b;
  }

  // ---------- theme ----------
  function applyTheme(mode, persist) {
    themeMode = mode;
    if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    if (persist) { try { if (mode === 'system') localStorage.removeItem(LS_THEME); else localStorage.setItem(LS_THEME, mode); } catch (e) {} }
    updateThemeBtn();
  }
  function cycleTheme() { applyTheme(themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system', true); }
  function updateThemeBtn() {
    if (!themeBtn) return;
    while (themeBtn.firstChild) themeBtn.removeChild(themeBtn.firstChild);
    var lbl = themeMode === 'system' ? 'Auto' : themeMode === 'light' ? 'Light' : 'Dark';
    themeBtn.appendChild(icon(themeMode === 'system' ? ICON.auto : themeMode === 'light' ? ICON.sun : ICON.moon));
    themeBtn.appendChild(el('span', { class: 'lbl', text: lbl }));
    themeBtn.setAttribute('aria-label', 'Theme: ' + lbl + '. Click to change');
    themeBtn.title = 'Theme: ' + lbl;
  }

  // ---------- rail ----------
  var rail = document.getElementById('rail');
  var railItems = {};
  function renderRail() {
    rail.appendChild(el('h2', { text: 'Prompts' }));
    var list = el('ol', { class: 'timeline' });
    list.appendChild(railItem(null, 'all', 'All prompts', plural(allHunks.length, 'hunk'), riskyCount ? el('span', { class: 'r', text: plural(riskyCount, 'flagged', 'flagged') }) : null, null));
    groups.forEach(function (g, i) {
      var p = g.prompt, risky = g.hunks.filter(isRisky).length;
      var ac = 0; g.hunks.forEach(function (a) { ac += counts(a.hunk).added; });
      var foot = [el('span', { text: g.hunks.length ? plural(g.hunks.length, 'hunk') : 'no hunks' }), g.hunks.length ? el('span', { class: 'muted', text: '+' + ac }) : null, risky ? el('span', { class: 'r', text: risky + ' flagged' }) : null];
      list.appendChild(railItem(p.id, null, p.text, null, foot, p, i + 1));
    });
    if (unattributed.length) list.appendChild(railItem('__unattributed', 'unattr', 'Unattributed', plural(unattributed.length, 'hunk'), el('span', { class: 'w', text: 'no agent edit' }), null));
    rail.appendChild(list);
  }
  function railItem(id, kind, text, sub, foot, prompt, idx) {
    var li = el('li', { class: 'tl' + (kind ? ' ' + kind : '') });
    if (prompt) li.setAttribute('data-harness', prompt.harness);
    var meta = prompt
      ? el('div', { class: 'tl-meta' }, el('span', { class: 'harness', text: prompt.harness }), el('span', { text: '#' + idx }), el('span', { class: 'time', text: fmtTime(prompt.at) }))
      : null;
    var btn = el('button', { class: 'tlb', type: 'button', 'aria-pressed': 'false' }, meta, el('div', { class: 'tl-text', text: text }), el('div', { class: 'tl-foot' }, sub ? el('span', { text: sub }) : null, foot));
    btn.addEventListener('click', function () {
      state.promptId = state.promptId === id ? null : id;
      applyFilters();
      var target = id === null ? document.getElementById('main') : document.getElementById(id === '__unattributed' ? 'group-unattributed' : 'group-' + slug(id));
      if (target && state.promptId !== null) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (id === null) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    li.appendChild(btn);
    railItems[id === null ? '__all' : id] = li;
    return li;
  }
  function slug(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }

  // ---------- main ----------
  var main = document.getElementById('main');
  var resultsEl, emptyEl;
  function renderMain() {
    resultsEl = el('p', { class: 'results', 'aria-live': 'polite' }, el('span', { class: 'cnt' }), el('span', { class: 'ctx' }));
    main.appendChild(resultsEl);
    groups.forEach(function (g, i) { main.appendChild(renderGroup(g, i + 1)); });
    if (unattributed.length) {
      var sec = el('section', { class: 'group', id: 'group-unattributed', 'aria-labelledby': 'gh-unattributed' });
      sec.appendChild(el('header', { class: 'group-head' },
        el('div', { class: 'group-meta' }, el('span', { class: 'idx', id: 'gh-unattributed', text: 'Unattributed' }), el('span', { text: plural(unattributed.length, 'hunk') }), el('span', { class: 'flag', text: 'no agent edit explains these' })),
        el('blockquote', { class: 'bubble sys', text: 'A human change, a tool outside the recorded sessions, or a generated file. Review these by hand.' })));
      unattributed.forEach(function (a) { sec.appendChild(renderHunk(a)); });
      main.appendChild(sec);
    }
    emptyEl = el('div', { class: 'empty', hidden: true }, el('b', { text: 'No hunks match these filters' }), el('span', { text: 'Try clearing a chip or the search box.' }), el('div', null, el('button', { class: 'chip reset', type: 'button', text: 'Clear filters', onclick: resetFilters, style: 'margin-top:12px' })));
    main.appendChild(emptyEl);
  }
  function renderGroup(g, idx) {
    var p = g.prompt;
    var sec = el('section', { class: 'group', id: 'group-' + slug(p.id), 'aria-labelledby': 'gh-' + slug(p.id), 'data-harness': p.harness });
    var ac = 0, dc = 0; g.hunks.forEach(function (a) { var c = counts(a.hunk); ac += c.added; dc += c.removed; });
    var risky = g.hunks.filter(isRisky).length;
    var meta = el('div', { class: 'group-meta' },
      el('span', { class: 'idx', text: 'Prompt ' + idx }),
      el('span', { class: 'harness', text: p.harness }),
      el('span', { text: fmtDateTime(p.at) }),
      el('span', { text: 'session ' + p.sessionId.slice(0, 8) }),
      el('span', { text: g.hunks.length ? plural(g.hunks.length, 'hunk') + ' \\u00b7 +' + ac + ' \\u2212' + dc : 'no hunks in this diff' }),
      risky ? el('span', { class: 'flag', text: risky + ' flagged' }) : null);
    sec.appendChild(el('header', { class: 'group-head' }, meta, el('blockquote', { class: 'bubble', id: 'gh-' + slug(p.id), text: p.text })));
    if (!g.hunks.length) sec.appendChild(el('p', { class: 'group-empty', text: 'This prompt produced no changes in the diffed range.' }));
    g.hunks.forEach(function (a) { sec.appendChild(renderHunk(a)); });
    return sec;
  }
  function splitPath(f) { var i = f.lastIndexOf('/'); return i < 0 ? ['', f] : [f.slice(0, i + 1), f.slice(i + 1)]; }
  var MAX_LINES = 80, SHOW_LINES = 50;
  function renderHunk(a) {
    var h = a.hunk, c = counts(h), id = h.id;
    var card = el('article', { class: 'hunk', id: 'hunk-' + slug(id), tabindex: '0', 'data-id': id, 'aria-label': h.file + ' ' + range(h) });
    card.addEventListener('focus', function () { setCurrent(id, false); });
    var cb = el('input', { type: 'checkbox', 'aria-label': 'Mark as reviewed' });
    cb.checked = !!reviewed[id];
    cb.addEventListener('change', function () { setReviewed(id, cb.checked); });
    var sp = splitPath(h.file);
    var path = el('span', { class: 'path', title: h.file });
    if (h.status === 'renamed' && h.oldFile) path.appendChild(el('span', { class: 'old', text: h.oldFile }));
    path.appendChild(el('span', { class: 'dir', text: sp[0] })); path.appendChild(el('span', { class: 'base', text: sp[1] }));
    var verdict = a.intent ? a.intent.verdict : 'none';
    var head = el('div', { class: 'hunk-head' },
      el('label', { class: 'check', title: 'Reviewed (x)' }, cb),
      path,
      el('span', { class: 'status ' + h.status, text: h.status }),
      el('span', { class: 'range', text: range(h) }),
      el('span', { class: 'counts' }, el('span', { class: 'a', text: '+' + c.added }), c.removed ? el('span', { class: 'd', text: '\\u2212' + c.removed }) : null),
      el('span', { class: 'spacer' }),
      el('span', { class: 'verdict ' + verdict, title: a.intent ? a.intent.reason : 'Intent check not run', text: a.intent ? verdict : 'no verdict' }));
    card.appendChild(head);

    var pctv = Math.round((a.coverage || 0) * 100);
    var cov = el('span', { class: 'cov ' + a.match, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pctv), 'aria-label': 'Coverage ' + pctv + '%' }, el('i'));
    cov.firstChild.style.width = pctv + '%';
    var matchText = a.match === 'none' ? 'no match' : a.match === 'file-only' ? 'file match only' : a.match + ' match';
    var sub = el('div', { class: 'hunk-sub' }, el('span', { class: 'match', title: 'How confidently this hunk maps to an agent edit' }, el('span', { class: 'mdot ' + a.match }), el('span', { text: matchText }), cov, el('span', { text: pctv + '%' })));
    var labels = sortLabels(a.labels);
    labels.forEach(function (l) { sub.appendChild(el('span', { class: 'label ' + l.severity, title: l.detail, text: l.kind })); });
    var last = a.edits.length ? fullEdit(a.edits[a.edits.length - 1]) : null;
    if (last) sub.appendChild(el('span', { class: 'edit-meta' }, el('code', { text: last.tool }), ' \\u00b7 ' + fmtTime(last.at) + ' \\u00b7 ' + last.harness + (a.edits.length > 1 ? ' \\u00b7 ' + plural(a.edits.length, 'edit') : '')));
    card.appendChild(sub);

    var flagged = labels.filter(function (l) { return l.severity !== 'info'; });
    if (flagged.length) {
      var ul = el('ul', { class: 'flags', 'aria-label': 'Flags' });
      flagged.forEach(function (l) { ul.appendChild(el('li', { class: l.severity }, el('span', { class: 'k', text: l.kind }), el('span', { class: 'd', text: l.detail }))); });
      card.appendChild(ul);
    }

    var agentNote = null;
    if (last && (last.rationale || last.command)) {
      agentNote = el('div', { class: 'note' }, el('div', { class: 'nk' }, 'Agent said', el('span', { class: 'm', text: last.tool + (last.failed ? ' (failed)' : '') })));
      if (last.rationale) agentNote.appendChild(el('q', { text: last.rationale }));
      if (last.command) agentNote.appendChild(el('div', null, el('code', { class: 'cmd', text: last.command })));
    }
    var intentNote = a.intent ? el('div', { class: 'note' }, el('div', { class: 'nk' }, 'Intent check', el('span', { class: 'm', text: a.intent.model })), el('div', { class: 'reason', text: a.intent.reason })) : null;
    if (agentNote || intentNote) card.appendChild(el('div', { class: 'notes' + (agentNote && intentNote ? '' : ' single') }, agentNote, intentNote));

    var det = el('details', { class: 'diff', open: true });
    det.appendChild(el('summary', null, el('span', { class: 'hdr', text: h.header }), el('span', { class: 'ln-n', text: plural(h.lines.length, 'line') })));
    var code = el('div', { class: 'code', role: 'region', 'aria-label': 'Diff for ' + h.file });
    var lines = h.lines, limit = lines.length > MAX_LINES ? SHOW_LINES : lines.length;
    for (var i = 0; i < limit; i++) code.appendChild(diffLine(lines[i]));
    if (limit < lines.length) {
      var more = el('button', { class: 'more', type: 'button', text: 'Show ' + (lines.length - limit) + ' more lines' });
      more.addEventListener('click', function () { for (var j = limit; j < lines.length; j++) code.insertBefore(diffLine(lines[j]), more); more.remove(); });
      code.appendChild(more);
    }
    det.appendChild(code);
    card.appendChild(det);
    if (reviewed[id]) { card.classList.add('is-reviewed'); det.open = false; }
    cards[id] = card; order.push(id);
    return card;
  }
  function diffLine(l) {
    var sign = l.type === 'add' ? '+' : l.type === 'del' ? '\\u2212' : ' ';
    return el('div', { class: 'ln ' + l.type },
      el('span', { class: 'no', text: l.oldNo !== undefined && l.oldNo !== null ? String(l.oldNo) : '' }),
      el('span', { class: 'no', text: l.newNo !== undefined && l.newNo !== null ? String(l.newNo) : '' }),
      el('span', { class: 'sign', 'aria-hidden': 'true', text: sign }),
      el('pre', { text: l.text || ' ' }));
  }

  // ---------- footer + help ----------
  function renderFoot() {
    var f = document.getElementById('foot');
    f.appendChild(el('span', { text: 'why-diff v' + R.version + ' \\u00b7 generated ' + fmtDateTime(R.generatedAt) }));
    f.appendChild(el('span', { text: R.sessions.map(function (s) { return s.harness + ' ' + s.id.slice(0, 8); }).join(' \\u00b7 ') }));
    f.appendChild(el('span', null, el('kbd', { text: 'j' }), ' ', el('kbd', { text: 'k' }), ' move \\u00b7 ', el('kbd', { text: 'x' }), ' reviewed \\u00b7 ', el('kbd', { text: '?' }), ' help'));
  }
  var help = document.getElementById('help');
  function renderHelp() {
    var rows = [['j / k', 'Next / previous hunk'], ['x', 'Toggle reviewed on the current hunk'], ['o', 'Collapse or expand the current diff'], ['r', 'Toggle "Risks only"'], ['/', 'Focus search'], ['Esc', 'Clear focus, close this dialog'], ['?', 'Show this help']];
    var tbl = el('table');
    rows.forEach(function (r) { tbl.appendChild(el('tr', null, el('td', null, el('kbd', { text: r[0] })), el('td', { text: r[1] }))); });
    help.appendChild(el('div', { class: 'help-in' },
      el('h2', { id: 'help-title' }, 'Keyboard shortcuts', el('button', { class: 'ibtn', type: 'button', 'aria-label': 'Close', onclick: function () { help.close(); } }, icon(ICON.close))),
      tbl,
      el('p', { text: 'Reviewed state is stored in this browser only, keyed by the report hash ' + HASH + '.' })));
  }
  function openHelp() { if (typeof help.showModal === 'function') help.showModal(); else help.setAttribute('open', ''); }

  // ---------- filtering ----------
  function matches(a) {
    var id = a.hunk.id;
    if (state.promptId !== null) {
      if (state.promptId === '__unattributed') { if (a.prompt) return false; }
      else if (!a.prompt || a.prompt.id !== state.promptId) return false;
    }
    if (state.risksOnly && !isRisky(a)) return false;
    if (state.hideReviewed && reviewed[id]) return false;
    var ls = Object.keys(state.labels).filter(function (k) { return state.labels[k]; });
    if (ls.length && !a.labels.some(function (l) { return state.labels[l.kind]; })) return false;
    var vs = Object.keys(state.verdicts).filter(function (k) { return state.verdicts[k]; });
    if (vs.length && !(a.intent && state.verdicts[a.intent.verdict])) return false;
    var hs = Object.keys(state.harness).filter(function (k) { return state.harness[k]; });
    if (hs.length && !state.harness[harnessOf(a)]) return false;
    if (state.q && searchIndex[id].indexOf(state.q) < 0) return false;
    return true;
  }
  function anyFilter() {
    return state.q || state.risksOnly || state.hideReviewed || state.promptId !== null ||
      Object.keys(state.labels).some(function (k) { return state.labels[k]; }) ||
      Object.keys(state.verdicts).some(function (k) { return state.verdicts[k]; }) ||
      Object.keys(state.harness).some(function (k) { return state.harness[k]; });
  }
  function applyFilters() {
    var shown = 0;
    allHunks.forEach(function (a) { var ok = matches(a); cards[a.hunk.id].hidden = !ok; if (ok) shown++; });
    var sections = main.querySelectorAll('section.group');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i], vis = s.querySelectorAll('article.hunk:not([hidden])').length;
      var isPromptSel = state.promptId !== null;
      s.hidden = vis === 0 && (isPromptSel || anyFilter() || s.querySelectorAll('article.hunk').length > 0);
    }
    emptyEl.hidden = shown > 0;
    chipEls.forEach(function (c) { c.el.setAttribute('aria-pressed', c.isOn() ? 'true' : 'false'); });
    var resetEl = top.querySelector('[data-reset]'); if (resetEl) resetEl.hidden = !anyFilter();
    for (var k in railItems) railItems[k].classList.toggle('is-active', state.promptId === (k === '__all' ? null : k));
    for (var k2 in railItems) railItems[k2].querySelector('button').setAttribute('aria-pressed', railItems[k2].classList.contains('is-active') ? 'true' : 'false');
    resultsEl.querySelector('.cnt').textContent = shown === allHunks.length ? plural(shown, 'hunk') : shown + ' of ' + allHunks.length + ' hunks';
    resultsEl.querySelector('.ctx').textContent = anyFilter() ? 'match the current filters' : 'in ' + R.range + ', grouped by the prompt that produced them';
    if (current && cards[current].hidden) setCurrent(null, false);
    updateProgress();
  }
  function resetFilters() {
    state = { q: '', labels: {}, verdicts: {}, harness: {}, risksOnly: false, hideReviewed: false, promptId: null };
    searchEl.value = '';
    applyFilters();
  }
  function updateProgress() {
    var n = Object.keys(reviewed).filter(function (id) { return cards[id]; }).length, total = allHunks.length;
    progressEl.setAttribute('aria-valuenow', String(n));
    progressEl.querySelector('.txt').textContent = n === total && total > 0 ? 'All ' + total + ' reviewed' : n + ' / ' + total + ' reviewed';
    progressEl.querySelector('.bar i').style.width = (total ? n / total * 100 : 0) + '%';
    progressEl.classList.toggle('done', n === total && total > 0);
  }

  // ---------- review + keyboard ----------
  function setReviewed(id, on) {
    if (on) reviewed[id] = true; else delete reviewed[id];
    saveReviewed();
    var card = cards[id];
    card.classList.toggle('is-reviewed', on);
    var cb = card.querySelector('input[type=checkbox]'); if (cb.checked !== on) cb.checked = on;
    var det = card.querySelector('details.diff'); if (det) det.open = !on;
    if (state.hideReviewed) applyFilters(); else updateProgress();
  }
  function visibleOrder() { return order.filter(function (id) { return !cards[id].hidden; }); }
  function setCurrent(id, scroll) {
    if (current && cards[current]) cards[current].classList.remove('is-current');
    current = id;
    if (!id) return;
    var card = cards[id];
    card.classList.add('is-current');
    if (scroll) { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card.focus({ preventScroll: true }); }
  }
  function move(delta) {
    var vis = visibleOrder(); if (!vis.length) return;
    var i = vis.indexOf(current);
    var next = i < 0 ? (delta > 0 ? 0 : vis.length - 1) : Math.max(0, Math.min(vis.length - 1, i + delta));
    setCurrent(vis[next], true);
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, tag = (t && t.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable);
    if (typing) { if (e.key === 'Escape') { if (t === searchEl && searchEl.value) { searchEl.value = ''; state.q = ''; applyFilters(); } t.blur(); } return; }
    if (help.open) { return; }
    switch (e.key) {
      case 'j': case 'ArrowDown': if (e.key === 'j' || current) { e.preventDefault(); move(1); } break;
      case 'k': case 'ArrowUp': if (e.key === 'k' || current) { e.preventDefault(); move(-1); } break;
      case 'x': if (current) { e.preventDefault(); setReviewed(current, !reviewed[current]); } break;
      case 'o': if (current) { var d = cards[current].querySelector('details.diff'); if (d) d.open = !d.open; } break;
      case 'r': state.risksOnly = !state.risksOnly; applyFilters(); break;
      case '/': e.preventDefault(); searchEl.focus(); searchEl.select(); break;
      case '?': e.preventDefault(); openHelp(); break;
      case 'Escape': setCurrent(null, false); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); break;
    }
  });
  window.addEventListener('hashchange', function () {
    var ks = hashTokens();
    if (ks.indexOf('dark') >= 0) applyTheme('dark', false); else if (ks.indexOf('light') >= 0) applyTheme('light', false);
    if (ks.indexOf('risks') >= 0 && !state.risksOnly) { state.risksOnly = true; applyFilters(); }
  });

  // ---------- boot ----------
  function measure() { var bar = top.querySelector('.toolbar'); root.style.setProperty('--top-h', (bar ? bar.offsetHeight : 0) + 'px'); }
  renderTop();
  renderRail();
  renderMain();
  renderFoot();
  renderHelp();
  applyFilters();
  measure();
  window.addEventListener('resize', measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
})();
`;
