import * as vscode from 'vscode';
import type { Challenge, Language } from './api';
import { escapeHtml, renderMarkdown } from './markdown';

export type FooterAction = 'open' | 'run' | 'submit' | 'copyInput' | 'pull';

export interface ChallengeView {
  challenge: Challenge;
  language: Language;
  /** Whether the matching file exists in the workspace. */
  fileExists: boolean;
  /** Characters of code currently in that file; 0 disables Run/Submit. */
  codeLength: number;
  solved: boolean;
  attempted: boolean;
  /** Non-null while a run or submit is in flight; shown in the footer. */
  busy: string | null;
  /** False when no token is stored, which disables Submit. */
  signedIn: boolean;
  languages: Language[];
  /** Best score this workspace has recorded, plus the day-wide running total. */
  score?: ChallengeScore;
  /** Points earned and available across the day this challenge belongs to. */
  dayScore?: DayScore;
}

export interface ChallengeScore {
  /** Highest score seen for this challenge; undefined until a submit reports one. */
  best?: number;
  max: number;
  at?: string;
}

export interface DayScore {
  earned: number;
  max: number;
  solved: number;
  total: number;
  started: number;
}

/** Messages the webview sends back to the extension. */
export type PanelMessage =
  | { type: 'ready' }
  | { type: 'action'; action: FooterAction; challengeCode: string; language: Language }
  | { type: 'language'; language: string };

/** The disabled attribute when a footer action is unavailable, else empty. */
function off(enabled: boolean): string {
  return enabled ? '' : ' disabled';
}

/**
 * A labelled bar for the day, plus the points earned so far. The server has no
 * scores endpoint, so "earned" counts only submissions made from this machine.
 */
