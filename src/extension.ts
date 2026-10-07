import * as vscode from 'vscode';
import { Challenge, GraderApi, Language } from './api';
import { AuthStore } from './auth';
import { ChallengePanel, PanelMessage } from './challengePanel';
import { GraderDecorationProvider } from './decorations';
import { ChallengeFiles } from './files';
import { ResultsPanel } from './panel';
import { formatRunOutput, runCode, submitCode } from './runner';
import { ScoreStore } from './scores';
import { syncChallenges, SyncReport } from './sync';
import { ChallengeTreeItem, ChallengeTreeProvider, isDay } from './tree';

class GraderExtension implements vscode.Disposable {
  private readonly auth: AuthStore;
  private readonly panel = new ResultsPanel();
  private readonly challengePanel: ChallengePanel;
  private readonly tree: ChallengeTreeProvider;
  private readonly decorations = new GraderDecorationProvider();
  private readonly output: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  private api: GraderApi;
  private files: ChallengeFiles | undefined;
  private challenges: Challenge[] = [];
  private solved = new Set<string>();
  private attempted = new Set<string>();
  private readonly scores: ScoreStore;
  /** Set once the server rejects POST /api/user/code; stops us probing forever. */
  private pushUnsupported = false;
  private pushWarningShown = false;
  private syncPromise: Promise<void> | undefined;
  private lastReport: SyncReport | undefined;
  /** In-flight re-login, so a burst of 401s prompts once and retries once. */
  private reauthPromise: Promise<boolean> | undefined;
  /**
   * True while a 401-driven re-login is running. The session-change handler
   * must not reload in that window: the reload would await the very sync that
   * is waiting on the re-login, deadlocking both.
   */
  private reauthing = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Grader');
    this.auth = new AuthStore(context.secrets);
    this.scores = new ScoreStore(context.workspaceState);
    this.api = this.createApi();
    this.tree = new ChallengeTreeProvider();
    this.challengePanel = new ChallengePanel((msg) => this.onPanelMessage(msg));

