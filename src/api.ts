export type Language = 'python' | 'cpp';

export interface Testcase {
  input: string;
  output: string;
}

export interface Challenge {
  code: string;
  id: number;
  title: string;
  description: string;
  topic: string;
  day: string;
  difficulty: string;
  max_score: number;
  input_format: string;
  output_format: string;
  testcases: Testcase[];
}

export interface LoginResponse {
  success: boolean;
  message?: string;
  token?: string;
  username?: string;
  role?: string;
  classroom?: string;
}

export interface UserCodeResponse {
  success: boolean;
  code: string;
}

export interface RunResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  returncode: number;
  compile_error?: string;
}

export interface TestResult {
  testcase: number;
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  returncode: number;
  stderr: string;
}

export interface SubmitResult {
  success: boolean;
  status: string;
  passed: number;
  total: number;
  score: number;
  max_score: number;
  results: TestResult[];
  compile_error?: string;
}

export interface SubmitStatusResponse {
  async?: boolean;
  job_id?: string;
  status: 'queued' | 'grading' | 'completed' | 'failed' | string;
  queue_position: number;
  error: string | null;
  result: SubmitResult | null;
  /** Present when the server answers synchronously instead of queueing. */
  passed?: number;
  total?: number;
  score?: number;
  max_score?: number;
  results?: TestResult[];
  compile_error?: string;
  success?: boolean;
}

export interface SolvedResponse {
  success: boolean;
  solved: string[];
  attempted: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === undefined || RETRYABLE_STATUS.has(err.status);
  }
  return err instanceof TypeError || err instanceof Error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GraderApi {
  private baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /** Called once per 401 response, before the error reaches the caller. */
  private onUnauthorized: (() => void) | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
  }

  /**
   * Observe rejected tokens. Some callers (the sync fan-out) swallow per-file
   * errors, so the 401 has to surface from the transport rather than only from
   * the rejected promise.
   */
  setUnauthorizedHandler(handler: (() => void) | undefined): void {
    this.onUnauthorized = handler;
  }

  setBaseUrl(url: string): void {
    this.baseUrl = stripTrailingSlash(url);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const data = await this.request<LoginResponse>('POST', '/api/login', {
      body: { username, password },
    });
    if (!data.success || !data.token) {
      throw new ApiError(data.message || 'Login failed', 200, JSON.stringify(data));
    }
    return data;
  }

  async health(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/api/health', { timeoutMs: 5000, retries: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async getChallenges(): Promise<Challenge[]> {
    const data = await this.request<{ challenges: Challenge[] }>('GET', '/api/challenges');
    if (!Array.isArray(data.challenges)) {
      throw new ApiError('Malformed /api/challenges response', 200, JSON.stringify(data));
    }
    return data.challenges;
  }

  async getUserCode(token: string, challengeCode: string, language: Language): Promise<string> {
    const qs = new URLSearchParams({
      token,
      challenge_code: challengeCode,
      language,
    });
    const data = await this.request<UserCodeResponse>('GET', `/api/user/code?${qs.toString()}`);
    return typeof data.code === 'string' ? data.code : '';
  }

  async pushUserCode(
    token: string,
    challengeCode: string,
    language: Language,
    code: string,
  ): Promise<void> {
    await this.request<unknown>('POST', '/api/user/code', {
      body: { token, challenge_code: challengeCode, language, code },
    });
  }

  async run(code: string, input: string, language: Language): Promise<RunResponse> {
    return this.request<RunResponse>('POST', '/api/run', {
      body: { code, input, language },
    });
  }

  async submit(params: {
    code: string;
    testcases: Testcase[];
    challengeCode: string;
    challengeTitle: string;
    token: string;
    language: Language;
  }): Promise<SubmitStatusResponse> {
    const data = await this.request<SubmitStatusResponse>('POST', '/api/submit', {
      body: {
        code: params.code,
        testcases: params.testcases,
        challenge_code: params.challengeCode,
        challenge_title: params.challengeTitle,
        token: params.token,
        language: params.language,
        async: true,
      },
    });
    return data;
  }

  async getSubmitStatus(jobId: string): Promise<SubmitStatusResponse> {
    return this.request<SubmitStatusResponse>(
      'GET',
      `/api/submit_status/${encodeURIComponent(jobId)}`,
      { retries: 1 },
    );
  }

  async getSolved(token: string): Promise<SolvedResponse> {
    const qs = new URLSearchParams({ token });
    return this.request<SolvedResponse>('GET', `/api/user/solved?${qs.toString()}`);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number; retries?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? this.maxRetries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt));
      }
      try {
        return await this.attempt<T>(method, path, opts.body, timeoutMs);
      } catch (err) {
        lastError = err;
        const canRetry = attempt < retries && isRetryable(err);
        if (!canRetry) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  private async attempt<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'AbortError'
        ? `Request timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : 'Network error';
      throw new ApiError(reason, undefined);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) {
      // A 401 here can arrive on any call, including the ones whose errors the
      // sync loop records and moves past, so notify before throwing.
      if (response.status === 401) {
        this.onUnauthorized?.();
      }
      throw new ApiError(
        `${method} ${path} failed with ${response.status} ${response.statusText}`.trim(),
        response.status,
        text.slice(0, 500),
      );
    }

    if (!text.trim()) {
      throw new ApiError(`${method} ${path} returned an empty body`, response.status);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // The server returns an HTML error page behind a 200 in some failure modes.
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      throw new ApiError(
        looksHtml
          ? `${method} ${path} returned an HTML page instead of JSON`
          : `${method} ${path} returned malformed JSON`,
        response.status,
        text.slice(0, 500),
      );
    }
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function backoffMs(attempt: number): number {
  const base = Math.min(2000, 250 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 100);
}