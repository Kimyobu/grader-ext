import * as vscode from 'vscode';

const TOKEN_KEY = 'grader.token';
const USER_KEY = 'grader.username';

export interface Session {
  token: string;
  username: string;
}

export class AuthStore {
  private session: Session | undefined;
  /**
   * How many times the session has been re-obtained because the server kept
   * rejecting the token. Cleared by an explicit `Grader: Login`, which bounds
   * the automatic re-login loop without penalising a deliberate sign-in.
   */
  expiries = 0;
  private readonly onChangeEmitter = new vscode.EventEmitter<Session | undefined>();

  readonly onDidChangeSession = this.onChangeEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async restore(): Promise<Session | undefined> {
    const [token, username] = await Promise.all([
      this.secrets.get(TOKEN_KEY),
      this.secrets.get(USER_KEY),
    ]);
    this.session = token && username ? { token, username } : undefined;
    return this.session;
  }

  get current(): Session | undefined {
    return this.session;
  }

  get token(): string | undefined {
    return this.session?.token;
  }

  async set(session: Session): Promise<void> {
    this.session = session;
    await Promise.all([
      this.secrets.store(TOKEN_KEY, session.token),
      this.secrets.store(USER_KEY, session.username),
    ]);
    this.onChangeEmitter.fire(session);
  }

  async clear(): Promise<void> {
    this.session = undefined;
    await Promise.all([
      this.secrets.delete(TOKEN_KEY),
      this.secrets.delete(USER_KEY),
    ]);
    this.onChangeEmitter.fire(undefined);
  }

  dispose(): void {
    this.onChangeEmitter.dispose();
  }
}