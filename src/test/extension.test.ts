import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionContext, SecretStorage, TextDocument } from 'vscode';
import * as extension from '../extension';
import { ChallengeTreeItem, isDay, TreeNode } from '../tree';
import * as vscode from './vscode-stub';
import {
  __fireActiveEditor,
  __fireSave,
  __reset,
  __setConfig,
  __setWorkspaceFolders,
  createdPanels,
  decorationProviders,
  emittedContexts,
  inputQueue,
  registeredCommands,
  shownMessages,
  treeProviders,
  treeViews,
} from './vscode-stub';

class MemoryMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

class MemorySecrets {
  private values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function makeContext(root: string): ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: new MemoryMemento() as never,
    globalState: new MemoryMemento() as never,
    secrets: new MemorySecrets() as unknown as SecretStorage,
    extensionPath: root,
  } as unknown as ExtensionContext;
}

function makeDoc(fileName: string, text: string, isDirty = false): TextDocument {
  return {
    fileName,
    getText: () => text,
    isDirty,
    lineCount: text.split('\n').length,
    uri: { fsPath: fileName },
  } as unknown as TextDocument;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CODE = 'print("hi")';

const CHALLENGE = {
  code: 'B01',
  id: 101,
  title: 'Hello',
  description: 'desc line\n\n---\n\n| a | b |\n| :---: | :--- |\n| 1 | 2 |',
  topic: 'io',
  day: 'Day 01',
  difficulty: 'basic',
  max_score: 10,
  input_format: 'one line',
  output_format: 'one line',
  testcases: [{ input: 'Somsak', output: 'Hello, Somsak!' }],
};

/**
 * Sign in, sync one challenge, and leave the extension live inside `fn`.
 * `seed` runs against the workspace before anything else, for tests that need
 * a starting filesystem state such as a legacy folder layout.
 * Returns nothing; `cleanup` must be called to dispose subscriptions.
 */
async function withSyncedExtension(
  scratch: string,
  label: string,
  api: (url: URL, init?: RequestInit) => Response,
  fn: (workspaceRoot: string) => Promise<void>,
  seed?: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  __reset();
  __setConfig('grader.apiUrl', 'https://example.test');
  __setConfig('grader.lazyLanguageFetch', false);
  __setConfig('grader.syncOnReload', false);

  const workspaceRoot = await fs.mkdtemp(path.join(scratch, `${label}-`));
  const ctx = makeContext(workspaceRoot);
  __setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }]);
  inputQueue.push('bwj28', 'hunter2');
  await seed?.(workspaceRoot);

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => api(new URL(String(input)), init)) as typeof fetch;
  try {
    await extension.activate(ctx);
    await (registeredCommands.get('grader.login') as () => Promise<void>)();
    await (registeredCommands.get('grader.reload') as () => Promise<void>)();
    await fn(workspaceRoot);
  } finally {
    globalThis.fetch = original;
    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  }
}

/** Path of a synced challenge file inside a workspace root. */
function syncedFile(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, 'grader', 'Day 01', name);
}

/** The light half of a tree item's data uri icon, decoded back to svg. */
function iconSource(icon: unknown): string {
  const pair = icon as { light?: { toString(): string } };
  assert.ok(pair?.light, 'the icon is a light and dark pair');
  const uri = String(pair.light);
  assert.ok(uri.startsWith('data:image/svg+'), 'icons are self contained data uris');
  return decodeURIComponent(uri);
}

/** True for the server-code endpoint, ignoring the push direction. */
function u(url: URL, init?: RequestInit): boolean {
  return url.pathname === '/api/user/code' && init?.method !== 'POST';
}

/** The default API plus an immediately successful submit worth `score` of 10. */
function passingSubmit(score: number) {
  return defaultApi((url) => {
    if (url.pathname === '/api/submit') {
      return jsonResponse({ async: true, job_id: 'j1', status: 'queued', queue_position: 0, success: true });
    }
    if (url.pathname === '/api/submit_status/j1') {
      return jsonResponse({
        job_id: 'j1',
        status: 'completed',
        queue_position: 0,
        error: null,
        result: {
          success: true,
          status: score >= 10 ? 'PASSED' : 'PARTIAL',
          passed: 1,
          total: 1,
          score,
          max_score: 10,
          results: [],
        },
      });
    }
    return undefined;
  });
}

function defaultApi(overrides: (url: URL, init?: RequestInit) => Response | undefined) {
  return (url: URL, init?: RequestInit): Response => {
    const custom = overrides(url, init);
    if (custom) {
      return custom;
    }
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok' });
    }
    if (url.pathname === '/api/login') {
      return jsonResponse({ success: true, token: 'tok-abc', username: 'bwj28', role: 'student' });
    }
    if (url.pathname === '/api/challenges') {
      return jsonResponse({ challenges: [CHALLENGE] });
    }
    if (url.pathname === '/api/user/solved') {
      return jsonResponse({ success: true, solved: [], attempted: [] });
    }
    if (url.pathname === '/api/user/code') {
      return jsonResponse({ success: true, code: CODE });
    }
    return jsonResponse({ success: false }, 404);
  };
}

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok  ${name}`),
      (err) => {
        console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : err}`);
        throw err;
      },
    );
}

