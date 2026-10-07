import type {
  Challenge,
  GraderApi,
  Language,
  RunResponse,
  SubmitResult,
  SubmitStatusResponse,
} from './api';

export type ProgressFn = (message: string) => void;

export async function runCode(
  api: GraderApi,
  challenge: Challenge,
  language: Language,
  code: string,
  options: { stdin?: string; onProgress?: ProgressFn } = {},
): Promise<RunResponse> {
  const input = options.stdin ?? challenge.testcases[0]?.input ?? '';
  options.onProgress?.(`Running ${challenge.code} (${language})`);
  return api.run(code, input, language);
}

export interface SubmitOutcome {
  result: SubmitResult;
  jobId: string;
}

const POLL_INTERVAL_MS = 300;
const MAX_POLLS = 100;
const MAX_TOTAL_MS = 60_000;

export async function submitCode(
  api: GraderApi,
  challenge: Challenge,
  language: Language,
  code: string,
  token: string,
  options: { onProgress?: ProgressFn; signal?: AbortSignal } = {},
): Promise<SubmitOutcome> {
  const initial = await api.submit({
    code,
    testcases: challenge.testcases,
    challengeCode: challenge.code,
    challengeTitle: challenge.title,
    token,
    language,
  });

  const jobId = initial.job_id;
  if (!initial.async || !jobId) {
    if (initial.result) {
      return { result: initial.result, jobId: '' };
    }
    return { jobId: '', result: coerceSubmitResult(initial) };
  }
  options.onProgress?.(
    initial.status === 'queued'
      ? `Queued (position ${initial.queue_position || 1})`
      : 'Submitted',
  );

  const deadline = Date.now() + MAX_TOTAL_MS;
  let lastSignature = '';

  for (let poll = 0; poll < MAX_POLLS && Date.now() < deadline; poll++) {
    if (options.signal?.aborted) {
      throw new Error('Submission cancelled');
    }
    await delay(POLL_INTERVAL_MS, options.signal);

    let status: SubmitStatusResponse;
    try {
      status = await api.getSubmitStatus(jobId);
    } catch {
      // Transient poll failures are expected while the worker is busy.
      continue;
    }

    switch (status.status) {
      case 'queued': {
        const signature = `queued:${status.queue_position ?? 0}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          options.onProgress?.(`In queue (#${status.queue_position || 1})`);
        }
        break;
      }
      case 'grading':
        options.onProgress?.('Evaluating test cases');
        break;
      case 'completed': {
        if (!status.result) {
          throw new Error('Grading completed but the server returned no result');
        }
        return { result: status.result, jobId };
      }
      case 'failed':
        throw new Error(status.error || 'Evaluation failed');
      default:
        options.onProgress?.(`Status: ${status.status}`);
    }
  }

  throw new Error('Timed out waiting for the grader to finish');
}

function coerceSubmitResult(partial: Partial<SubmitResult>): SubmitResult {
  const results = partial.results ?? [];
  return {
    success: partial.success ?? false,
    status: partial.status ?? 'UNKNOWN',
    passed: partial.passed ?? 0,
    total: partial.total ?? results.length,
    score: partial.score ?? partial.passed ?? 0,
    max_score: partial.max_score ?? 0,
    results,
    compile_error: partial.compile_error,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function formatRunOutput(res: RunResponse): string {
  const lines: string[] = [];
  if (res.compile_error) {
    lines.push('Compilation Error:', res.compile_error);
  }
  if (res.stdout) {
    lines.push(res.stdout.replace(/\n$/, ''));
  }
  if (res.stderr) {
    lines.push('Error:', res.stderr);
  }
  if (lines.length === 0) {
    lines.push(res.returncode === 0 ? '(No output - Program returned 0)' : `Exited with code ${res.returncode}`);
  }
  return lines.join('\n');
}