    this.registerCommands();
    this.disposables.push(
      this.output,
      this.panel,
      this.challengePanel,
      this.tree,
      this.decorations,
      this.auth.onDidChangeSession(() => {
        void this.onSessionChanged();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          return;
        }
        if (this.config().lazyLanguageFetch) {
          void this.ensureFileSynced(editor.document);
        }
        void this.followPanelToEditor(editor);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.onDidSave(doc);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('grader.apiUrl')) {
          this.api = this.createApi();
        }
      }),
    );
  }

  async activate(): Promise<void> {
    const session = await this.auth.restore();
    this.setSignedInContext(Boolean(session));

    if (!session) {
      this.tree.setEmpty('Signed out. Use "Grader: Login" to begin.');
      return;
    }

    if (this.config().syncOnReload) {
      void this.reload({ silent: true });
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.files?.dispose();
    this.auth.dispose();
  }

  // ─── configuration ──────────────────────────────────────────────

  private config() {
    const cfg = vscode.workspace.getConfiguration('grader');
    return {
      apiUrl: cfg.get<string>('apiUrl', 'https://grader.krusomchai.online'),
      workspaceFolder: cfg.get<string>('workspaceFolder', 'grader'),
      languages: normalizeLanguages(cfg.get<string[]>('languages', ['python', 'cpp'])),
      syncOnReload: cfg.get<boolean>('syncOnReload', true),
      lazyLanguageFetch: cfg.get<boolean>('lazyLanguageFetch', true),
      pushOnSave: cfg.get<boolean>('pushOnSave', true),
      requestTimeoutMs: cfg.get<number>('requestTimeoutMs', 15000),
      maxRetries: cfg.get<number>('maxRetries', 3),
      syncConcurrency: cfg.get<number>('syncConcurrency', 4),
    };
  }

  private createApi(): GraderApi {
    const cfg = this.config();
    const api = new GraderApi({
      baseUrl: cfg.apiUrl,
      timeoutMs: cfg.requestTimeoutMs,
      maxRetries: cfg.maxRetries,
    });
    api.setUnauthorizedHandler(() => {
      // Sync fans out over many files and records per-file errors instead of
      // throwing, so a rejected token has to be noticed at the transport too.
      // The counter in reauthenticate is what keeps this from looping.
      void this.reauthenticate();
    });
    return api;
  }

  private ensureFiles(): ChallengeFiles | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    if (this.files) {
      return this.files;
    }
    const root = vscode.Uri.joinPath(folder.uri, this.config().workspaceFolder);
    this.files = new ChallengeFiles(this.context.workspaceState, root.fsPath);
    return this.files;
  }

  // ─── auth ───────────────────────────────────────────────────────

  /**
   * Run an API call, and if the server rejects the token, prompt for a fresh
   * login once and retry. Returns undefined when the call could not be
   * authorised at all, so callers can skip their own error reporting.
   */
  private async withAuth<T>(
    label: string,
    fn: (token: string) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const token = this.auth.token;
    if (!token) {
      void vscode.window.showWarningMessage('Sign in to Grader first.');
      return { ok: false };
    }
    try {
      return { ok: true, value: await fn(token) };
    } catch (err) {
      if (!isUnauthorized(err)) {
        throw err;
      }
      this.output.appendLine(`${label} rejected the token (401); asking to sign in again.`);
      if (!(await this.reauthenticate())) {
        return { ok: false };
      }
      const fresh = this.auth.token;
      if (!fresh) {
        return { ok: false };
      }
      try {
        return { ok: true, value: await fn(fresh) };
      } catch (retryErr) {
        if (!isUnauthorized(retryErr)) {
          throw retryErr;
        }
        // Retrying once is all we owe the user; a second rejection is reported
        // through the channel rather than thrown at whatever called this.
        this.output.appendLine(`${label} rejected the new token as well; stopping.`);
        return { ok: false };
      }
    }
  }

  /**
   * Ask the user to sign in again. Concurrent callers share one prompt and one
   * outcome, so a sync that fans out into many requests cannot open a stack of
   * input boxes.
   */
  private reauthenticate(): Promise<boolean> {
    if (this.reauthPromise) {
      return this.reauthPromise;
    }
    const attempt = (async () => {
      this.reauthing = true;
      try {
        // A server that rejects the credentials it just issued would otherwise
        // put us in a prompt loop, so give up and let the user retry by hand.
        if (this.auth.expiries >= MAX_REAUTHS) {
          this.output.appendLine(
            `Giving up on automatic sign-in after ${MAX_REAUTHS} attempts.`,
          );
          void vscode.window.showErrorMessage(
            'Grader rejected the new session repeatedly. Run "Grader: Login" to try again.',
          );
          return false;
        }
        this.auth.expiries += 1;

        const choice = await vscode.window.showWarningMessage(
          'Your Grader session expired. Sign in again to continue.',
          'Sign In',
          'Later',
        );
        if (choice !== 'Sign In') {
          return false;
        }
        // The stored token is stale, so drop it before asking for credentials.
        await this.auth.clear();
        await this.login({ reloadAfter: false });
        return Boolean(this.auth.token);
      } finally {
        this.reauthing = false;
      }
    })().finally(() => {
      this.reauthPromise = undefined;
    });
    this.reauthPromise = attempt;
    return attempt;
  }

  // ─── auth ───────────────────────────────────────────────────────

  private async login(options: { reloadAfter?: boolean } = {}): Promise<void> {
    const username = await vscode.window.showInputBox({
      title: 'Grader Login',
      prompt: 'Username',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
    });
    if (!username) {
      return;
    }
    const password = await vscode.window.showInputBox({
      title: 'Grader Login',
      prompt: 'Password',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? undefined : 'Password is required'),
    });
    if (!password) {
      return;
    }

    const health = await this.api.health();
    if (!health) {
      const choice = await vscode.window.showWarningMessage(
        `Could not reach ${this.api.getBaseUrl()}. Try logging in anyway?`,
        'Retry',
        'Login Anyway',
      );
      if (choice === 'Retry') {
        return;
      }
      if (!choice) {
        return;
      }
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Signing in to Grader' },
        async () => {
          const res = await this.api.login(username.trim(), password);
          await this.auth.set({ token: res.token as string, username: res.username ?? username.trim() });
        },
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Grader login failed: ${text(err)}`);
      return;
    }

    void vscode.window.showInformationMessage(`Signed in to Grader as ${this.auth.current?.username}`);
    // A re-login triggered by a 401 retries the call that failed; re-syncing
    // here would race it and show a second, redundant notification.
    if (options.reloadAfter ?? true) {
      await this.reload({ silent: false });
    }
  }

  private async logout(): Promise<void> {
    await this.auth.clear();
    this.challenges = [];
    this.solved.clear();
    this.attempted.clear();
    this.tree.setEmpty('Signed out.');
    void vscode.window.showInformationMessage('Signed out of Grader');
  }

  private async onSessionChanged(): Promise<void> {
    this.setSignedInContext(Boolean(this.auth.current));
    await this.refreshPanelFooter();
    // A re-login retries the request that failed instead of syncing again.
    if (this.auth.current && !this.reauthing) {
      await this.reload({ silent: false });
    }
  }

  private setSignedInContext(signedIn: boolean): void {
    void this.context.globalState.update('grader.signedIn', signedIn);
    void vscode.commands.executeCommand('setContext', 'grader.signedIn', signedIn);
  }

  // ─── sync ───────────────────────────────────────────────────────

  private async reload(options: { silent?: boolean } = {}): Promise<void> {
    const token = this.auth.token;
    if (!token) {
      void vscode.window.showWarningMessage('Sign in to Grader first.');
      return;
    }
    const files = this.ensureFiles();
    if (!files) {
      void vscode.window.showWarningMessage('Open a folder in your workspace to sync challenge files.');
      return;
    }
    // Coalesce concurrent reloads (login fires one, then the command fires
    // another) onto the in-flight run instead of dropping the second request.
    if (this.syncPromise) {
      await this.syncPromise;
      return;
    }

    const cfg = this.config();
    this.syncPromise = this.runSync(token, files, cfg);
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = undefined;
    }
    this.announceSync(options.silent ?? false);
  }

  private async runSync(
    token: string,
    files: ChallengeFiles,
    cfg: ReturnType<GraderExtension['config']>,
  ): Promise<void> {
    try {
      const report = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing Grader challenges',
          cancellable: false,
        },
        async (progress) => {
          this.output.appendLine(`Fetching challenges from ${this.api.getBaseUrl()}`);
          const challenges = await this.api.getChallenges();
          progress.report({ message: `${challenges.length} challenges` });

          const solved = await this.withAuth('Reload', (t) => this.api.getSolved(t))
            .then((r) => (r.ok ? r.value : undefined))
            .catch(() => undefined);
          if (solved?.success) {
            this.solved = new Set(solved.solved);
            this.attempted = new Set(solved.attempted);
          }

          this.challenges = challenges;

          // The old layout used "Day01"; move anything already on disk to the
          // server's own "Day 01" before writing, so paths do not fork.
          for (const note of await files.migrateDayFolders(challenges)) {
            this.output.appendLine(`Moved folder ${note}`);
          }

          // Fetching both languages for every challenge is ~94 requests, which
          // is what triggers the API's 502s. When lazy fetch is on we only
          // materialize the templates and pull real code per file as it opens.
          const lazy = cfg.lazyLanguageFetch;
          const progressLabel = { increment: 100 / Math.max(1, challenges.length) };

          progress.report({ ...progressLabel, message: 'Writing files' });
          const result = await syncChallenges(challenges, { api: this.api, token, files }, {
            languages: cfg.languages,
            concurrency: cfg.syncConcurrency,
            templatesOnly: lazy,
            onProgress: (done, total) => {
              if (done % 5 === 0 || done === total) {
                progress.report({ message: `${done}/${total} files` });
              }
            },
          });

          if (!lazy) {
            this.logReport(result);
          }
          return result;
        },
      );

      this.refreshTree();

      if (cfg.lazyLanguageFetch) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await this.ensureFileSynced(editor.document);
        }
      }

      this.lastReport = report;
    } catch (err) {
      this.output.appendLine(`Sync failed: ${text(err)}`);
      void vscode.window.showErrorMessage(`Grader sync failed: ${text(err)}`);
    }
  }

  /** Announce the outcome of the most recent sync. */
  private announceSync(silent: boolean): void {
    const report = this.lastReport;
    if (silent || !report) {
      return;
    }
    const cfg = this.config();
    const overall = this.scores.overall(this.challenges, this.solved);
    const detail = [
      `${this.challenges.length} challenges`,
      `${report.written.length} files written`,
      `${overall.solved}/${overall.total} solved`,
      overall.max > 0 ? `${overall.earned}/${overall.max} pts` : '',
      report.fromTemplate.length ? `${report.fromTemplate.length} from template` : '',
      report.skippedDirty.length ? `${report.skippedDirty.length} kept (local edits)` : '',
      cfg.lazyLanguageFetch ? 'code fetched per file as you open it' : '',
    ]
      .filter(Boolean)
      .join(', ');
    void vscode.window.showInformationMessage(`Grader synced: ${detail}`);
  }

  /**
   * Pull the server's saved code for the file the user just opened and write it
   * if the local copy is still an untouched template.
   */
  private async ensureFileSynced(document: vscode.TextDocument): Promise<void> {
    const files = this.ensureFiles();
    if (!this.auth.token || !files || this.syncPromise || this.challenges.length === 0) {
      return;
    }
    const ref = files.resolve(document, this.challenges);
    if (!ref) {
      return;
    }

    // Writing to disk under an editor with unsaved changes would silently
    // revert them on the next save, so leave dirty buffers alone.
    if (document.isDirty) {
      return;
    }

    try {
      const pulled = await this.withAuth('Open', (token) =>
        this.api.getUserCode(token, ref.challenge.code, ref.language),
      );
      if (!pulled.ok) {
        return;
      }
      const remote = pulled.value;
      if (!remote.trim()) {
        return;
      }
      const local = await files.readIfExists(ref.absolutePath);
      if (local === null || local === undefined) {
        return;
      }
      if (local === remote) {
        return;
      }

      const decision = await files.canWrite(ref.challenge, ref.language, remote);
      if (!decision.writable) {
        return;
      }

      await files.write(ref.challenge, ref.language, remote);
      this.output.appendLine(`Pulled ${ref.challenge.code}/${ref.language} from server`);
    } catch (err) {
      this.output.appendLine(`Pull skipped for ${ref.challenge.code}: ${text(err)}`);
    }
  }

  private logReport(report: SyncReport): void {
    this.output.appendLine(
      `Sync: ${report.written.length} written, ${report.fromTemplate.length} from template, ` +
        `${report.skippedDirty.length} kept (local edits), ${report.skippedErrors.length} errors`,
    );
    for (const e of report.skippedErrors.slice(0, 20)) {
      this.output.appendLine(`  ! ${e}`);
    }
    if (report.skippedDirty.length) {
      this.output.appendLine(`  local edits preserved: ${report.skippedDirty.join(', ')}`);
    }
  }

  private refreshTree(): void {
    const files = this.ensureFiles();
    const items = this.challenges.map(
      (c) =>
        new ChallengeTreeItem(
          c.code,
          c.title,
          c.day,
          c.difficulty,
          this.solved.has(c.code),
          this.attempted.has(c.code),
          files ? vscode.Uri.file(files.pathFor(c, this.config().languages[0] ?? 'python')) : undefined,
          this.scores.get(c.code, c.max_score),
        ),
    );

    // One collapsible group per day, sorted numerically so Day 2 precedes Day 10.
    const days = [...new Set(this.challenges.map((c) => c.day))].map((day) => ({
      day,
      label: day,
      score: this.scores.day(this.challenges, day, this.solved),
      resourceUri: files ? vscode.Uri.file(files.dayPath(day)) : undefined,
    }));
    this.tree.refresh(items, days);
    this.refreshDecorations(files);
  }

  private refreshDecorations(files: ChallengeFiles | undefined): void {
    if (!files) {
      this.decorations.clear();
      return;
    }
    this.decorations.rebuild({
      root: files.rootPath,
      pathFor: (challenge, language) => files.pathFor(challenge, language),
      challenges: this.challenges,
      languages: this.config().languages,
      scoreOf: (challenge) => this.scores.get(challenge.code, challenge.max_score),
      solved: this.solved,
      dayScore: (day) => this.scores.day(this.challenges, day, this.solved),
      overall: this.scores.overall(this.challenges, this.solved),
    });
  }

  

  private activeLanguage(): Language | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    return this.config().languages.find((l) =>
      l === 'cpp' ? /\.(cpp|cc|cxx|c)$/i.test(editor.document.fileName) : /\.py$/i.test(editor.document.fileName),
    );
  }

  // ─── save / push ────────────────────────────────────────────────

  private async onDidSave(document: vscode.TextDocument): Promise<void> {
    const files = this.ensureFiles();
    if (!this.auth.token || !files || this.challenges.length === 0) {
      return;
    }
    const ref = files.resolve(document, this.challenges);
    if (!ref) {
      return;
    }

    const content = document.getText();

    const cfg = this.config();
    if (!cfg.pushOnSave || this.pushUnsupported) {
      // Without a confirmed server round-trip the baseline must stay where it
      // is: recording this content as "synced" would let the next reload
      // overwrite the edit with whatever the server still holds.
      return;
    }

    try {
      const pushed = await this.withAuth('Push', (token) =>
        this.api.pushUserCode(token, ref.challenge.code, ref.language, content),
      );
      if (!pushed.ok) {
        return;
      }
      files.markDirty(ref.challenge, ref.language, content);
      await files.flush();
      this.output.appendLine(`Pushed ${ref.challenge.code}/${ref.language}`);
      await this.refreshPanelFooter();
    } catch (err) {
      if (isUnsupported(err)) {
        this.pushUnsupported = true;
        this.output.appendLine(
          'POST /api/user/code is not supported by this server. Saving upstream will happen on Submit only.',
        );
        if (!this.pushWarningShown) {
          this.pushWarningShown = true;
          void vscode.window.showWarningMessage(
            'This Grader server has no code-save endpoint. Your edits stay local until you Submit.',
          );
        }
        return;
      }
      this.output.appendLine(`Push failed for ${ref.challenge.code}/${ref.language}: ${text(err)}`);
    }
  }

  // ─── run / submit ───────────────────────────────────────────────

  private async runActive(): Promise<void> {
    const ref = this.activeRef();
    if (!ref) {
      return;
    }
    const input = await vscode.window.showInputBox({
      title: `Run ${ref.challenge.code}`,
      prompt: 'stdin (leave empty to use the first sample input)',
      value: ref.challenge.testcases[0]?.input ?? '',
      ignoreFocusOut: true,
    });
    if (input === undefined) {
      return;
    }
    await this.runFor(ref.challenge, ref.language, { stdin: input });
  }

  /**
   * Resolve a command target: a tree item when invoked from the sidebar,
   * otherwise whatever file is active. Keeping this separate from runFor means
   * the sidebar can run a challenge that is not the one being edited.
   */
  private async runTarget(item?: ChallengeTreeItem): Promise<void> {
    if (!item?.challengeCode) {
      await this.runActive();
      return;
    }
    const challenge = this.challenges.find((c) => c.code === item.challengeCode);
    if (!challenge) {
      return;
    }
    const language =
      this.challengePanel.current?.challenge.code === challenge.code
        ? this.challengePanel.current.language
        : this.activeLanguage() ?? this.config().languages[0] ?? 'python';
    await this.runFor(challenge, language);
  }

  /**
   * Run an explicit challenge/language pair. Reading from disk rather than the
   * active editor means this also works from the panel's footer, where the
   * problem statement webview holds focus.
   */
  private async runFor(
    challenge: Challenge,
    language: Language,
    opts: { stdin?: string } = {},
  ): Promise<void> {
    const code = await this.readCodeFor(challenge, language);
    if (code === undefined) {
      return;
    }
    if (!code.trim()) {
      void vscode.window.showWarningMessage('Write some code before running.');
      return;
    }

    const stdin = opts.stdin ?? challenge.testcases[0]?.input ?? '';
    this.panel.setStatus('Running...');
    this.challengePanel.setBusy('Running...');
    this.output.show(true);
    try {
      const response = await runCode(this.api, challenge, language, code, { stdin });
      const body = formatRunOutput(response);
      this.output.appendLine(`--- Run ${challenge.code} (${language}) ---`);
      this.output.appendLine(body);
      this.panel.show({ kind: 'run', challenge, language, response, text: body });
    } catch (err) {
      this.output.appendLine(`Run failed: ${text(err)}`);
      this.panel.show({
        kind: 'run',
        challenge,
        language,
        response: { success: false, stdout: '', stderr: text(err), returncode: -1 },
        text: text(err),
      });
    } finally {
      this.challengePanel.setBusy(null);
    }
  }

  private async submitActive(): Promise<void> {
    const ref = this.activeRef();
    if (!ref) {
      return;
    }
    await this.submitFor(ref.challenge, ref.language);
  }

  private async submitTarget(item?: ChallengeTreeItem): Promise<void> {
    if (!item?.challengeCode) {
      await this.submitActive();
      return;
    }
    const challenge = this.challenges.find((c) => c.code === item.challengeCode);
    if (!challenge) {
      return;
    }
    const language =
      this.challengePanel.current?.challenge.code === challenge.code
        ? this.challengePanel.current.language
        : this.activeLanguage() ?? this.config().languages[0] ?? 'python';
    await this.submitFor(challenge, language);
  }

  /** Submit an explicit challenge/language pair, confirming first. */
  private async submitFor(challenge: Challenge, language: Language): Promise<void> {
    if (!this.auth.token) {
      void vscode.window.showWarningMessage('Sign in to Grader first.');
      return;
    }

    const code = await this.readCodeFor(challenge, language);
    if (code === undefined) {
      return;
    }
    if (!code.trim()) {
      void vscode.window.showWarningMessage('Write some code before submitting.');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Submit ${challenge.code} (${language}) to the grader?`,
      { modal: true },
      'Submit',
    );
    if (confirm !== 'Submit') {
      return;
    }

    const controller = new AbortController();
    this.panel.setStatus('Submitting...');
    this.challengePanel.setBusy('Submitting...');

    try {
      const submitted = await this.withAuth('Submit', (token) =>
        submitCode(this.api, challenge, language, code, token, {
          signal: controller.signal,
          onProgress: (message) => {
            this.panel.setStatus(message);
            this.challengePanel.setBusy(message);
            this.output.appendLine(`Submit ${challenge.code}: ${message}`);
          },
        }),
      );
      if (!submitted.ok) {
        // withAuth already reported the expiry, or the user declined to re-login.
        this.panel.show({ kind: 'status', message: 'Submit cancelled: sign-in required.' });
        return;
      }
      const { result } = submitted.value;

      this.output.appendLine(
        `Submit ${challenge.code}: ${result.passed}/${result.total} passed, score ${result.score}/${result.max_score}`,
      );
      this.panel.show({ kind: 'submit', challenge, language, result });

      // Remember the score so the panel and tree can show progress even for
      // challenges submitted in a previous session.
      await this.scores.record(challenge.code, result);

      if (!this.attempted.has(challenge.code)) {
        this.attempted.add(challenge.code);
      }
      if (result.total > 0 && result.passed === result.total) {
        this.solved.add(challenge.code);
      }

      // Submit is the only round-trip that stores code on this server, so it
      // is the one moment the local baseline can safely move forward.
      const files = this.ensureFiles();
      if (files) {
        files.markDirty(challenge, language, code);
        await files.flush();
      }

      this.refreshTree();
    } catch (err) {
      this.output.appendLine(`Submit failed: ${text(err)}`);
      void vscode.window.showErrorMessage(`Submit failed: ${text(err)}`);
      this.panel.show({ kind: 'status', message: `Submit failed: ${text(err)}` });
    } finally {
      this.challengePanel.setBusy(null);
      await this.refreshPanelFooter();
    }
  }

  /**
   * Read the code for a challenge/language pair. An open buffer wins so unsaved
   * work is what gets graded, but we warn since the server cannot see it.
   */
  private async readCodeFor(
    challenge: Challenge,
    language: Language,
  ): Promise<string | undefined> {
    const files = this.ensureFiles();
    if (!files) {
      void vscode.window.showWarningMessage('Open a folder in your workspace first.');
      return undefined;
    }

    const target = vscode.Uri.file(files.pathFor(challenge, language));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
    if (open) {
      if (open.isDirty) {
        void vscode.window.showWarningMessage(
          'Save the file first so the grader sees the current code.',
        );
      }
      return open.getText();
    }

    const onDisk = await files.readIfExists(target.fsPath);
    if (onDisk === undefined) {
      void vscode.window.showWarningMessage(
        `No file for ${challenge.code} (${language}) yet. Use "Grader: Open File" or reload challenges.`,
      );
      return undefined;
    }
    return onDisk;
  }

  private activeRef(): { challenge: Challenge; language: Language; document: vscode.TextDocument } | undefined {
    const files = this.ensureFiles();
    const editor = vscode.window.activeTextEditor;
    if (!files || !editor) {
      void vscode.window.showWarningMessage('Open a challenge file first.');
      return undefined;
    }
    const ref = files.resolve(editor.document, this.challenges);
    if (!ref) {
      void vscode.window.showWarningMessage(
        'The active file is not a synced challenge. Run "Grader: Reload Challenges" first.',
      );
      return undefined;
    }
    return { challenge: ref.challenge, language: ref.language, document: editor.document };
  }

  // ─── commands ───────────────────────────────────────────────────

  private registerCommands(): void {
    const push = (cmd: string, fn: () => void | Promise<void>) =>
      this.disposables.push(vscode.commands.registerCommand(cmd, fn));

    push('grader.login', () => {
      // An explicit sign-in is a fresh start, so lift any re-login limit.
      this.auth.expiries = 0;
      return this.login();
    });
    push('grader.logout', () => this.logout());
    push('grader.reload', () => this.reload({ silent: false }));
    push('grader.run', (item?: ChallengeTreeItem) => this.runTarget(item));
    push('grader.submit', (item?: ChallengeTreeItem) => this.submitTarget(item));
    push('grader.showOutput', () => this.panel.show({ kind: 'empty', message: 'Run or submit a challenge to see results here.' }));
    push('grader.copyStdin', (item?: ChallengeTreeItem) => this.copyStdin(item));
    push('grader.pullActiveFile', () => this.pullActive());

    push('grader.openFile', (item?: ChallengeTreeItem) => this.openFile(item));
    push('grader.showChallenge', (item?: ChallengeTreeItem) => this.showChallenge(item));
    push('grader.setApiUrl', () => this.setApiUrl());

    const view = vscode.window.createTreeView('grader.problems', {
      treeDataProvider: this.tree,
    });
    this.disposables.push(
      view,
      view.onDidExpandElement((event) => {
        if (isDay(event.element)) {
          this.tree.setExpanded(event.element.day, true);
        }
      }),
      view.onDidCollapseElement((event) => {
        if (isDay(event.element)) {
          this.tree.setExpanded(event.element.day, false);
        }
      }),
      vscode.window.registerFileDecorationProvider(this.decorations),
    );
  }

  // ─── challenge panel ─────────────────────────────────────────────

  /** Open (or focus) the split-window problem statement for a challenge. */
  private async showChallenge(item?: ChallengeTreeItem): Promise<void> {
    const files = this.ensureFiles();
    if (!files) {
      void vscode.window.showWarningMessage('Open a folder in your workspace first.');
      return;
    }

    let code = item?.challengeCode;
    if (!code) {
      const active = vscode.window.activeTextEditor;
      code = active ? files.resolve(active.document, this.challenges)?.challenge.code : undefined;
    }
    if (!code) {
      code = await vscode.window
        .showQuickPick(this.challenges.map((c) => ({ label: c.code, description: c.title })), {
          placeHolder: 'Select a challenge to show',
        })
        .then((p) => (p ? this.challenges.find((c) => c.code === p.label)?.code : undefined));
    }

    const challenge = this.challenges.find((c) => c.code === code);
    if (!challenge) {
      void vscode.window.showWarningMessage('No challenge data yet. Reload challenges first.');
      return;
    }

    const languages = this.config().languages;
    const language =
      this.challengePanel.current?.challenge.code === challenge.code
        ? this.challengePanel.current.language
        : this.activeLanguage() ?? languages[0] ?? 'python';

    this.challengePanel.show(await this.viewFor(challenge, language));
  }

  /** Build the payload the panel renders, reading current file state from disk. */
  private async viewFor(challenge: Challenge, language: Language) {
    const files = this.ensureFiles();
    const absolutePath = files?.pathFor(challenge, language);
    const code = absolutePath === undefined ? undefined : await files?.readIfExists(absolutePath);

    return {
      challenge,
      language,
      fileExists: code !== undefined,
      codeLength: code?.length ?? 0,
      solved: this.solved.has(challenge.code),
      attempted: this.attempted.has(challenge.code),
      busy: null,
      signedIn: Boolean(this.auth.token),
      languages: this.config().languages,
      score: this.scores.get(challenge.code, challenge.max_score),
      dayScore: this.challenges.length
        ? this.scores.day(this.challenges, challenge.day, this.solved)
        : undefined,
    };
  }

  /**
   * Keep the panel pointed at whatever file the user is editing. Only
   * re-renders when the challenge or language actually changed, so switching
   * back to the same file does not reset a run in flight.
   */
  private async followPanelToEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this.challengePanel.visible || this.challenges.length === 0) {
      return;
    }
    const files = this.ensureFiles();
    const ref = files?.resolve(editor.document, this.challenges);
    if (!ref) {
      return;
    }
    const current = this.challengePanel.current;
    if (current?.challenge.code === ref.challenge.code && current.language === ref.language) {
      return;
    }
    this.challengePanel.show(await this.viewFor(ref.challenge, ref.language));
  }

  /** Recompute solved/attempted/file state for whatever the panel is showing. */
  private async refreshPanelFooter(): Promise<void> {
    const current = this.challengePanel.current;
    if (!current) {
      return;
    }
    const files = this.ensureFiles();
    const path = files?.pathFor(current.challenge, current.language);
    const code = path === undefined ? undefined : await files?.readIfExists(path);
    this.challengePanel.patch({
      solved: this.solved.has(current.challenge.code),
      attempted: this.attempted.has(current.challenge.code),
      fileExists: code !== undefined,
      codeLength: code?.length ?? 0,
      signedIn: Boolean(this.auth.token),
      score: this.scores.get(current.challenge.code, current.challenge.max_score),
      dayScore: this.challenges.length
        ? this.scores.day(this.challenges, current.challenge.day, this.solved)
        : undefined,
    });
  }

  /** Dispatch a footer button. */
  private onPanelMessage(msg: PanelMessage): void {
    if (!msg || typeof msg !== 'object') {
      return;
    }

    if (msg.type === 'language') {
      const current = this.challengePanel.current;
      const next = (this.config().languages as string[]).includes(msg.language)
        ? (msg.language as Language)
        : undefined;
      if (current && next) {
        void this.viewFor(current.challenge, next).then((view) =>
          this.challengePanel.show(view),
        );
      }
      return;
    }

    if (msg.type !== 'action') {
      return;
    }

    const challenge = this.challenges.find((c) => c.code === msg.challengeCode);
    if (!challenge) {
      return;
    }
    const language = (this.config().languages as string[]).includes(msg.language)
      ? (msg.language as Language)
      : this.config().languages[0] ?? 'python';

    switch (msg.action) {
      case 'open':
        void this.openFileFor(challenge, language);
        break;
      case 'run':
        // The footer button runs the first sample input; the palette command
        // keeps the stdin prompt because it can afford to block on one.
        void this.runFor(challenge, language);
        break;
      case 'submit':
        void this.submitFor(challenge, language);
        break;
      case 'copyInput':
        void this.copyInputFor(challenge);
        break;
      case 'pull':
        void this.pullFor(challenge, language);
        break;
    }
  }

  // ─── per-target actions ──────────────────────────────────────────

  private async openFileFor(challenge: Challenge, language: Language): Promise<void> {
    const files = this.ensureFiles();
    if (!files) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(files.pathFor(challenge, language)),
    );
    await vscode.window.showTextDocument(doc, { preview: false });
    if (this.config().lazyLanguageFetch) {
      await this.ensureFileSynced(doc);
    }
  }

  private async copyInputFor(challenge: Challenge): Promise<void> {
    const combined = challenge.testcases.map((t) => t.input).join('\n');
    await vscode.env.clipboard.writeText(combined);
    void vscode.window.showInformationMessage(
      `Copied ${challenge.testcases.length} sample input(s) for ${challenge.code}`,
    );
  }

  private async pullFor(challenge: Challenge, language: Language): Promise<void> {
    const files = this.ensureFiles();
    if (!files) {
      return;
    }
    const pulled = await this.withAuth('Pull', (token) =>
      this.api.getUserCode(token, challenge.code, language),
    );
    if (!pulled.ok) {
      return;
    }
    const remote = pulled.value;
    if (!remote.trim()) {
      void vscode.window.showInformationMessage('No saved code on the server for this challenge yet.');
      return;
    }

    const target = vscode.Uri.file(files.pathFor(challenge, language));
    const decision = await files.canWrite(challenge, language, remote);
    if (!decision.writable) {
      void vscode.window.showWarningMessage(
        decision.reason === 'dirty'
          ? `${challenge.code} (${language}) has unsaved local edits; pull skipped.`
          : `Local ${challenge.code} (${language}) already matches what is on the server.`,
      );
      return;
    }

    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === target.toString(),
    );
    if (open && open.isDirty) {
      void vscode.window.showWarningMessage(
        `${challenge.code} (${language}) has unsaved changes; save or discard them before pulling.`,
      );
      return;
    }

    await files.write(challenge, language, remote);
    // The pulled content is now the local truth, so adopt it as the baseline.
    // Without this the file stays classified as locally edited and every later
    // pull is refused as a dirty overwrite.
    files.markDirty(challenge, language, remote);
    await files.flush();
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(open.uri, new vscode.Range(0, 0, open.lineCount, 0), remote);
      await vscode.workspace.applyEdit(edit);
    }
    void vscode.window.showInformationMessage(`Pulled saved code for ${challenge.code} (${language})`);
    await this.refreshPanelFooter();
  }

  private async openFile(item?: ChallengeTreeItem): Promise<void> {
    const files = this.ensureFiles();
    if (!files) {
      void vscode.window.showWarningMessage('Open a folder in your workspace first.');
      return;
    }
    let code = item?.challengeCode;
    if (!code) {
      const editor = vscode.window.activeTextEditor;
      code = editor ? files.resolve(editor.document, this.challenges)?.challenge.code : undefined;
    }
    if (!code) {
      code = await vscode.window.showQuickPick(
        this.challenges.map((c) => ({ label: c.code, description: c.title })),
        { placeHolder: 'Select a challenge to open' },
      ).then((p) => (p ? this.challenges.find((c) => c.code === p.label)?.code : undefined));
    }
    const challenge = this.challenges.find((c) => c.code === code);
    if (!challenge) {
      return;
    }

    const languages = this.config().languages;
    const language = this.activeLanguage() ?? languages[0] ?? 'python';

    // A freshly opened file may still hold only a template; replace it with the
    // server's saved code if we have not already recorded local edits.
    await this.openFileFor(challenge, language);
  }

  private async copyStdin(item?: ChallengeTreeItem): Promise<void> {
    // From the sidebar the row you right-clicked wins; from the palette it is
    // whatever file is active.
    if (item?.challengeCode) {
      const challenge = this.challenges.find((c) => c.code === item.challengeCode);
      if (challenge) {
        await this.copyInputFor(challenge);
        return;
      }
    }
    const ref = this.activeRef();
    if (!ref) {
      return;
    }
    await this.copyInputFor(ref.challenge);
  }

  private async pullActive(): Promise<void> {
    const files = this.ensureFiles();
    const editor = vscode.window.activeTextEditor;
    if (!files || !editor) {
      return;
    }
    const ref = files.resolve(editor.document, this.challenges);
    if (!ref) {
      return;
    }
    const pulled = await this.withAuth('Pull', (token) =>
      this.api.getUserCode(token, ref.challenge.code, ref.language),
    );
    if (!pulled.ok) {
      return;
    }
    const remote = pulled.value;
    if (!remote.trim()) {
      void vscode.window.showInformationMessage('No saved code on the server for this challenge yet.');
      return;
    }

    // Same guard as the footer's Pull: never replace work the user has.
    const decision = await files.canWrite(ref.challenge, ref.language, remote);
    if (!decision.writable) {
      void vscode.window.showWarningMessage(
        decision.reason === 'dirty'
          ? `${ref.challenge.code} (${ref.language}) has unsaved local edits; pull skipped.`
          : `Local ${ref.challenge.code} (${ref.language}) already matches what is on the server.`,
      );
      return;
    }
    if (editor.document.isDirty) {
      void vscode.window.showWarningMessage(
        `${ref.challenge.code} (${ref.language}) has unsaved changes; save or discard them before pulling.`,
      );
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, new vscode.Range(0, 0, editor.document.lineCount, 0), remote);
    await vscode.workspace.applyEdit(edit);
    files.markDirty(ref.challenge, ref.language, remote);
    await files.flush();
    void vscode.window.showInformationMessage(`Pulled saved code for ${ref.challenge.code}`);
    await this.refreshPanelFooter();
  }

  private async setApiUrl(): Promise<void> {
    const current = this.config().apiUrl;
    const value = await vscode.window.showInputBox({
      title: 'Grader API URL',
      value: current,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    await vscode.workspace
      .getConfiguration('grader')
      .update('apiUrl', value.trim(), vscode.ConfigurationTarget.Global);
    this.api = this.createApi();
    void vscode.window.showInformationMessage(`Grader API URL set to ${this.api.getBaseUrl()}`);
  }
}

function normalizeLanguages(values: string[]): Language[] {
  const allowed: Language[] = ['python', 'cpp'];
  const filtered = values.filter((v): v is Language =>
    (allowed as string[]).includes(v),
  );
  return filtered.length ? filtered : ['python'];
}

function isUnsupported(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 404 || status === 405 || status === 501;
}

/** A rejected token, which is worth offering a fresh sign-in for. */
function isUnauthorized(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 401;
}

/** How many times one session may be re-obtained before we stop offering. */
const MAX_REAUTHS = 3;

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const extension = new GraderExtension(context);
  context.subscriptions.push(extension);
  await extension.activate();
}

export function deactivate(): void {
  // Disposed through context.subscriptions.
}