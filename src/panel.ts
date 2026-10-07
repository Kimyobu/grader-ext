import * as vscode from 'vscode';
import type { Challenge, Language, RunResponse, SubmitResult } from './api';

export type ResultPayload =
  | { kind: 'run'; challenge: Challenge; language: Language; response: RunResponse; text: string }
  | { kind: 'submit'; challenge: Challenge; language: Language; result: SubmitResult }
  | { kind: 'status'; message: string }
  | { kind: 'empty'; message: string };

export class ResultsPanel {
  private panel: vscode.WebviewPanel | undefined;
  private payload: ResultPayload | undefined;
  private disposables: vscode.Disposable[] = [];

  show(payload: ResultPayload, column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    this.payload = payload;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'grader.results',
        'Grader Results',
        { viewColumn: column, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.disposeWatchers();
      });
    } else {
      this.panel.reveal(column, true);
    }

    this.updateWatchers();
    this.render();
  }

  setStatus(message: string): void {
    if (this.panel) {
      this.payload = { kind: 'status', message };
      this.render();
    }
  }

  private disposeWatchers(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  /** Re-post the payload when the webview regains focus after being hidden. */
  private updateWatchers(): void {
    this.disposeWatchers();
    const panel = this.panel;
    if (!panel) {
      return;
    }
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => {
        if (msg?.type === 'ready') {
          this.render();
        }
        if (msg?.type === 'copy' && typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text);
        }
      }),
    );
  }

  private render(): void {
    const panel = this.panel;
    if (!panel || !this.payload) {
      return;
    }
    panel.title = titleFor(this.payload);
    panel.webview.html = renderHtml(this.payload);
  }

  dispose(): void {
    this.disposeWatchers();
    this.panel?.dispose();
  }
}

function titleFor(payload: ResultPayload): string {
  switch (payload.kind) {
    case 'run':
      return `Run ${payload.challenge.code} (${payload.language})`;
    case 'submit':
      return `Submit ${payload.challenge.code} (${payload.language})`;
    default:
      return 'Grader Results';
  }
}

function renderHtml(payload: ResultPayload): string {
  let body = '';

  if (payload.kind === 'run') {
    body = `
      <header>${esc(payload.challenge.title)}</header>
      <div class="meta">${esc(payload.challenge.code)} &middot; ${esc(payload.language)} &middot; exit ${payload.response.returncode}</div>
      <h2>Output</h2>
      <pre>${esc(payload.text)}</pre>`;
  } else if (payload.kind === 'submit') {
    body = renderSubmit(payload.challenge, payload.language, payload.result);
  } else {
    body = `<header>Grader</header><div class="meta">${esc(payload.message)}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Grader Results</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 12px 16px 32px;
  }
  header { font-size: 1.25rem; font-weight: 700; margin-bottom: 2px; }
  .meta { opacity: 0.75; margin-bottom: 14px; }
  h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.04em;
       opacity: 0.7; margin: 18px 0 8px; }
  pre {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap;
    margin: 0; font-family: var(--vscode-editor-font-family, monospace);
  }
  .summary {
    display: flex; align-items: baseline; gap: 10px; padding: 10px 14px;
    border-radius: 6px; border-left: 4px solid var(--vscode-editorWidget-border, #888);
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
  }
  .summary.pass { border-left-color: #2ea043; }
  .summary.fail { border-left-color: #e5534b; }
  .score { font-size: 1.4rem; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 7px 10px; vertical-align: top;
           border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); }
  th { font-weight: 600; opacity: 0.75; text-transform: uppercase; font-size: 0.7rem;
       letter-spacing: 0.04em; }
  td.io { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap;
          max-width: 22rem; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px;
          font-size: 0.7rem; font-weight: 700; }
  .pill.pass { background: rgba(46,160,67,0.18); color: #3fb950; }
  .pill.fail { background: rgba(229,83,75,0.18); color: #f85149; }
  .compile { border-left-color: #d29922; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 0.78rem;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
${body}
<script>
  const vscodeApi = acquireVsCodeApi();
  vscodeApi.postMessage({ type: 'ready' });
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.addEventListener('click', () => vscodeApi.postMessage({ type: 'copy', text: el.dataset.copy }));
  });
</script>
</body>
</html>`;
}

function renderSubmit(challenge: Challenge, language: Language, result: SubmitResult): string {
  const head = `
    <header>${esc(challenge.title)}</header>
    <div class="meta">${esc(challenge.code)} &middot; ${esc(language)}</div>`;

  if (result.compile_error) {
    return `${head}
      <div class="summary compile">
        <span class="score">CE</span>
        <span>Compilation error &mdash; 0/${result.max_score || challenge.max_score} points</span>
      </div>
      <h2>Compiler Output</h2>
      <pre>${esc(result.compile_error)}</pre>`;
  }

  const total = result.total || result.results.length || challenge.testcases.length;
  const passed = result.passed ?? 0;
  const score = result.score ?? passed;
  const maxScore = result.max_score || challenge.max_score;
  const allPassed = total > 0 && passed === total;

  const rows = result.results
    .map(
      (r) => `
      <tr>
        <td>${r.testcase}</td>
        <td class="io">${esc(r.input)}</td>
        <td class="io">${esc(r.expected)}</td>
        <td class="io">${esc(r.actual)}${r.stderr ? `\n<strong>stderr:</strong> ${esc(r.stderr)}` : ''}</td>
        <td><span class="pill ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span></td>
      </tr>`,
    )
    .join('');

  const copyAll = `try {\n${challenge.testcases.map((t) => t.input).join('\n')}\n} catch (Exception e) {}`;

  return `${head}
    <div class="summary ${allPassed ? 'pass' : 'fail'}">
      <span class="score">${score}/${maxScore}</span>
      <span>${passed} of ${total} test cases passed</span>
      <span style="opacity:0.6">${esc(result.status)}</span>
      <span style="flex:1"></span>
      <button data-copy="${esc(copyAll)}">Copy sample input</button>
    </div>
    <h2>Test Cases</h2>
    <table>
      <thead>
        <tr><th>#</th><th>Input</th><th>Expected</th><th>Actual</th><th>Status</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5">No test case results returned.</td></tr>'}</tbody>
    </table>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}