async function main(): Promise<void> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'grader-ext-ext-'));
  const originalFetch = globalThis.fetch;

  const withApi = async (
    handler: (url: URL, init?: RequestInit) => Response,
    fn: () => Promise<void>,
  ): Promise<void> => {
    globalThis.fetch = (async (input: any, init?: any) => handler(new URL(String(input)), init)) as typeof fetch;
    try {
      await fn();
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await test('activate registers every contributed command', async () => {
    __reset();
    const pkg = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { contributes: { commands: Array<{ command: string }> } };
    const workspaceRoot = await fs.mkdtemp(path.join(scratch, 'cmds-'));
    const ctx = makeContext(workspaceRoot);

    await withApi(
      () => jsonResponse({ success: true, challenges: [] }),
      async () => {
        await extension.activate(ctx);
      },
    );

    for (const { command } of pkg.contributes.commands) {
      assert.ok(registeredCommands.has(command), `command not registered: ${command}`);
    }
    extension.deactivate();
    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  });

  await test('activate without a stored token does not hit the API', async () => {
    __reset();
    let calls = 0;
    const workspaceRoot = await fs.mkdtemp(path.join(scratch, 'noauth-'));
    const ctx = makeContext(workspaceRoot);

    await withApi(
      () => {
        calls++;
        return jsonResponse({});
      },
      async () => {
        await extension.activate(ctx);
      },
    );

    assert.equal(calls, 0, 'should not call the API while signed out');
    assert.ok(
      emittedContexts.some(([key, value]) => key === 'grader.signedIn' && value === false),
      'signed-in context should be false',
    );
    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  });

  await test('reload fetches challenges and writes one file per challenge/language', async () => {
    __reset();
    __setConfig('grader.apiUrl', 'https://example.test');
    __setConfig('grader.lazyLanguageFetch', false);
    __setConfig('grader.syncOnReload', false);

    const workspaceRoot = await fs.mkdtemp(path.join(scratch, 'reload-'));
    const ctx = makeContext(workspaceRoot);
    __setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }]);
    inputQueue.push('bwj28', 'hunter2');

    const challenges = [
      {
        code: 'B01',
        id: 101,
        title: 'Hello',
        description: 'desc',
        topic: 'io',
        day: 'Day 01',
        difficulty: 'basic',
        max_score: 10,
        input_format: 'in',
        output_format: 'out',
        testcases: [{ input: 'Somsak', output: 'Hello, Somsak!' }],
      },
      {
        code: 'B02',
        id: 102,
        title: 'Sum',
        description: 'desc',
        topic: 'io',
        day: 'Day 02',
        difficulty: 'basic',
        max_score: 10,
        input_format: 'in',
        output_format: 'out',
        testcases: [{ input: '1 2', output: '3' }],
      },
    ];

    await withApi(
      (url) => {
        if (url.pathname === '/api/health') {
          return jsonResponse({ status: 'ok' });
        }
        if (url.pathname === '/api/login') {
          return jsonResponse({ success: true, token: 'tok-abc', username: 'bwj28', role: 'student' });
        }
        if (url.pathname === '/api/challenges') {
          return jsonResponse({ challenges });
        }
        if (url.pathname === '/api/user/solved') {
          return jsonResponse({ success: true, solved: ['B01'], attempted: ['B02'] });
        }
        if (url.pathname === '/api/user/code') {
          const code = url.searchParams.get('challenge_code');
          const language = url.searchParams.get('language');
          return jsonResponse({
            success: true,
            code:
              code === 'B01' && language === 'python'
                ? 'print("saved")'
                : '',
          });
        }
        return jsonResponse({ success: false }, 404);
      },
      async () => {
        await extension.activate(ctx);

        await (registeredCommands.get('grader.login') as () => Promise<void>)();
        assert.equal(
          shownMessages.filter((m) => m.level === 'error').length,
          0,
          `login should not error: ${JSON.stringify(shownMessages)}`,
        );
        assert.ok(
          emittedContexts.some(([key, value]) => key === 'grader.signedIn' && value === true),
          'signed-in context should become true after login',
        );

        await (registeredCommands.get('grader.reload') as () => Promise<void>)();
      },
    );

    const root = path.join(workspaceRoot, 'grader');
    const b01py = path.join(root, 'Day 01', 'B01.py');
    const b01cpp = path.join(root, 'Day 01', 'B01.cpp');
    const b02py = path.join(root, 'Day 02', 'B02.py');

    assert.equal(await fs.readFile(b01py, 'utf8'), 'print("saved")');
    assert.ok((await fs.readFile(b01cpp, 'utf8')).includes('int main'));
    assert.ok((await fs.readFile(b02py, 'utf8')).includes('Python'));

    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  });

  await test('run posts the active file and reports output', async () => {
    __reset();
    __setConfig('grader.lazyLanguageFetch', false);
    __setConfig('grader.syncOnReload', false);

    const workspaceRoot = await fs.mkdtemp(path.join(scratch, 'run-'));
    const ctx = makeContext(workspaceRoot);
    __setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }]);
    inputQueue.push('bwj28', 'hunter2');

    const challenge = {
      code: 'B01',
      id: 101,
      title: 'Hello',
      description: '',
      topic: '',
      day: 'Day 01',
      difficulty: 'basic',
      max_score: 10,
      input_format: '',
      output_format: '',
      testcases: [{ input: 'Somsak', output: 'Hello, Somsak!' }],
    };

    // Seed a synced file so it resolves as an active challenge document.
    await fs.mkdir(path.join(workspaceRoot, 'grader', 'Day 01'), { recursive: true });
    const file = path.join(workspaceRoot, 'grader', 'Day 01', 'B01.py');
    await fs.writeFile(file, 'print("hi")', 'utf8');

    let runBody: any;
    await withApi(
      (url, init) => {
        if (url.pathname === '/api/health') {
          return jsonResponse({ status: 'ok' });
        }
        if (url.pathname === '/api/login') {
          return jsonResponse({ success: true, token: 'tok-abc', username: 'bwj28', role: 'student' });
        }
        if (url.pathname === '/api/challenges') {
          return jsonResponse({ challenges: [challenge] });
        }
        if (url.pathname === '/api/user/solved') {
          return jsonResponse({ success: true, solved: [], attempted: [] });
        }
        if (url.pathname === '/api/user/code') {
          return jsonResponse({ success: true, code: 'print("hi")' });
        }
        if (url.pathname === '/api/run') {
          runBody = JSON.parse(String(init?.body));
          return jsonResponse({ success: true, stdout: 'hi\n', stderr: '', returncode: 0 });
        }
        return jsonResponse({ success: false }, 404);
      },
      async () => {
        await extension.activate(ctx);
        await (registeredCommands.get('grader.login') as () => Promise<void>)();
        await (registeredCommands.get('grader.reload') as () => Promise<void>)();

        vscode.window.activeTextEditor = { document: makeDoc(file, CODE) } as never;
        await (registeredCommands.get('grader.run') as () => Promise<void>)();
      },
    );

    assert.equal(runBody.code, 'print("hi")');
    assert.equal(runBody.language, 'python');
    // Defaults to the first sample input.
    assert.equal(runBody.input, 'Somsak');

    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  });

  await test('submit posts the challenge payload and stores a token', async () => {
    __reset();
    __setConfig('grader.lazyLanguageFetch', false);
    __setConfig('grader.syncOnReload', false);

    const workspaceRoot = await fs.mkdtemp(path.join(scratch, 'submit-'));
    const ctx = makeContext(workspaceRoot);
    __setWorkspaceFolders([{ uri: { fsPath: workspaceRoot } }]);
    inputQueue.push('bwj28', 'hunter2');

    const challenge = {
      code: 'B01',
      id: 101,
      title: 'Hello',
      description: '',
      topic: '',
      day: 'Day 01',
      difficulty: 'basic',
      max_score: 10,
      input_format: '',
      output_format: '',
      testcases: [{ input: 'Somsak', output: 'Hello, Somsak!' }],
    };

    await fs.mkdir(path.join(workspaceRoot, 'grader', 'Day 01'), { recursive: true });
    const file = path.join(workspaceRoot, 'grader', 'Day 01', 'B01.py');
    await fs.writeFile(file, 'print("hi")', 'utf8');

    let submitBody: any;
    await withApi(
      (url, init) => {
        if (url.pathname === '/api/health') {
          return jsonResponse({ status: 'ok' });
        }
        if (url.pathname === '/api/login') {
          return jsonResponse({ success: true, token: 'tok-abc', username: 'bwj28', role: 'student' });
        }
        if (url.pathname === '/api/challenges') {
          return jsonResponse({ challenges: [challenge] });
        }
        if (url.pathname === '/api/user/solved') {
          return jsonResponse({ success: true, solved: [], attempted: [] });
        }
        if (url.pathname === '/api/user/code') {
          return jsonResponse({ success: true, code: 'print("hi")' });
        }
        if (url.pathname === '/api/submit') {
          submitBody = JSON.parse(String(init?.body));
          return jsonResponse({ async: true, job_id: 'j1', status: 'queued', queue_position: 0, success: true });
        }
        if (url.pathname === '/api/submit_status/j1') {
          return jsonResponse({
            job_id: 'j1',
            status: 'completed',
            queue_position: 0,
            error: null,
            result: {
              success: true,
              status: 'PASSED',
              passed: 1,
              total: 1,
              score: 10,
              max_score: 10,
              results: [
                {
                  testcase: 1,
                  input: 'Somsak',
                  expected: 'Hello, Somsak!',
                  actual: 'hi',
                  passed: false,
                  returncode: 0,
                  stderr: '',
                },
              ],
            },
          });
        }
        return jsonResponse({ success: false }, 404);
      },
      async () => {
        await extension.activate(ctx);
        await (registeredCommands.get('grader.login') as () => Promise<void>)();
        await (registeredCommands.get('grader.reload') as () => Promise<void>)();
        vscode.window.activeTextEditor = { document: makeDoc(file, CODE) } as never;
        await (registeredCommands.get('grader.submit') as () => Promise<void>)();
      },
    );

    assert.equal(submitBody.challenge_code, 'B01');
    assert.equal(submitBody.challenge_title, 'Hello');
    assert.equal(submitBody.language, 'python');
    assert.equal(submitBody.async, true);
    assert.equal(submitBody.testcases.length, 1);
    assert.ok(submitBody.token, 'submit must carry the login token');

    for (const d of ctx.subscriptions) {
      d.dispose();
    }
  });

  await test('showChallenge opens a split panel rendering the description as HTML', async () => {
    await withSyncedExtension(
      scratch,
      'panel',
      defaultApi(() => undefined),
      async () => {
        await openPanelFor('B01');
      },
    );

    assert.equal(createdPanels.length, 1, 'one panel should be created');
    const panel = createdPanels[0];
    assert.equal(panel.viewType, 'grader.challenge');
    assert.equal(panel.viewColumn, vscode.ViewColumn.Beside, 'must open in the split column');
    assert.ok(panel.title.startsWith('B01'), 'the tab is named after the challenge');

    const html = panel.webview.html;
    assert.ok(html.includes('<table>'), 'the pipe table is rendered as HTML');
    assert.ok(html.includes('text-align:center'), 'the :---: alignment is honoured');
    assert.ok(!html.includes('| :---: |'), 'the raw alignment row is consumed');
    assert.ok(html.includes('<hr>'), 'the bare rule is rendered');
    assert.ok(html.includes('data-action="run"'), 'footer has a Run button');
    assert.ok(html.includes('data-action="submit"'), 'footer has a Submit button');
    assert.ok(html.includes('data-action="pull"'), 'footer has a Pull button');
    assert.ok(html.includes('data-action="copyInput"'), 'footer has a Copy Input button');
    assert.ok(html.includes('Somsak'), 'sample inputs are shown');

    // Remote challenge text is rendered, so the webview needs a real CSP and a
    // nonce rather than a blanket script-src.
    assert.ok(html.includes("Content-Security-Policy"), 'a CSP is declared');
    assert.ok(html.includes("default-src 'none'"), 'nothing loads by default');
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(html)?.[1];
    assert.ok(nonce && nonce.length >= 16, 'the script tag carries a nonce');
    assert.ok(html.includes(`<script nonce="${nonce}">`), 'the nonce matches the script tag');
    assert.ok(!/script-src[^']*unsafe-inline/.test(html), 'inline script needs the nonce');
  });

  await test('tree items open the detail panel, and Open File is a separate command', async () => {
    const item = new ChallengeTreeItem('B01', 'Hello', 'Day 01', 'basic', false, false, undefined);
    assert.equal((item.command as { command: string }).command, 'grader.showChallenge');
    assert.equal(item.contextValue, 'grader.challenge');

    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { menus: { 'view/item/context': Array<{ command: string; group: string }> } };
    };
    const inline = pkg.contributes.menus['view/item/context'].filter((m) => m.group.startsWith('inline'));
    assert.deepEqual(
      inline.map((m) => m.command),
      ['grader.showChallenge'],
      'the inline icon shows details; the file opens from the context menu',
    );

    await withSyncedExtension(
      scratch,
      'commands',
      defaultApi(() => undefined),
      async () => {
        assert.ok(
          registeredCommands.has('grader.openFile'),
          'openFile stays available for the context menu and palette',
        );
        assert.ok(registeredCommands.has('grader.showChallenge'));
      },
    );
  });

  await test('footer Run posts the panel challenge code with the first sample input', async () => {
    let runBody: any;
    await withSyncedExtension(
      scratch,
      'footerrun',
      defaultApi((url, init) => {
        if (url.pathname === '/api/run') {
          runBody = JSON.parse(String(init?.body));
          return jsonResponse({ success: true, stdout: 'hi\n', stderr: '', returncode: 0 });
        }
        return undefined;
      }),
      async () => {
        const panel = await openPanelFor('B01');
        panel.webview.__post({ type: 'action', action: 'run', challengeCode: 'B01', language: 'python' });
        // The dispatch is fire-and-forget; let the microtask queue drain.
        await settle();
      },
    );

    assert.ok(runBody, 'the run request should have been sent');
    assert.equal(runBody.code, CODE);
    assert.equal(runBody.language, 'python');
    assert.equal(runBody.input, 'Somsak', 'the footer runs the first sample input');
  });

  await test('footer Submit confirms, submits, then reflects solved in the panel', async () => {
    let submitBody: any;
    await withSyncedExtension(
      scratch,
      'footersubmit',
      defaultApi((url, init) => {
        if (url.pathname === '/api/submit') {
          submitBody = JSON.parse(String(init?.body));
          return jsonResponse({ async: true, job_id: 'j1', status: 'queued', queue_position: 0, success: true });
        }
        if (url.pathname === '/api/submit_status/j1') {
          return jsonResponse({
            job_id: 'j1',
            status: 'completed',
            queue_position: 0,
            error: null,
            result: {
              success: true,
              status: 'PASSED',
              passed: 1,
              total: 1,
              score: 10,
              max_score: 10,
              results: [
                {
                  testcase: 1,
                  input: 'Somsak',
                  expected: 'Hello, Somsak!',
                  actual: 'Hello, Somsak!',
                  passed: true,
                  returncode: 0,
                  stderr: '',
                },
              ],
            },
          });
        }
        return undefined;
      }),
      async () => {
        const panel = await openPanelFor('B01');
        assert.ok(!panel.webview.html.includes('class="badge solved"'), 'not solved before submit');

        panel.webview.__post({ type: 'action', action: 'submit', challengeCode: 'B01', language: 'python' });
        // Submit polls the grader every 300ms, so wait past one interval.
        await settle(600);
      },
    );

    assert.ok(submitBody, 'the submit request should have been sent');
    assert.equal(submitBody.challenge_code, 'B01');
    assert.ok(submitBody.token, 'submit must carry the token');

    const panel = challengePanel();
    assert.ok(
      panel.webview.html.includes('class="badge solved"'),
      'the footer re-renders with a solved badge after a passing submit',
    );
  });

  await test('footer Pull replaces a clean file but refuses to clobber local edits', async () => {
    // Start with the server holding CODE, then let it gain newer code after the
    // file has been synced, which is the "stale but clean" case pull exists for.
    let remote = CODE;
    const API = (url: URL, init?: RequestInit): Response =>
      defaultApi((u, i) => {
        if (u.pathname === '/api/user/code') {
          if (i?.method === 'POST') {
            return jsonResponse({ detail: 'not found' }, 404);
          }
          return jsonResponse({ success: true, code: remote });
        }
        return undefined;
      })(url, init);

    // Case 1: local file matches the sync baseline, so the newer server copy wins.
    await withSyncedExtension(
      scratch,
      'pull-clean',
      API,
      async (root) => {
        const target = syncedFile(root, 'B01.py');
        assert.equal(await fs.readFile(target, 'utf8'), CODE, 'sync wrote the server copy');

        remote = '# updated on the server\n';
        const panel = await openPanelFor('B01');
        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();
        assert.equal(await fs.readFile(target, 'utf8'), remote, 'a clean file takes the newer server copy');
      },
    );

    // Case 2: the user edits and saves locally; pull must leave it alone.
    const shownBefore = shownMessages.length;
    await withSyncedExtension(
      scratch,
      'pull-dirty',
      API,
      async (root) => {
        const target = syncedFile(root, 'B01.py');
        await fs.writeFile(target, 'my work in progress', 'utf8');
        await __fireSave(makeDoc(target, 'my work in progress'));

        remote = '# something else entirely\n';
        const panel = await openPanelFor('B01');
        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();
        assert.equal(
          await fs.readFile(target, 'utf8'),
          'my work in progress',
          'local edits must survive a pull',
        );
      },
    );

    assert.ok(
      shownMessages.slice(shownBefore).some((m) => /local edits|already matches/.test(m.text)),
      'the user is told why the pull was skipped',
    );
  });

  await test('saving a file does not move the baseline when the server has no save endpoint', async () => {
    // /api/user/code rejects POST, which is what the real server does.
    await withSyncedExtension(
      scratch,
      'save',
      defaultApi((url, init) => {
        if (url.pathname === '/api/user/code' && init?.method === 'POST') {
          return jsonResponse({ detail: 'not found' }, 404);
        }
        return undefined;
      }),
      async (root) => {
        const target = syncedFile(root, 'B01.py');

        // The user edits and saves; the server still holds the old code.
        await fs.writeFile(target, 'edited locally', 'utf8');
        await __fireSave(makeDoc(target, 'edited locally'));

        // A later reload must leave the edited file alone.
        await (registeredCommands.get('grader.reload') as () => Promise<void>)();

        assert.equal(
          await fs.readFile(target, 'utf8'),
          'edited locally',
          'an edit saved without a server round-trip must not be overwritten by reload',
        );
      },
    );

    assert.ok(
      shownMessages.some((m) => /no code-save endpoint/.test(m.text)),
      'the user is warned that saving upstream is unavailable',
    );
  });

  await test('a confirmed push is allowed to move the baseline', async () => {
    let pushBody: any;
    await withSyncedExtension(
      scratch,
      'push',
      defaultApi((url, init) => {
        if (url.pathname === '/api/user/code' && init?.method === 'POST') {
          pushBody = JSON.parse(String(init?.body));
          return jsonResponse({ success: true });
        }
        return undefined;
      }),
      async (root) => {
        const target = syncedFile(root, 'B01.py');
        await fs.writeFile(target, 'pushed code', 'utf8');
        await __fireSave(makeDoc(target, 'pushed code'));
      },
    );

    assert.ok(pushBody, 'the save should have been pushed upstream');
    assert.equal(pushBody.code, 'pushed code');
    assert.equal(pushBody.language, 'python');
  });

  await test('a legacy Day01 folder is migrated to Day 01 by the sync', async () => {
    await withSyncedExtension(
      scratch,
      'migrate',
      defaultApi(() => undefined),
      async (root) => {
        assert.equal(
          await fs.readFile(syncedFile(root, 'B01.py'), 'utf8'),
          CODE,
          'the file is served from the renamed folder',
        );
        assert.equal(
          await fs
            .stat(path.join(root, 'grader', 'Day01'))
            .then(() => true, () => false),
          false,
          'the legacy folder is gone',
        );
      },
      async (root) => {
        const legacy = path.join(root, 'grader', 'Day01');
        await fs.mkdir(legacy, { recursive: true });
        await fs.writeFile(path.join(legacy, 'B01.py'), 'my earlier work', 'utf8');
      },
    );
  });

  await test('the sidebar groups challenges into day folders in numeric order', async () => {
    const many = ['Day 01', 'Day 02', 'Day 10'].map((day, i) => ({
      ...CHALLENGE,
      code: `B0${i + 1}`,
      title: `Challenge ${i + 1}`,
      day,
    }));

    await withSyncedExtension(
      scratch,
      'grouping',
      defaultApi((url) => (url.pathname === '/api/challenges'
        ? jsonResponse({ challenges: many })
        : undefined)),
      async () => {
        const provider = treeProviders.get('grader.problems') as {
          getChildren(e?: unknown): TreeNode[];
        };
        const roots = provider.getChildren();
        const days = roots.filter(isDay);

        assert.equal(days.length, 3, 'one group per day');
        assert.deepEqual(
          days.map((d) => d.day),
          ['Day 01', 'Day 02', 'Day 10'],
          'Day 10 sorts last, not between Day 1 and Day 2',
        );
        assert.match(String(days[0].description), /0\/10 pts/, 'a day reports its score');

        const children = provider.getChildren(days[0]) as ChallengeTreeItem[];
        assert.deepEqual(children.map((c) => c.challengeCode), ['B01']);
        assert.equal(
          (children[0].command as { command: string }).command,
          'grader.showChallenge',
          'clicking a challenge still opens its statement',
        );
      },
    );
  });

  await test('day groups start collapsed and remember what the user expanded', async () => {
    await withSyncedExtension(scratch, 'collapsed', defaultApi(() => undefined), async (root) => {
      const provider = treeProviders.get('grader.problems') as {
        getChildren(e?: unknown): TreeNode[];
      };
      const view = treeViews.get('grader.problems');
      assert.ok(view, 'the day view is a TreeView so expansion can be tracked');

      const first = provider.getChildren().find(isDay);
      assert.ok(first);
      assert.equal(
        first.collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
        'groups start closed so the list stays compact',
      );
      assert.equal(
        first.resourceUri?.fsPath,
        path.join(root, 'grader', 'Day 01'),
        'a day group names its folder so VS Code shows the same progress colour and badge as the explorer',
      );

      view.__expand(first);
      await (registeredCommands.get('grader.reload') as () => Promise<void>)();
      const afterRefresh = provider.getChildren().find(isDay);
      assert.ok(afterRefresh);
      assert.equal(
        afterRefresh.collapsibleState,
        vscode.TreeItemCollapsibleState.Expanded,
        'an open day stays open across a sync',
      );

      view.__collapse(afterRefresh);
      await (registeredCommands.get('grader.reload') as () => Promise<void>)();
      assert.equal(
        provider.getChildren().find(isDay)?.collapsibleState,
        vscode.TreeItemCollapsibleState.Collapsed,
        'closing a day sticks too',
      );
    });
  });

  await test('tree items carry the progress ring and follow a submit', async () => {
    await withSyncedExtension(scratch, 'icons', passingSubmit(7), async () => {
      const provider = treeProviders.get('grader.problems') as {
        getChildren(e?: unknown): TreeNode[];
      };

      const day = provider.getChildren().find(isDay);
      assert.ok(day);
      assert.ok(
        iconSource(day.iconPath).includes('#8c959f'),
        'a day with nothing started draws a grey ring',
      );
      const [untouched] = provider.getChildren(day) as ChallengeTreeItem[];
      assert.ok(
        iconSource(untouched.iconPath).includes('#8c959f'),
        'an untouched challenge draws a grey ring',
      );

      const panel = await openPanelFor('B01');
      panel.webview.__post({ type: 'action', action: 'submit', challengeCode: 'B01', language: 'python' });
      await settle(600);

      const scoredDay = provider.getChildren().find(isDay);
      assert.ok(scoredDay);
      assert.ok(
        iconSource(scoredDay.iconPath).includes('#bf8700'),
        'a partially scored day turns yellow',
      );
      const [scored] = provider.getChildren(scoredDay) as ChallengeTreeItem[];
      assert.ok(
        iconSource(scored.iconPath).includes('#bf8700'),
        'a 7 of 10 challenge turns yellow',
      );
    });
  });

  await test('explorer badges report progress on files, day folders, and the root', async () => {
    await withSyncedExtension(scratch, 'decorations', passingSubmit(7), async (root) => {
      const provider = decorationProviders.at(-1);
      assert.ok(provider, 'the explorer decoration provider is registered');
      assert.ok(
        'onDidChangeFileDecorations' in provider,
        'VS Code only listens for onDidChangeFileDecorations, not onDidChange',
      );
      const badge = (p: string) => provider.provideFileDecoration(vscode.Uri.file(p));

      const refreshEvents: unknown[][] = [];
      (provider as { onDidChangeFileDecorations: (l: (e: unknown) => void) => void }).onDidChangeFileDecorations(
        (e) => refreshEvents.push(Array.isArray(e) ? e : [e]),
      );

      const file = path.join(root, 'grader', 'Day 01', 'B01.py');
      const folder = path.join(root, 'grader', 'Day 01');
      const graderRoot = path.join(root, 'grader');

      assert.equal(badge(file)?.badge, '\u2013', 'an untouched file is marked with a dash');
      assert.equal(badge(file)?.color?.id, 'krusomchai.grader.score.none');
      assert.equal(badge(folder)?.badge, '\u2013');
      assert.equal(badge(graderRoot)?.badge, '\u2013');

      const panel = await openPanelFor('B01');
      panel.webview.__post({ type: 'action', action: 'submit', challengeCode: 'B01', language: 'python' });
      await settle(600);

      assert.equal(badge(file)?.badge, '70', 'a 7 of 10 file shows 70 percent');
      assert.equal(badge(file)?.color?.id, 'krusomchai.grader.score.partial');
      assert.equal(badge(folder)?.badge, '70', 'the day folder totals its scores');
      assert.equal(badge(graderRoot)?.badge, '70', 'the grader root totals every day');
      assert.ok(badge(file)?.tooltip?.includes('7/10 pts'), 'the tooltip spells the score out');
      assert.ok(badge(graderRoot)?.tooltip?.includes('7/10 pts'));

      const last = refreshEvents.at(-1) as Array<{ fsPath: string }>;
      assert.ok(
        last.some((u) => u.fsPath === file),
        'the refresh names the scored file so VS Code repaints it',
      );
      assert.ok(last.some((u) => u.fsPath === folder), 'the day folder is repainted too');
      assert.ok(last.some((u) => u.fsPath === graderRoot), 'and so is the grader root');
    });
  });

  await test('a submit records the score and the panel shows day progress', async () => {
    await withSyncedExtension(
      scratch,
      'score',
      defaultApi((url) => {
        if (url.pathname === '/api/submit') {
          return jsonResponse({ async: true, job_id: 'j1', status: 'queued', queue_position: 0, success: true });
        }
        if (url.pathname === '/api/submit_status/j1') {
          return jsonResponse({
            job_id: 'j1',
            status: 'completed',
            queue_position: 0,
            error: null,
            result: {
              success: true,
              status: 'PASSED',
              passed: 1,
              total: 1,
              score: 7,
              max_score: 10,
              results: [],
            },
          });
        }
        return undefined;
      }),
      async () => {
        const panel = await openPanelFor('B01');
        assert.ok(panel.webview.html.includes('0 / 10 pts'), 'no points yet before submitting');

        panel.webview.__post({ type: 'action', action: 'submit', challengeCode: 'B01', language: 'python' });
        await settle(600);

        const html = panel.webview.html;
        assert.ok(html.includes('7 / 10 pts'), 'the earned points appear after a submit');
        assert.ok(html.includes('1 of 1 solved'), 'the solved count updates');
        assert.ok(html.includes('role="progressbar"'), 'a progress bar is rendered');
        assert.match(html, /aria-valuenow="70"/, 'the bar is filled to the earned percentage');
      },
    );
  });

  await test('a 401 offers a login and retries the request that failed', async () => {
    // Every login issues a token; emptying the set is what "expired" looks like.
    const valid = new Set<string>();
    const issued: string[] = [];

    await withSyncedExtension(
      scratch,
      'reauth',
      defaultApi((url) => {
        if (url.pathname === '/api/login') {
          const token = `tok-${issued.length + 1}`;
          valid.add(token);
          issued.push(token);
          return jsonResponse({ success: true, token, username: 'bwj28', role: 'student' });
        }
        if (url.pathname === '/api/user/code') {
          if (!valid.has(url.searchParams.get('token') ?? '')) {
            return jsonResponse({ detail: 'invalid token' }, 401);
          }
          return jsonResponse({ success: true, code: `server copy ${issued.length}\n` });
        }
        return undefined;
      }),
      async (root) => {
        assert.equal(issued.length, 1, 'the setup login succeeded');
        // The session dies after the initial sync has finished.
        valid.clear();

        const panel = await openPanelFor('B01');
        inputQueue.push('bwj28', 'hunter2');

        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();

        assert.ok(
          shownMessages.some((m) => /session expired/i.test(m.text)),
          'the user is asked to sign in again',
        );
        assert.equal(issued.length, 2, 'exactly one re-login, not one per request');
        assert.equal(
          await fs.readFile(syncedFile(root, 'B01.py'), 'utf8'),
          'server copy 2\n',
          'the retry completes the pull with the new token',
        );
        assert.ok(
          shownMessages.some((m) => /Pulled saved code/.test(m.text)),
          'the pull reports success instead of an error',
        );
        assert.equal(
          shownMessages.filter((m) => m.level === 'error').length,
          0,
          'a handled 401 is not surfaced as an error',
        );
      },
    );
  });

  await test('declining the re-login stops the request without an error', async () => {
    await withSyncedExtension(
      scratch,
      'reauth-decline',
      defaultApi((url, init) => {
        if (url.pathname === '/api/user/code' && init?.method !== 'POST') {
          return jsonResponse({ detail: 'invalid token' }, 401);
        }
        return undefined;
      }),
      async (root) => {
        const before = await fs.readFile(syncedFile(root, 'B01.py'), 'utf8');
        const panel = await openPanelFor('B01');
        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();

        assert.equal(
          await fs.readFile(syncedFile(root, 'B01.py'), 'utf8'),
          before,
          'the file is left untouched when the re-login is declined',
        );
      },
    );

    // The stub answers the first choice, so this asserts the Sign In path was
    // offered; a declining user would have answered "Later" instead.
    assert.ok(shownMessages.some((m) => /session expired/i.test(m.text)));
  });

  await test('a server that keeps answering 401 stops prompting after a few tries', async () => {
    let logins = 0;
    let prompts = 0;
    let armed = false;

    await withSyncedExtension(
      scratch,
      'reauth-loop',
      defaultApi((url, init) => {
        if (url.pathname === '/api/login') {
          logins++;
          return jsonResponse({ success: true, token: `tok-${logins}`, username: 'bwj28' });
        }
        if (url.pathname === '/api/user/code' && init?.method !== 'POST') {
          // Every token is rejected once the sync is done, as a misconfigured
          // server would behave.
          return armed
            ? jsonResponse({ detail: 'nope' }, 401)
            : jsonResponse({ success: true, code: CODE });
        }
        return undefined;
      }),
      async () => {
        armed = true;
        const panel = await openPanelFor('B01');
        // Each prompt asks twice, and every retry is rejected too, so more than
        // one round of credentials is needed to reach the limit.
        for (let i = 0; i < 12; i++) {
          inputQueue.push('bwj28', 'hunter2');
        }

        for (let i = 0; i < 6; i++) {
          const before = shownMessages.length;
          panel.webview.__post({
            type: 'action',
            action: 'pull',
            challengeCode: 'B01',
            language: 'python',
          });
          await settle();
          for (const m of shownMessages.slice(before)) {
            if (/session expired/i.test(m.text)) {
              prompts++;
            }
          }
        }

        assert.ok(prompts > 0, 'the first failures do prompt');
        assert.ok(prompts <= 3, `prompting must stop, saw ${prompts} prompts`);
        assert.ok(
          shownMessages.some((m) => /Grader rejected the new session repeatedly/.test(m.text)),
          'the user is told to sign in by hand instead',
        );
      },
    );

    assert.ok(logins <= 4, `logins should stop growing, made ${logins}`);
  });

  await test('right-clicking a challenge copies that challenge input, not the active one', async () => {
    const two = [CHALLENGE, { ...CHALLENGE, code: 'B02', title: 'Sum', day: 'Day 02' }];

    await withSyncedExtension(
      scratch,
      'copystdin',
      defaultApi((url) =>
        url.pathname === '/api/challenges' ? jsonResponse({ challenges: two }) : undefined,
      ),
      async (root) => {
        // An unrelated file is active, so only an item-aware handler can pick
        // the right challenge here.
        const other = path.join(root, 'notes.md');
        vscode.window.activeTextEditor = { document: makeDoc(other, 'hello') } as never;

        await (registeredCommands.get('grader.copyStdin') as (item?: unknown) => Promise<void>)({
          challengeCode: 'B02',
        });
        await settle();

        assert.ok(
          shownMessages.some((m) => /Copied 1 sample input\(s\) for B02/.test(m.text)),
          `the context menu should act on the clicked challenge: ${JSON.stringify(shownMessages)}`,
        );
      },
    );
  });

  await test('a pulled file is no longer treated as locally edited', async () => {
    let remote = CODE;

    await withSyncedExtension(
      scratch,
      'pull-baseline',
      defaultApi((url, init) => {
        if (u(url, init)) {
          return jsonResponse({ success: true, code: remote });
        }
        return undefined;
      }),
      async (root) => {
        const target = syncedFile(root, 'B01.py');

        remote = '# newer server copy\n';
        const panel = await openPanelFor('B01');
        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();
        assert.equal(await fs.readFile(target, 'utf8'), remote);

        // A second pull of the same content must be recognised as identical
        // rather than blocked as a local edit.
        const before = shownMessages.length;
        panel.webview.__post({ type: 'action', action: 'pull', challengeCode: 'B01', language: 'python' });
        await settle();

        assert.ok(
          shownMessages.slice(before).some((m) => /already matches/.test(m.text)),
          `the pulled file is adopted as the baseline: ${JSON.stringify(shownMessages.slice(before))}`,
        );
        assert.ok(
          !shownMessages.slice(before).some((m) => /local edits/.test(m.text)),
          'a freshly pulled file must not look like a local edit',
        );

        // And a reload must leave it alone for the same reason.
        await (registeredCommands.get('grader.reload') as () => Promise<void>)();
        assert.equal(await fs.readFile(target, 'utf8'), remote, 'reload keeps the pulled code');
      },
    );
  });

  await test('the panel follows the active editor and its language toggle', async () => {
    await withSyncedExtension(
      scratch,
      'follow',
      defaultApi(() => undefined),
      async (root) => {
        const panel = await openPanelFor('B01');
        assert.ok(panel.webview.html.includes('data-language="python" class="active"'));
        assert.ok(panel.webview.html.includes('data-language="cpp" class=""'));

        // Switching the footer to C++ re-renders without opening a new panel.
        panel.webview.__post({ type: 'language', language: 'cpp' });
        await settle();
        assert.equal(createdPanels.length, 1, 'the panel is reused, not recreated');
        assert.ok(
          panel.webview.html.includes('data-language="cpp" class="active"'),
          'the C++ toggle becomes active',
        );

        // Focusing the C++ file keeps the panel on the same challenge.
        const cpp = syncedFile(root, 'B01.cpp');
        await __fireActiveEditor({ document: makeDoc(cpp, '#include <iostream>') });
        await settle();
        assert.ok(panel.webview.html.includes('data-language="cpp" class="active"'));

        // Focusing an unrelated file leaves the panel alone.
        await __fireActiveEditor({ document: makeDoc(path.join(root, 'notes.md'), 'hello') });
        await settle();
        assert.equal(panel.webview.html.includes('data-language="cpp" class="active"'), true);
      },
    );
  });

  console.log('\nAll extension tests passed.');
}

/** Open the detail panel for a challenge via the registered command. */
async function openPanelFor(code: string): Promise<vscode.StubWebviewPanel> {
  const before = createdPanels.length;
  await (registeredCommands.get('grader.showChallenge') as (item?: unknown) => Promise<void>)({
    challengeCode: code,
  });
  assert.equal(createdPanels.length, before + 1, 'a panel should have been created');
  return createdPanels[createdPanels.length - 1];
}

/** The detail panel, ignoring the results panel that a run or submit also opens. */
function challengePanel(): vscode.StubWebviewPanel {
  const found = createdPanels.filter((p) => p.viewType === 'grader.challenge');
  assert.ok(found.length > 0, 'a challenge panel should be open');
  return found[found.length - 1];
}

/** Drain pending microtasks and timers so fire-and-forget handlers finish. */
function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void (async () => {
  try {
    await main();
  } catch (err) {
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
})();