import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Challenge, Language } from './api';
import { extensionFor, languageFromFileName } from './template';

const SYNC_HASH_KEY = 'grader.syncedHashes';

export interface FileRef {
  challenge: Challenge;
  language: Language;
  absolutePath: string;
}

/**
 * Folder name for a day, keeping the server's own spelling: "Day 01" -> "Day 01".
 */
export function dayFolderName(day: string): string {
  const cleaned = day.trim().replace(/\s+/g, ' ');
  return cleaned || 'Unsorted';
}

/** The pre-2024 layout collapsed the space: "Day 01" -> "Day01". */
export function legacyDayFolderName(day: string): string {
  const cleaned = day.trim().replace(/\s+/g, '');
  return cleaned || 'Unsorted';
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class ChallengeFiles {
  private readonly hashes: Map<string, string>;

  constructor(
    private readonly state: vscode.Memento,
    private readonly root: string,
  ) {
    const stored = state.get<Record<string, string>>(SYNC_HASH_KEY, {});
    this.hashes = new Map(Object.entries(stored));
  }

  private static key(challengeCode: string, language: Language): string {
    return `${challengeCode}|${language}`;
  }

  /** Absolute path for a challenge/language pair. */
  pathFor(challenge: Challenge, language: Language): string {
    const dir = path.join(this.root, dayFolderName(challenge.day));
    return path.join(dir, challenge.code + extensionFor(language));
  }

  get rootPath(): string {
    return this.root;
  }

  dayPath(day: string): string {
    return path.join(this.root, dayFolderName(day));
  }

  /**
   * Resolve an open document back to a challenge. Matches on the file's parent
   * folder (day) and base name (challenge code) so unrelated files never match.
   */
  resolve(document: vscode.TextDocument, challenges: Challenge[]): FileRef | undefined {
    const language = languageFromFileName(document.fileName);
    if (!language) {
      return undefined;
    }
    const dirName = path.basename(path.dirname(document.fileName));
    const baseName = path.basename(document.fileName, path.extname(document.fileName));

    const match = challenges.find(
      (c) => c.code === baseName && dayFolderName(c.day) === dirName,
    );
    if (!match) {
      return undefined;
    }
    return {
      challenge: match,
      language,
      absolutePath: this.pathFor(match, language),
    };
  }

  async readIfExists(absolutePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(absolutePath, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Decide whether a file may be overwritten during sync. Local edits win:
   * we only write when the file is missing or still matches what we last synced.
   */
  async canWrite(challenge: Challenge, language: Language, incoming: string): Promise<{
    writable: boolean;
    reason: string;
    content?: string;
  }> {
    const absolutePath = this.pathFor(challenge, language);
    const current = await this.readIfExists(absolutePath);

    if (current === undefined) {
      return { writable: true, reason: 'missing' };
    }

    const lastSynced = this.hashes.get(ChallengeFiles.key(challenge.code, language));
    if (lastSynced === undefined) {
      // First sync of an existing file: adopt it as-is rather than clobber it.
      return { writable: false, reason: 'untracked', content: current };
    }

    if (hashContent(current) !== lastSynced) {
      return { writable: false, reason: 'dirty' };
    }

    if (current === incoming) {
      return { writable: false, reason: 'identical' };
    }

    return { writable: true, reason: 'stale' };
  }

  async write(challenge: Challenge, language: Language, content: string): Promise<string> {
    const absolutePath = this.pathFor(challenge, language);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
    this.hashes.set(ChallengeFiles.key(challenge.code, language), hashContent(content));
    return absolutePath;
  }

  /** Mark a file as locally edited so reload leaves it alone. */
  markDirty(challenge: Challenge, language: Language, content: string): void {
    this.hashes.set(ChallengeFiles.key(challenge.code, language), hashContent(content));
  }

  async flush(): Promise<void> {
    await this.state.update(SYNC_HASH_KEY, Object.fromEntries(this.hashes));
  }

  /**
   * Move folders written by the old "Day01" layout to the server's own
   * "Day 01" spelling. Returns one message per folder that moved, so the caller
   * can surface it. Existing destinations are merged file by file rather than
   * overwritten, since the destination may hold newer work.
   */
  async migrateDayFolders(challenges: Challenge[]): Promise<string[]> {
    const moved: string[] = [];
    const days = [...new Set(challenges.map((c) => c.day))];

    for (const day of days) {
      const from = path.join(this.root, legacyDayFolderName(day));
      const to = path.join(this.root, dayFolderName(day));
      if (from === to) {
        continue;
      }
      if (!(await isDirectory(from))) {
        continue;
      }

      let entries: string[];
      try {
        entries = await fs.readdir(from);
      } catch {
        continue;
      }

      await fs.mkdir(to, { recursive: true });
      for (const entry of entries) {
        const source = path.join(from, entry);
        const target = path.join(to, entry);
        if (await exists(target)) {
          // A file of the same name is already here; keep both by leaving the
          // legacy one untouched under its old name.
          continue;
        }
        try {
          await fs.rename(source, target);
        } catch {
          // A cross-device rename can fail; fall back to copy+unlink.
          try {
            await fs.copyFile(source, target);
            await fs.unlink(source);
          } catch {
            continue;
          }
        }
      }

      if (!(await isDirectory(from)) || (await fs.readdir(from)).length === 0) {
        await fs.rmdir(from).catch(() => undefined);
      }
      moved.push(`${legacyDayFolderName(day)} \u2192 ${dayFolderName(day)}`);
    }

    return moved;
  }

  dispose(): void {
    void this.flush();
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    throw err;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (err) {
    if (isNotFound(err)) {
      return false;
    }
    throw err;
  }
}