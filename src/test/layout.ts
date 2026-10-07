/**
 * Measures the rendered panel with headless Chrome and prints the geometry, so
 * layout regressions show up without eyeballing a screenshot.
 *
 *   npm run preview -- <challenges.json> [challengeCode]
 *   npm run check-layout            # runs the Chrome measurement
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Stand-in theme values so the measurement matches a real VS Code webview. */
const THEME = `
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-editor-background: #1f1f1f;
    --vscode-editor-font-family: "SF Mono", Consolas, monospace;
    --vscode-editorWidget-border: #454545;
    --vscode-editorWidget-background: #252526;
    --vscode-textCodeBlock-background: #2d2d2d;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryForeground: #cccccc;
  }
`;

/**
 * Injected before the panel's own script: VS Code provides this API inside a
 * real webview, so the harness has to as well or the panel script throws before
 * it sets up its layout.
 */
const HOST_SHIM = `
<script nonce="__NONCE__">
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return null; }, setState() {} });
</script>
`;

const PROBE = `
<script nonce="__NONCE__">
  window.addEventListener('load', () => {
    const out = [];
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return sel + ' MISSING';
      const r = el.getBoundingClientRect();
      return 'info ' + sel + ' ' + [r.width, r.height].map((n) => Math.round(n)).join('x') +
        ' @' + Math.round(r.left) + ',' + Math.round(r.top);
    };
    out.push(rect('main'));
    out.push(rect('header'));
    out.push(rect('h1'));
    out.push(rect('table'));
    out.push(rect('.footer'));

    // The score bar has to stay inside the header it belongs to.
    const bar = document.querySelector('.progress .bar > span');
    if (bar) {
      const br = bar.getBoundingClientRect();
      const paneWidth = document.documentElement.clientWidth;
      if (br.width < 0 || br.right > paneWidth + 1) {
        out.push('score bar overflows the pane');
      }
    }

    const footer = document.querySelector('.footer');
    if (footer) {
      const fr = footer.getBoundingClientRect();
      const cs = getComputedStyle(footer);
      if (cs.position !== 'fixed') out.push('footer is not position:fixed');
      if (Math.abs(fr.bottom - window.innerHeight) > 2) out.push('footer is not pinned to the bottom');
      // Compare against the client width; innerWidth includes the scrollbar.
      const paneWidth = document.documentElement.clientWidth;
      if (fr.right > paneWidth + 1) out.push('footer overflows the pane horizontally');
      if (fr.width < paneWidth - 1) out.push('footer does not span the pane width');
    }

    // Scrolling must be able to lift the last of the content clear of the
    // footer, otherwise the footer permanently hides part of the problem.
    const main = document.querySelector('main');
    if (main && footer) {
      const mainBottom = main.getBoundingClientRect().bottom + window.scrollY;
      const footerTop = footer.getBoundingClientRect().top + window.scrollY;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const revealed = footerTop - (mainBottom - maxScroll);
      if (revealed < 4) {
        out.push('footer hides the end of the content (clearance ' + Math.round(revealed) + 'px)');
      }
    }

    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      out.push('document overflows horizontally: ' +
        document.documentElement.scrollWidth + ' > ' + document.documentElement.clientWidth);
    }

    // A table wider than the pane would need a scroll container.
    for (const [i, t] of [...document.querySelectorAll('main table')].entries()) {
      const r = t.getBoundingClientRect();
      if (r.right > document.documentElement.clientWidth + 1) {
        out.push('table ' + i + ' overflows the pane');
      }
    }

    // Buttons must be large enough to hit. They are allowed to wrap onto a
    // second row in a narrow pane, so only same-row buttons must not overlap.
    let rowTop = null;
    let prevRight = 0;
    for (const b of document.querySelectorAll('.footer button')) {
      const r = b.getBoundingClientRect();
      if (r.height < 20) out.push('button too short: ' + b.dataset.action + ' h=' + Math.round(r.height));
      if (rowTop === null || Math.abs(r.top - rowTop) > 2) {
        rowTop = r.top;
        prevRight = 0;
      }
      if (r.left < prevRight - 1) out.push('buttons overlap at ' + b.dataset.action);
      prevRight = r.right;
    }

    out.push('info footer rows ' + new Set(
      [...document.querySelectorAll('.footer button')].map((b) => Math.round(b.getBoundingClientRect().top))
    ).size);
    out.push('info body padding-bottom ' + getComputedStyle(document.body).paddingBottom +
      ' vs footer height ' + (footer ? Math.round(footer.offsetHeight) : 'n/a'));

    // Thai body copy should not be clipped.
    for (const p of document.querySelectorAll('main p')) {
      if (p.scrollWidth > p.clientWidth + 2) out.push('paragraph clipped: ' + p.textContent.slice(0, 30));
    }

    document.title = 'PROBE:' + out.join('|');
  });
</script>
`;

const preview = path.join(__dirname, 'panel-preview.html');
if (!fs.existsSync(preview)) {
  console.error('run `npm run preview -- <challenges.json>` first');
  process.exit(1);
}

let html = fs.readFileSync(preview, 'utf8');

// The panel declares a nonce-based CSP, so the probe has to borrow the nonce.
const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(html)?.[1];
if (!nonce) {
  console.error('no CSP nonce found in the preview; regenerate it');
  process.exit(1);
}
html = html
  .replace('</style>', THEME + '</style>')
  .replace('<script nonce=', HOST_SHIM.replace('__NONCE__', nonce) + '<script nonce=')
  .replace('</body>', PROBE.replace('__NONCE__', nonce) + '</body>');

const measure = path.join(__dirname, 'panel-measure.html');
fs.writeFileSync(measure, html);

const width = process.env.PANEL_WIDTH ?? '900';
const height = process.env.PANEL_HEIGHT ?? '1000';
const bin = process.env.CHROME ?? 'google-chrome';
const out = execFileSync(
  bin,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=' + width + ',' + height,
    '--virtual-time-budget=2000',
    '--dump-dom',
    'file://' + measure,
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);

const title = /<title>([^<]*)<\/title>/.exec(out)?.[1] ?? '';
if (!title.startsWith('PROBE:')) {
  console.error('probe did not run; title was:', title);
  process.exit(1);
}

const checks = title.slice('PROBE:'.length).split('|');
let failed = 0;
for (const line of checks) {
  if (/MISSING/.test(line)) {
    failed++;
    console.log(`FAIL ${line}`);
    continue;
  }
  if (line.trim() === '') {
    continue;
  }
  // Lines beginning with "info" are geometry readings; anything else is a
  // problem the probe found.
  const informative = line.startsWith('info');
  if (!informative) {
    failed++;
  }
  console.log(`${informative ? 'ok  ' : 'FAIL'} ${line}`);
}
console.log(failed === 0 ? `\nLayout clean at ${width}x${height}.` : `\n${failed} layout problems.`);
process.exit(failed === 0 ? 0 : 1);
