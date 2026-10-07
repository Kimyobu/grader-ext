import type { Challenge, GraderApi, Language } from './api';
import type { ChallengeFiles } from './files';
import { starterCode } from './template';

export interface SyncDeps {
  api: GraderApi;
  token: string;
  files: ChallengeFiles;
}

export interface SyncOptions {
  languages: Language[];
  concurrency: number;
  /** Skip API fetches and only materialize missing files from templates. */
  templatesOnly?: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface SyncReport {
  written: string[];
  skippedDirty: string[];
  skippedErrors: string[];
  fromTemplate: string[];
  total: number;
}

export async function syncChallenges(
  challenges: Challenge[],
  deps: SyncDeps,
  options: SyncOptions,
): Promise<SyncReport> {
  const report: SyncReport = {
    written: [],
    skippedDirty: [],
    skippedErrors: [],
    fromTemplate: [],
    total: challenges.length * options.languages.length,
  };

  const jobs: Array<{ challenge: Challenge; language: Language }> = [];
  for (const challenge of challenges) {
    for (const language of options.languages) {
      jobs.push({ challenge, language });
    }
  }

  const total = jobs.length;
  let done = 0;

  for (const batch of chunk(jobs, Math.max(1, options.concurrency))) {
    await Promise.all(
      batch.map(async ({ challenge, language }) => {
        const display = `${challenge.code}/${language}`;
        try {
          let incoming: string;
          let isTemplate = false;

          if (options.templatesOnly) {
            incoming = starterCode(language);
            isTemplate = true;
          } else {
            try {
              const remote = await deps.api.getUserCode(deps.token, challenge.code, language);
              // An unwritten challenge gets the starter template, mirroring how
              // the web UI falls back to getStarterCode when nothing is stored.
              incoming = remote.trim() ? remote : starterCode(language);
              isTemplate = !remote.trim();
            } catch (err) {
              // A failed fetch should not block creating the file. Fall back to
              // the template and report it so the next reload can pick up the
              // real code once the API is healthy again.
              report.skippedErrors.push(`${display}: ${errText(err)}`);
              incoming = starterCode(language);
              isTemplate = true;
            }
          }

          const decision = await deps.files.canWrite(challenge, language, incoming);
          if (decision.writable) {
            await deps.files.write(challenge, language, incoming);
            report.written.push(display);
            if (isTemplate) {
              report.fromTemplate.push(display);
            }
          } else if (decision.reason === 'dirty') {
            report.skippedDirty.push(display);
          } else if (decision.reason === 'untracked' && decision.content !== undefined) {
            // First time we see this file: adopt its content as the baseline so
            // future reloads can tell our edits from the user's.
            deps.files.markDirty(challenge, language, decision.content);
          }
        } catch (err) {
          report.skippedErrors.push(`${display}: ${errText(err)}`);
        } finally {
          done++;
          options.onProgress?.(done, total, display);
        }
      }),
    );
  }

  await deps.files.flush();
  return report;
}

function* chunk<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}