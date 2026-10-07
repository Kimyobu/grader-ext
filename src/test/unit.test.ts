import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Memento } from 'vscode';
import { Challenge, GraderApi } from '../api';
import { ChallengeFiles, dayFolderName, hashContent, legacyDayFolderName } from '../files';
import {
  COLOR_IDS,
  PALETTES,
  aggregateState,
  explorerBadge,
  progressIcon,
  progressSvg,
  scoreState,
} from '../icons';
import { escapeHtml, renderMarkdown } from '../markdown';
import { submitCode } from '../runner';
import { ScoreStore } from '../scores';
import { syncChallenges } from '../sync';
import { extensionFor, languageFromFileName, starterCode } from '../template';

const challenges: Challenge[] = [
  {
    code: 'B01',
    id: 101,
    title: 'Hello, World!',
    description: '',
    topic: '',
    day: 'Day 01',
    difficulty: 'basic',
    max_score: 10,
    input_format: '',
    output_format: '',
    testcases: [{ input: 'Somsak', output: 'Hello, Somsak!' }],
  },
  {
    code: 'B02',
    id: 102,
    title: 'Sum',
    description: '',
    topic: '',
    day: 'Day 01',
    difficulty: 'basic',
    max_score: 10,
    input_format: '',
    output_format: '',
    testcases: [{ input: '5 10', output: '15' }],
  },
];

