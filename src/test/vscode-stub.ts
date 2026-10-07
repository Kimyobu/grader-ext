/**
 * Stand-in for the `vscode` module. Enough surface to activate the extension
 * headlessly in tests: enough namespace API for extension.ts to construct, plus
 * a command registry we can assert against.
 */
export class Disposable {
  constructor(private readonly fn: () => void = () => {}) {}
  dispose(): void {
    this.fn();
  }
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) {
      l(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export interface Memento {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Promise<void> | void;
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  command?: unknown;
  resourceUri?: unknown;
  contextValue?: string;
  collapsibleState?: TreeItemCollapsibleState;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  constructor(public value: string) {}
}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class WorkspaceEdit {
  readonly edits: Array<{ uri: unknown; range: unknown; text: string }> = [];
  replace(uri: unknown, range: unknown, text: string): void {
    this.edits.push({ uri, range, text });
  }
}

export const Uri = {
  file(p: string): { fsPath: string; path: string; toString(): string } {
    return { fsPath: p, path: p, toString: () => `file://${p}` };
  },
  joinPath(base: { fsPath: string }, ...segments: string[]): { fsPath: string } {
    return { fsPath: [base.fsPath, ...segments].join('/') };
  },
  parse(value: string): { scheme: string; path: string; fsPath: string; toString(): string } {
    const split = value.indexOf(':');
    const scheme = split >= 0 ? value.slice(0, split) : 'file';
    const rest = split >= 0 ? value.slice(split + 1) : value;
    const path = rest.startsWith('//') ? rest.slice(2) : rest;
    return { scheme, path, fsPath: path, toString: () => value };
  },
  from(parts: { scheme: string; path?: string; query?: string }): {
    scheme: string;
    path: string;
    fsPath: string;
    toString(): string;
  } {
    const path = parts.path ?? '';
    const query = parts.query ? `?${parts.query}` : '';
    return {
      scheme: parts.scheme,
      path,
      fsPath: path,
      toString: () => `${parts.scheme}:${path}${query}`,
    };
  },
};

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class FileDecoration {
  propagate?: boolean;
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor,
  ) {}
}

type Handler = (...args: unknown[]) => unknown;

export const registeredCommands = new Map<string, Handler>();
export const emittedContexts: Array<[string, unknown]> = [];
export const shownMessages: Array<{ level: string; text: string }> = [];
/** Canned answers for window.showInputBox, consumed in order. */
export const inputQueue: string[] = [];

export const commands = {
  registerCommand(id: string, handler: Handler): Disposable {
    registeredCommands.set(id, handler);
    return new Disposable(() => registeredCommands.delete(id));
  },
  async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
    if (id === 'setContext') {
      emittedContexts.push([args[0] as string, args[1]]);
      return undefined;
    }
    const handler = registeredCommands.get(id);
    return handler ? ((await handler(...args)) as T) : undefined;
  },
};

export interface StubWebviewPanel {
  viewType: string;
  title: string;
  viewColumn: unknown;
  webview: {
    html: string;
    onDidReceiveMessage: (listener: (msg: unknown) => void) => Disposable;
    asWebviewUri: (u: unknown) => unknown;
    /** Test helper: pretend the webview posted a message. */
    __post: (msg: unknown) => void;
  };
  reveal: (column?: unknown, preserveFocus?: boolean) => void;
  dispose: () => void;
  onDidDispose: (listener: () => void) => Disposable;
  /** Test helper: pretend the user closed the panel. */
  __fireDispose: () => void;
}

/** Every panel created during a test, newest last. */
export const createdPanels: StubWebviewPanel[] = [];
/** Tree data providers, keyed by view id, so tests can read what is shown. */
export const treeProviders = new Map<string, unknown>();

export interface StubTreeView {
  treeDataProvider: unknown;
  onDidExpandElement: (listener: (event: { element: unknown }) => void) => Disposable;
  onDidCollapseElement: (listener: (event: { element: unknown }) => void) => Disposable;
  dispose: () => void;
  __expand: (element: unknown) => void;
  __collapse: (element: unknown) => void;
}

export const treeViews = new Map<string, StubTreeView>();

export interface StubFileDecorationProvider {
  provideFileDecoration(uri: { fsPath: string }):
    | { badge?: string; tooltip?: string; color?: { id: string } }
    | undefined;
}

export const decorationProviders: StubFileDecorationProvider[] = [];