function renderProgress(day: DayScore): string {
  const pct = day.max > 0 ? Math.min(100, Math.round((day.earned / day.max) * 100)) : 0;
  return `
  <div class="progress">
    <div class="progress-head">
      <span>${day.earned} / ${day.max} pts</span>
      <span>${day.solved} of ${day.total} solved</span>
    </div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <span style="width:${pct}%"></span>
    </div>
  </div>`;
}

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  const webcrypto = globalThis.crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fall back to a time-based nonce; still unpredictable enough for a CSP that
  // exists to stop injected content from running script.
  return `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
}

/**
 * The split-window problem statement. Read-only; the footer buttons drive the
 * same run/submit paths the commands use, targeting the file for whichever
 * challenge and language the panel is currently showing.
 */
export class ChallengePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private view: ChallengeView | undefined;

  constructor(private readonly onMessage: (msg: PanelMessage) => void) {}

  get current(): ChallengeView | undefined {
    return this.view;
  }

  get visible(): boolean {
    return this.panel !== undefined;
  }

  show(view: ChallengeView, column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    const sameChallenge =
      this.view?.challenge.code === view.challenge.code &&
      this.view?.language === view.language;

    this.view = { ...view, busy: sameChallenge ? this.view?.busy ?? view.busy : view.busy };

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'grader.challenge',
        `Challenge ${view.challenge.code}`,
        { viewColumn: column, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
      // Subscribing the panel's own listeners is enough: VS Code disposes them
      // with the panel, so clearing the reference is all we owe here.
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    } else {
      this.panel.reveal(column, true);
    }

    this.render();
  }

  /** Update state that does not change which challenge is shown (busy, solved). */
  patch(partial: Partial<ChallengeView>): void {
    if (!this.view) {
      return;
    }
    this.view = { ...this.view, ...partial };
    this.render();
  }

  setBusy(busy: string | null): void {
    this.patch({ busy });
  }

  close(): void {
    this.panel?.dispose();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private render(): void {
    const panel = this.panel;
    const view = this.view;
    if (!panel || !view) {
      return;
    }
    panel.title = `${view.challenge.code} · ${view.challenge.title}`;
    panel.webview.html = this.html(view);
  }

  private html(view: ChallengeView): string {
    const c = view.challenge;
    const canRun = view.codeLength > 0;
    const canSubmit = canRun && view.signedIn;

    // The webview cannot read the extension's state, so the challenge and
    // language it is currently showing are baked into the script. Escaping
    // `<` keeps a hostile challenge code from closing the script tag.
    const context = JSON.stringify({ code: c.code, language: view.language })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');

    const nonce = makeNonce();

    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(c.code)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.6;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    /* Replaced at runtime with the footer's real height; the buttons wrap to
       two rows in a narrow split pane, which a fixed value would not allow for. */
    padding: 0 0 72px;
  }
  main { padding: 16px 20px 8px; max-width: 60rem; }

  header { border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); padding-bottom: 12px; margin-bottom: 16px; }
  .code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.8rem;
          background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.14));
          padding: 1px 7px; border-radius: 4px; margin-right: 8px; }
  h1 { font-size: 1.3rem; font-weight: 700; margin: 8px 0 6px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .progress { margin-top: 10px; max-width: 420px; }
  .progress-head { display: flex; justify-content: space-between; gap: 12px;
                   font-size: 0.72rem; opacity: 0.85; margin-bottom: 4px; }
  .bar { height: 6px; border-radius: 3px; overflow: hidden;
         background: var(--vscode-editorWidget-background, rgba(127,127,127,0.25)); }
  .bar > span { display: block; height: 100%;
                background: var(--vscode-charts-green, #2ea043); }
  .badge { font-size: 0.7rem; padding: 1px 8px; border-radius: 10px;
           border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4));
           opacity: 0.85; }
  .badge.solved { background: rgba(46,160,67,0.18); border-color: #2ea043; color: #3fb950; }
  .badge.attempted { background: rgba(210,153,34,0.18); border-color: #d29922; color: #e3b341; }

  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em;
       opacity: 0.7; margin: 20px 0 8px; }
  p { margin: 0 0 12px; }
  hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25)); margin: 16px 0; }
  .rule { display: flex; align-items: center; gap: 12px; margin: 22px 0 14px;
          font-size: 0.85rem; font-weight: 600; opacity: 0.9; }
  .rule::before, .rule::after { content: ""; flex: 1;
          border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
         background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.14));
         padding: 1px 4px; border-radius: 3px; }
  blockquote { border-left: 3px solid var(--vscode-editorWidget-border, #888);
               margin: 0 0 12px; padding: 2px 12px; opacity: 0.85; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }

  table { border-collapse: collapse; width: 100%; margin: 0 0 14px; font-size: 0.88rem; }
  th, td { border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
           padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); font-weight: 600; }
  td.io { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; }

  details { margin: 0 0 10px; }
  summary { cursor: pointer; font-size: 0.8rem; text-transform: uppercase;
            letter-spacing: 0.05em; opacity: 0.7; padding: 4px 0; }
  details .body { padding: 8px 0 4px; }

  .footer {
    position: fixed; left: 0; right: 0; bottom: 0;
display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 16px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, rgba(127,127,127,0.1)));
    border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3)));
  }
  button {
    font: inherit; font-size: 0.82rem; padding: 5px 12px; border-radius: 4px;
    border: 1px solid transparent; cursor: pointer;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  button:not(:disabled):hover { filter: brightness(1.1); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.ghost { background: transparent; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                 border-color: var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); }
  .lang { display: flex; gap: 4px; margin-left: auto; align-items: center; }
  .lang button { font-size: 0.72rem; padding: 4px 9px; text-transform: uppercase; }
  .lang button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .busy { font-size: 0.78rem; opacity: 0.8; margin-left: 4px; }
</style>
</head>
<body>
<main>
  <header>
    <span class="code">${escapeHtml(c.code)}</span>
    <h1>${escapeHtml(c.title)}</h1>
    <div class="badges">
      ${view.solved ? '<span class="badge solved">solved</span>' : ''}
      ${!view.solved && view.attempted ? '<span class="badge attempted">attempted</span>' : ''}
      <span class="badge">${escapeHtml(c.day)}</span>
      <span class="badge">${escapeHtml(c.difficulty)}</span>
      <span class="badge">${c.max_score} points</span>
      ${c.topic ? `<span class="badge">${escapeHtml(c.topic)}</span>` : ''}
    </div>
    ${view.dayScore ? renderProgress(view.dayScore) : ''}
  </header>

  <h2>Problem</h2>
  ${renderMarkdown(c.description)}

  <h2>Samples</h2>
  <table>
    <thead><tr><th>#</th><th>Input</th><th>Expected output</th></tr></thead>
    <tbody>
      ${c.testcases
        .map(
          (t, idx) =>
            `<tr><td>${idx + 1}</td><td class="io">${escapeHtml(t.input)}</td><td class="io">${escapeHtml(t.output)}</td></tr>`,
        )
        .join('')}
    </tbody>
  </table>

  ${c.input_format ? `<details open><summary>Input format</summary><div class="body">${renderMarkdown(c.input_format)}</div></details>` : ''}
  ${c.output_format ? `<details><summary>Output format</summary><div class="body">${renderMarkdown(c.output_format)}</div></details>` : ''}
</main>

<div class="footer">
  <button class="ghost" data-action="open"${off(view.fileExists)}>Open File</button>
  <button class="ghost" data-action="run"${off(canRun)}>Run</button>
  <button class="primary" data-action="submit"${off(canSubmit)}>Submit</button>
  <button class="ghost" data-action="copyInput">Copy Input</button>
  <button class="ghost" data-action="pull"${off(view.signedIn && view.fileExists)}>Pull</button>
  <span class="busy">${escapeHtml(view.busy ?? '')}</span>
  <span class="lang">
    ${view.languages
      .map(
        (l) =>
          `<button data-action="lang" data-language="${l}" class="${l === view.language ? 'active' : ''}">${l}</button>`,
      )
      .join('')}
  </span>
</div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const ctx = ${context};

  // Reserve exactly as much room as the footer occupies, so a wrapped footer in
  // a narrow pane never covers the end of the problem statement.
  const footer = document.querySelector('.footer');
  const syncFooterSpace = () => {
    if (footer) {
      document.body.style.paddingBottom = (footer.offsetHeight + 24) + 'px';
    }
  };
  syncFooterSpace();
  window.addEventListener('resize', syncFooterSpace);
  if (window.ResizeObserver) {
    new ResizeObserver(syncFooterSpace).observe(footer);
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn || btn.disabled) { return; }
    const action = btn.dataset.action;
    if (action === 'lang') {
      vscodeApi.postMessage({ type: 'language', language: btn.dataset.language });
      return;
    }
    vscodeApi.postMessage({
      type: 'action',
      action: action,
      challengeCode: ctx.code,
      language: ctx.language
    });
  });
</script>
</body>
</html>`;
  }
}