async function withServer(
  handler: (req: { method: string; path: string; body: any }) => { status?: number; json: unknown },
  fn: (api: GraderApi) => Promise<void>,
): Promise<void> {
  const received: Array<{ method: string; path: string; body: any }> = [];
  let hits = 0;

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    hits++;
    const res = handler({
      method,
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    received.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(res.status === 404 ? 'not found' : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const api = new GraderApi({
    baseUrl: 'http://127.0.0.1:1/',
    timeoutMs: 2000,
    maxRetries: 2,
  });

  try {
    await fn(api);
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(received.length >= 0 && hits >= 0);
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

let tmpRoot: string;

/** Minimal Memento; a fresh one per call means no state leaks between tests. */
function mem(store = new Map<string, unknown>()): Memento {
  return {
    get<T>(key: string, defaultValue?: T): T | undefined {
      return store.has(key) ? (store.get(key) as T) : defaultValue;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  } as unknown as Memento;
}

/** One store held across two ScoreStore instances, standing in for a restart. */
const persistedStore = new Map<string, unknown>();

/** Fresh directory per run so filesystem state never leaks between tests. */
async function tmpDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(tmpRoot, `${label}-`));
}

async function main(): Promise<void> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grader-ext-test-'));
  console.log(`scratch: ${tmpRoot}\n`);

  await test('dayFolderName keeps the server spelling and drops stray whitespace', () => {
    assert.equal(dayFolderName('Day 01'), 'Day 01');
    assert.equal(dayFolderName('  Day 12  '), 'Day 12');
    assert.equal(dayFolderName(''), 'Unsorted');
    assert.equal(legacyDayFolderName('Day 01'), 'Day01');
  });

  await test('migrateDayFolders moves the old Day01 layout to Day 01', async () => {
    const root = await fs.mkdtemp(path.join(tmpRoot, 'migrate-'));
    await fs.mkdir(path.join(root, 'Day01'), { recursive: true });
    await fs.writeFile(path.join(root, 'Day01', 'B01.py'), 'print("hi")', 'utf8');

    const files = new ChallengeFiles(mem(), root);
    const moved = await files.migrateDayFolders([
      { code: 'B01', day: 'Day 01' } as never,
    ]);

    assert.deepEqual(moved, ['Day01 \u2192 Day 01']);
    assert.equal(
      await fs.readFile(path.join(root, 'Day 01', 'B01.py'), 'utf8'),
      'print("hi")',
      'the file lands in the renamed folder',
    );
    assert.equal(
      await fs.stat(path.join(root, 'Day01')).then(() => true, () => false),
      false,
      'the empty legacy folder is removed',
    );
  });

  await test('migrateDayFolders keeps a file already present in the new folder', async () => {
    const root = await fs.mkdtemp(path.join(tmpRoot, 'migrate-clash-'));
    await fs.mkdir(path.join(root, 'Day01'), { recursive: true });
    await fs.mkdir(path.join(root, 'Day 01'), { recursive: true });
    await fs.writeFile(path.join(root, 'Day01', 'B01.py'), 'old work', 'utf8');
    await fs.writeFile(path.join(root, 'Day 01', 'B01.py'), 'new work', 'utf8');
    await fs.writeFile(path.join(root, 'Day01', 'B02.py'), 'unique', 'utf8');

    const files = new ChallengeFiles(mem(), root);
    await files.migrateDayFolders([{ code: 'B01', day: 'Day 01' } as never]);

    assert.equal(await fs.readFile(path.join(root, 'Day 01', 'B01.py'), 'utf8'), 'new work');
    assert.equal(
      await fs.readFile(path.join(root, 'Day 01', 'B02.py'), 'utf8'),
      'unique',
      'a file with no clash is moved across',
    );
    assert.equal(
      await fs.readFile(path.join(root, 'Day01', 'B01.py'), 'utf8'),
      'old work',
      'the clashing legacy file is left where it is rather than overwritten',
    );
  });

  await test('ScoreStore keeps the best score and totals a day', async () => {
    const store = new ScoreStore(mem(persistedStore));
    const challenges = [
      { code: 'B01', day: 'Day 01', max_score: 10 },
      { code: 'B02', day: 'Day 01', max_score: 10 },
      { code: 'B03', day: 'Day 02', max_score: 10 },
    ] as never[];

    assert.equal(store.get('B01', 10), undefined, 'no score before the first submit');

    await store.record('B01', { score: 6, max_score: 10 });
    assert.equal(store.get('B01', 10)?.best, 6);

    // A worse resubmission must not lower what the user sees.
    await store.record('B01', { score: 2, max_score: 10 });
    assert.equal(store.get('B01', 10)?.best, 6, 'the best score is retained');

    await store.record('B01', { score: 10, max_score: 10 });
    assert.equal(store.get('B01', 10)?.best, 10);

    const day = store.day(challenges, 'Day 01', new Set(['B01']));
    assert.equal(day.earned, 10);
    assert.equal(day.max, 20);
    assert.equal(day.solved, 1);
    assert.equal(day.total, 2, 'the other day is not counted');
    assert.equal(day.started, 1, 'only challenges with a local score count as started');

    const overall = store.overall(challenges, new Set(['B01']));
    assert.equal(overall.max, 30);
    assert.equal(overall.earned, 10);
    assert.equal(overall.started, 1);

    // Survives a restart, which is what makes progress visible next session.
    assert.equal(new ScoreStore(mem()).get('B01', 10)?.best, undefined, 'a fresh store starts empty');
    const reloaded = new ScoreStore(mem(persistedStore));
    assert.equal(reloaded.get('B01', 10)?.best, 10, 'scores persist in workspace state');
  });

  await test('score states follow the colour rules of the sidebar and explorer', () => {
    assert.equal(scoreState({ max: 10 }), 'none', 'no score and not solved is untouched');
    assert.equal(scoreState({ max: 10, solved: true }), 'full', 'a solved challenge counts as full');
    assert.equal(scoreState({ best: 0, max: 10 }), 'zero');
    assert.equal(scoreState({ best: 10, max: 10 }), 'full');
    assert.equal(scoreState({ best: 7, max: 10 }), 'partial');

    assert.equal(aggregateState({ earned: 0, max: 0, started: 0 }), 'none');
    assert.equal(aggregateState({ earned: 3, max: 7, started: 0 }), 'none', 'nothing started stays grey');
    assert.equal(aggregateState({ earned: 0, max: 7, started: 1 }), 'zero');
    assert.equal(aggregateState({ earned: 7, max: 7, started: 1 }), 'full');
    assert.equal(aggregateState({ earned: 3, max: 7, started: 1 }), 'partial');

    assert.equal(explorerBadge('full', 1), '\u2713');
    assert.equal(explorerBadge('zero', 0), '0');
    assert.equal(explorerBadge('none', 0), '\u2013');
    assert.equal(explorerBadge('partial', 0.7), '70');
    for (const badge of [
      explorerBadge('full', 1),
      explorerBadge('zero', 0),
      explorerBadge('none', 0),
      explorerBadge('partial', 0.004),
      explorerBadge('partial', 1),
    ]) {
      assert.ok([...badge].length <= 2, `explorer badges stay inside two characters, got "${badge}"`);
    }
    assert.equal(explorerBadge('partial', 1), '99', 'a near-full score never collides with the tick');
  });

  await test('progress rings draw the palette colours and the scored arc', () => {
    assert.ok(progressSvg('full', 1, 'light').includes('fill="#1a7f37"'), 'full ring is green');
    assert.ok(progressSvg('partial', 0.5, 'light').includes('stroke="#bf8700"'), 'partial arc is yellow');
    assert.ok(progressSvg('zero', 0, 'dark').includes('stroke="#f85149"'), 'zero ring is red');
    assert.ok(progressSvg('none', 0, 'dark').includes('stroke="#6e7681"'), 'an untouched item is grey');
    assert.ok(progressSvg('partial', 0.5, 'dark').includes('stroke="#30363d"'), 'the track sits behind the arc');

    const arc = 0.25 * 2 * Math.PI * 6;
    const quarter = progressSvg('partial', 0.25, 'dark');
    assert.ok(
      quarter.includes(`stroke-dasharray="${arc.toFixed(2)}`),
      'a quarter score draws a quarter of the circumference',
    );

    const icon = progressIcon('zero', 0);
    assert.equal(icon.light.scheme, 'data', 'tree item icons are self-contained data uris');
    assert.ok(decodeURIComponent(String(icon.light)).includes('#cf222e'), 'light and dark differ in colour');
    assert.ok(decodeURIComponent(String(icon.dark)).includes('#f85149'));
  });

  await test('contributed colors match the icon palettes', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      contributes: {
        colors?: Array<{ id: string; defaults: { light: string; dark: string } }>;
      };
    };
    const byId = new Map((pkg.contributes.colors ?? []).map((c) => [c.id, c.defaults]));
    const key = { full: 'green', partial: 'yellow', zero: 'red', none: 'gray' } as const;

    for (const state of ['full', 'partial', 'zero', 'none'] as const) {
      const defaults = byId.get(COLOR_IDS[state]);
      assert.ok(defaults, `package.json contributes ${COLOR_IDS[state]}`);
      assert.equal(defaults.light, PALETTES.light[key[state]], `${state} light colour agrees`);
      assert.equal(defaults.dark, PALETTES.dark[key[state]], `${state} dark colour agrees`);
    }
  });

  await test('templates are non-empty and language-specific', () => {
    assert.ok(starterCode('python').includes('Python'));
    assert.ok(starterCode('cpp').includes('int main'));
    assert.equal(extensionFor('python'), '.py');
    assert.equal(extensionFor('cpp'), '.cpp');
  });

  await test('languageFromFileName maps extensions', () => {
    assert.equal(languageFromFileName('B01.py'), 'python');
    assert.equal(languageFromFileName('B01.CPP'), 'cpp');
    assert.equal(languageFromFileName('B01.c'), 'cpp');
    assert.equal(languageFromFileName('notes.md'), undefined);
  });

  await test('hashContent is stable and content-sensitive', () => {
    assert.equal(hashContent('abc'), hashContent('abc'));
    assert.notEqual(hashContent('abc'), hashContent('abd'));
  });

  await test('login posts credentials and returns token', async () => {
    await withServer(
      () => ({ json: { success: true, token: 'tok-123', username: 'bwj28', role: 'student' } }),
      async (api) => {
        const res = await api.login('bwj28', 'secret');
        assert.equal(res.token, 'tok-123');
        assert.equal(res.username, 'bwj28');
      },
    );
  });

  await test('login failure surfaces the server message', async () => {
    await withServer(
      () => ({ json: { success: false, message: 'ไม่พบผู้ใช้งาน' } }),
      async (api) => {
        await assert.rejects(() => api.login('x', 'y'), /ไม่พบผู้ใช้งาน/);
      },
    );
  });

  await test('getChallenges unwraps the challenges array', async () => {
    await withServer(
      () => ({ json: { challenges } }),
      async (api) => {
        const list = await api.getChallenges();
        assert.equal(list.length, 2);
        assert.equal(list[0].code, 'B01');
        assert.equal(list[0].testcases[0].output, 'Hello, Somsak!');
      },
    );
  });

  await test('getUserCode sends token, challenge_code and language', async () => {
    let seen = '';
    await withServer(
      (req) => {
        seen = req.path;
        return { json: { success: true, code: 'print(1)' } };
      },
      async (api) => {
        const code = await api.getUserCode('tok', 'B01', 'python');
        assert.equal(code, 'print(1)');
        assert.match(seen, /challenge_code=B01/);
        assert.match(seen, /language=python/);
        assert.match(seen, /token=tok/);
      },
    );
  });

  await test('getUserCode returns empty string when unwritten', async () => {
    await withServer(
      () => ({ json: { success: true, code: '' } }),
      async (api) => {
        assert.equal(await api.getUserCode('tok', 'B09', 'python'), '');
      },
    );
  });

  await test('run posts code, input and language', async () => {
    let body: any;
    await withServer(
      (req) => {
        body = req.body;
        return { json: { success: true, stdout: 'Hello, Somsak!', stderr: '', returncode: 0 } };
      },
      async (api) => {
        const res = await api.run('print(1)', 'Somsak', 'python');
        assert.equal(res.stdout, 'Hello, Somsak!');
        assert.equal(body.input, 'Somsak');
        assert.equal(body.language, 'python');
      },
    );
  });

  await test('5xx responses are retried then succeed', async () => {
    let calls = 0;
    await withServer(
      () => {
        calls++;
        if (calls < 3) {
          return { status: 502, json: '<html>502 Bad Gateway</html>' };
        }
        return { json: { success: true, challenges } };
      },
      async (api) => {
        const list = await api.getChallenges();
        assert.equal(list.length, 2);
        assert.ok(calls >= 3, `expected retries, got ${calls} calls`);
      },
    );
  });

  await test('a 401 notifies the unauthorized handler without retrying', async () => {
    let calls = 0;
    let notified = 0;
    await withServer(
      () => {
        calls++;
        return { status: 401, json: { success: false } };
      },
      async (api) => {
        api.setUnauthorizedHandler(() => notified++);
        await assert.rejects(() => api.getSolved('bad'), /401/);
        assert.equal(calls, 1, `should not retry a 401, made ${calls} calls`);
        assert.equal(notified, 1, 'the handler runs so a re-login can be offered');
      },
    );
  });

  await test('4xx responses are not retried', async () => {
    let calls = 0;
    await withServer(
      () => {
        calls++;
        return { status: 401, json: { success: false } };
      },
      async (api) => {
        await assert.rejects(() => api.getSolved('bad'), /401/);
        assert.equal(calls, 1, `should not retry a 401, made ${calls} calls`);
      },
    );
  });

  await test('HTML error page behind a 200 is reported clearly', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html><head><title>502</title></head></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })) as typeof fetch;
    const api = new GraderApi({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, maxRetries: 0 });
    try {
      await assert.rejects(() => api.getChallenges(), /HTML page instead of JSON/);
    } finally {
      globalThis.fetch = original;
    }
  });

  await test('submit sends the challenge payload and polls to completion', async () => {
    const paths: string[] = [];
    let polls = 0;
    await withServer(
      (req) => {
        paths.push(req.method + ' ' + req.path);
        if (req.method === 'POST') {
          return { json: { async: true, job_id: 'job-1', status: 'queued', queue_position: 0, success: true } };
        }
        polls++;
        if (polls < 2) {
          return { json: { job_id: 'job-1', status: 'grading', queue_position: 0, error: null, result: null } };
        }
        return {
          json: {
            job_id: 'job-1',
            status: 'completed',
            queue_position: 0,
            error: null,
            result: {
              success: true,
              status: 'PASSED',
              passed: 3,
              total: 3,
              score: 10,
              max_score: 10,
              results: [
                { testcase: 1, input: 'Somsak', expected: 'Hello, Somsak!', actual: 'Hello, Somsak!', passed: true, returncode: 0, stderr: '' },
              ],
            },
          },
        };
      },
      async (api) => {
        const { result, jobId } = await submitCode(api, challenges[0], 'python', 'print(1)', 'tok');
        assert.equal(jobId, 'job-1');
        assert.equal(result.passed, 3);
        assert.equal(result.total, 3);
        assert.equal(result.status, 'PASSED');
        assert.ok(polls >= 2, `expected polling, got ${polls} polls`);
      },
    );
    assert.ok(paths[0].startsWith('POST /api/submit'));
  });

  await test('submit rejects when the job fails', async () => {
    await withServer(
      (req) =>
        req.method === 'POST'
          ? { json: { async: true, job_id: 'job-2', status: 'queued', queue_position: 0, success: true } }
          : { json: { job_id: 'job-2', status: 'failed', queue_position: 0, error: 'sandbox timeout', result: null } },
      async (api) => {
        await assert.rejects(
          () => submitCode(api, challenges[0], 'python', 'print(1)', 'tok'),
          /sandbox timeout/,
        );
      },
    );
  });

  await test('ChallengeFiles round-trips a sync decision', async () => {
    const memento = new MemoryMemento();
    const root = await tmpDir('files');
    const files = new ChallengeFiles(memento, root);

    const target = files.pathFor(challenges[0], 'python');
    assert.equal(target, path.join(root, 'Day 01', 'B01.py'));

    const first = await files.canWrite(challenges[0], 'python', 'print(1)');
    assert.equal(first.writable, true, `first: ${first.reason}`);
    assert.equal(first.reason, 'missing');

    await files.write(challenges[0], 'python', 'print(1)');
    const identical = await files.canWrite(challenges[0], 'python', 'print(1)');
    assert.equal(identical.writable, false, `identical: ${identical.reason}`);
    assert.equal(identical.reason, 'identical');

    const stale = await files.canWrite(challenges[0], 'python', 'print(2)');
    assert.equal(stale.writable, true);
    assert.equal(stale.reason, 'stale');

    // A file the user edited after we last wrote it must be left alone.
    await files.write(challenges[0], 'cpp', starterCode('cpp'));
    files.markDirty(challenges[0], 'cpp', 'int main(){ /* my work */ }');
    const dirty = await files.canWrite(challenges[0], 'cpp', 'int main(){ return 0; }');
    assert.equal(dirty.writable, false, `dirty: ${dirty.reason}`);
    assert.equal(dirty.reason, 'dirty');
  });

  await test('syncChallenges writes files and respects local edits', async () => {
    const memento = new MemoryMemento();
    const files = new ChallengeFiles(memento, await tmpDir('sync'));

    const api = new GraderApi({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000, maxRetries: 0 });

    await withServer(
      (req) => {
        // Only B01 in python has saved code on the server.
        if (req.path.includes('challenge_code=B01') && req.path.includes('language=python')) {
          return { json: { success: true, code: 'print("saved")' } };
        }
        return { json: { success: true, code: '' } };
      },
      async () => {
        const report = await syncChallenges(
          challenges,
          { api, token: 'tok', files },
          { languages: ['python', 'cpp'], concurrency: 2 },
        );
        assert.equal(report.total, 4);
        assert.equal(report.written.length, 4, `written=${report.written} errs=${report.skippedErrors}`);
        assert.deepEqual(report.written.sort(), ['B01/cpp', 'B01/python', 'B02/cpp', 'B02/python']);
        // Only the unwritten challenges came from templates.
        assert.deepEqual(
          report.fromTemplate.sort(),
          ['B01/cpp', 'B02/cpp', 'B02/python'],
          `fromTemplate=${report.fromTemplate}`,
        );

        // Simulate a local edit, then reload: it must survive.
        files.markDirty(challenges[0], 'python', 'my local work');
        const second = await syncChallenges(
          challenges,
          { api, token: 'tok', files },
          { languages: ['python', 'cpp'], concurrency: 2 },
        );
        assert.deepEqual(second.skippedDirty, ['B01/python']);
        assert.equal(second.written.length, 0, 'nothing should be rewritten');
      },
    );
  });

  await test('syncChallenges templatesOnly skips the API entirely', async () => {
    const files = new ChallengeFiles(new MemoryMemento(), await tmpDir('tpl'));
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('should not be called');
    }) as typeof fetch;

    const api = new GraderApi({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500, maxRetries: 0 });
    try {
      const report = await syncChallenges(challenges, { api, token: 'tok', files }, {
        languages: ['python'],
        concurrency: 1,
        templatesOnly: true,
      });
      assert.equal(calls, 0);
      assert.equal(report.written.length, 2);
      assert.equal(report.fromTemplate.length, 2);
      assert.equal(report.skippedErrors.length, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  await test('syncChallenges records fetch failures without blocking', async () => {
    const files = new ChallengeFiles(new MemoryMemento(), await tmpDir('fail'));
    const api = new GraderApi({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500, maxRetries: 0 });

    await withServer(
      () => ({ status: 502, json: '<html>502</html>' }),
      async () => {
        const report = await syncChallenges(challenges, { api, token: 'tok', files }, {
          languages: ['python'],
          concurrency: 2,
        });
        assert.equal(report.skippedErrors.length, 2);
        assert.equal(report.written.length, 2, 'files should still be created from templates');
        assert.equal(report.fromTemplate.length, 2);
      },
    );
  });

  await test('renderMarkdown renders the real B01 tracing table shape', () => {
    // Verbatim shape from /api/challenges for B01.
    const description =
      "รับชื่อของผู้ใช้งานเข้ามาทางหน้าจอ 1 บรรทัด จากนั้นให้ทำการพิมพ์คำพูดต้อนรับในรูปแบบ 'Hello, [ชื่อผู้ใช้]!'\n\n" +
      '--- \u{1F4CA} ตัวอย่างตารางไล่โค้ด (Tracing Table Example) ---\n' +
      'อินพุต: Somsak\n' +
      '| ขั้นตอน | ตัวแปร (Variable) | ค่าตัวแปร (Value) | ผลลัพธ์ / การทำงาน |\n' +
      '| :---: | :--- | :--- | :--- |\n' +
      "| 1 | รับค่าชื่อ (Read Name) | 'Somsak' | รับค่าชื่อเข้าสู่ตัวแปร name |\n" +
      '| 2 | แสดงผล (Output: Hello, ...) | - | พิมพ์ข้อความ Hello, Somsak! ออกทางหน้าจอ |';

    const html = renderMarkdown(description);

    // `--- Title ---` is the section separator the real descriptions use.
    assert.ok(html.includes('class="rule"'), 'labelled separators become section rules');
    assert.ok(html.includes('ตัวอย่างตารางไล่โค้ด'), 'the rule keeps its label');
    assert.ok(html.includes('<p>'), 'plain text becomes a paragraph');
    // The alignment row is markup, not content.
    assert.ok(!html.includes(':---'), 'alignment row must be consumed');
    assert.equal((html.match(/<tr>/g) ?? []).length, 3, 'header plus two body rows');
    assert.equal((html.match(/<th[ >]/g) ?? []).length, 4);
    assert.equal((html.match(/<td[ >]/g) ?? []).length, 8);
    assert.ok(html.includes('text-align:center'), 'the :---: column is centred');
    assert.ok(html.includes('Hello, Somsak!'));
  });

  await test('renderMarkdown treats a bare --- as a rule', () => {
    const html = renderMarkdown('above\n\n---\n\nbelow');
    assert.ok(html.includes('<hr>'));
    assert.ok(!html.includes('class="rule"'), 'a bare rule has no label');
  });

  await test('renderMarkdown handles inline code, bold, lists and rules', () => {
    const html = renderMarkdown('use `print()`\n\n**bold** and *em*\n\n- one\n- two\n\n***');
    assert.ok(html.includes('<code>print()</code>'));
    assert.ok(html.includes('<strong>bold</strong>'));
    assert.ok(html.includes('<em>em</em>'));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
    assert.ok(html.includes('<hr>'));
  });

  await test('renderMarkdown escapes HTML in descriptions and titles', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=y>');
    assert.ok(!html.includes('<script>'), 'script tags must not survive');
    assert.ok(!html.includes('<img'), 'img tags must not survive');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(escapeHtml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;');
  });

  await test('renderMarkdown treats a pipe row without an alignment row as a header', () => {
    const html = renderMarkdown('| a | b |\n| 1 | 2 |');
    assert.equal((html.match(/<th[ >]/g) ?? []).length, 2);
    assert.equal((html.match(/<td[ >]/g) ?? []).length, 2);
    assert.ok(!html.includes('text-align'), 'no alignment without an alignment row');
  });

  console.log('\nAll tests passed.');
}

class MemoryMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

void (async () => {
  try {
    await main();
  } catch {
    process.exit(1);
  }
})();