export const window = {
  createOutputChannel(_name: string) {
    return { appendLine(): void {}, show(): void {}, dispose(): void {} };
  },
  createWebviewPanel(viewType: string, title: string, column?: unknown, _options?: unknown) {
    const received = new EventEmitter<unknown>();
    const disposed = new EventEmitter<void>();
    // The real API takes { viewColumn, preserveFocus }; record the column alone.
    const resolveColumn = (value: unknown): unknown =>
      value && typeof value === 'object' && 'viewColumn' in value
        ? (value as { viewColumn: unknown }).viewColumn
        : value;
    const panel: StubWebviewPanel = {
      viewType,
      title,
      viewColumn: resolveColumn(column),
      webview: {
        html: '',
        onDidReceiveMessage: (listener) => received.event(listener),
        asWebviewUri: (u: unknown) => u,
        __post: (msg) => received.fire(msg),
      },
      reveal(nextColumn?: unknown, _preserveFocus?: boolean) {
        panel.viewColumn = resolveColumn(nextColumn);
      },
      dispose() {
        disposed.fire();
      },
      onDidDispose: disposed.event,
      __fireDispose: () => disposed.fire(),
    };
    createdPanels.push(panel);
    return panel;
  },
  registerTreeDataProvider(id: string, provider: unknown): Disposable {
    treeProviders.set(id, provider);
    return new Disposable(() => treeProviders.delete(id));
  },
  createTreeView(id: string, options: { treeDataProvider: unknown }): StubTreeView {
    treeProviders.set(id, options.treeDataProvider);
    const expanded = new EventEmitter<{ element: unknown }>();
    const collapsed = new EventEmitter<{ element: unknown }>();
    const view: StubTreeView = {
      treeDataProvider: options.treeDataProvider,
      onDidExpandElement: (listener) => expanded.event(listener),
      onDidCollapseElement: (listener) => collapsed.event(listener),
      dispose() {
        treeProviders.delete(id);
        treeViews.delete(id);
      },
      __expand: (element) => expanded.fire({ element }),
      __collapse: (element) => collapsed.fire({ element }),
    };
    treeViews.set(id, view);
    return view;
  },
  registerFileDecorationProvider(provider: StubFileDecorationProvider): Disposable {
    decorationProviders.push(provider);
    return new Disposable(() => {
      const index = decorationProviders.indexOf(provider);
      if (index >= 0) {
        decorationProviders.splice(index, 1);
      }
    });
  },
  showInputBox(opts?: { value?: string }): Promise<string | undefined> {
    // Mirrors the real box: a queued answer wins, otherwise the user accepts
    // the pre-filled default.
    return Promise.resolve(inputQueue.shift() ?? opts?.value);
  },
  showWarningMessage(text: string, ...rest: unknown[]): Promise<unknown> {
    shownMessages.push({ level: 'warn', text });
    // The real signature is (message, ...items) or (message, options, ...items).
    // Distinguish them the way the overloads do, so a test can see which
    // choice the extension offered.
    const choices =
      rest.length > 0 && typeof rest[0] === 'object' && rest[0] !== null ? rest.slice(1) : rest;
    // Answers with the first offered choice, or undefined when the extension is
    // only informing the user.
    return Promise.resolve(choices[0]);
  },
  showErrorMessage(text: string): Promise<undefined> {
    shownMessages.push({ level: 'error', text });
    return Promise.resolve(undefined);
  },
  showInformationMessage(text: string, ...choices: unknown[]): Promise<unknown> {
    shownMessages.push({ level: 'info', text });
    return Promise.resolve(choices[0]);
  },
  showQuickPick(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  withProgress<T>(_opts: unknown, task: (progress: unknown) => Promise<T>): Promise<T> {
    return task({ report(): void {} });
  },
  showTextDocument(): Promise<unknown> {
    return Promise.resolve(undefined);
  },
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor(listener: (editor: unknown) => void): Disposable {
    return activeEditorChanged.event(listener);
  },
};

const configuration: Record<string, unknown> = {};
const saved = new EventEmitter<unknown>();
const activeEditorChanged = new EventEmitter<unknown>();

/** Test helper: pretend the user saved a document. */
export function __fireSave(document: unknown): Promise<void> {
  saved.fire(document);
  return Promise.resolve();
}

/** Test helper: pretend the user focused another editor. */
export function __fireActiveEditor(editor: unknown): Promise<void> {
  (window as { activeTextEditor?: unknown }).activeTextEditor = editor;
  activeEditorChanged.fire(editor);
  return Promise.resolve();
}

export const workspace = {
  workspaceFolders: undefined as unknown,
  getConfiguration(_section: string) {
    return {
      get<T>(key: string, defaultValue?: T): T | undefined {
        const full = `${_section}.${key}`;
        return full in configuration ? (configuration[full] as T) : defaultValue;
      },
      async update(key: string, value: unknown): Promise<void> {
        configuration[`${_section}.${key}`] = value;
      },
    };
  },
  onDidSaveTextDocument(listener: (doc: unknown) => void): Disposable {
    return saved.event(listener);
  },
  onDidChangeConfiguration: () => new Disposable(),
  openTextDocument: () => Promise.resolve({ isDirty: false, lineCount: 1 }),
  applyEdit: () => Promise.resolve(true),
  textDocuments: [] as unknown[],
};

export const env = {
  clipboard: {
    async writeText(): Promise<void> {},
  },
};

export const ProgressLocation = {
  Notification: 15,
  Window: 10,
  SourceControl: 1,
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

/** Test helpers, not part of the real vscode API. */
export function __setConfig(key: string, value: unknown): void {
  configuration[key] = value;
}

export function __setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined): void {
  (workspace as { workspaceFolders?: unknown }).workspaceFolders = folders;
}

export function __reset(): void {
  registeredCommands.clear();
  emittedContexts.length = 0;
  shownMessages.length = 0;
  inputQueue.length = 0;
  createdPanels.length = 0;
  treeProviders.clear();
  treeViews.clear();
  decorationProviders.length = 0;
  workspace.textDocuments.length = 0;
  saved.dispose();
  activeEditorChanged.dispose();
  (workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
  window.activeTextEditor = undefined;
  for (const key of Object.keys(configuration)) {
    delete configuration[key];
  }
}