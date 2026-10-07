import type * as vscode from 'vscode';
import type { Challenge } from './api';
import type { ChallengeScore, DayScore } from './challengePanel';

export type { ChallengeScore, DayScore };

const SCORES_KEY = 'grader.scores';

interface StoredScore {
  best: number;
  max: number;
  at: string;
}

type ScoreMap = Record<string, StoredScore>;

/**
 * Best-score-per-challenge, persisted in workspace state.
 *
 * The server's /api/user/solved endpoint returns only which codes were solved
 * and attempted, never a score, so the only source of points is a submit result
 * this client has seen. Keeping them locally is what lets the panel and tree
 * show progress for challenges submitted in an earlier session.
 */
export class ScoreStore {
  private readonly scores = new Map<string, StoredScore>();

  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<ScoreMap>(SCORES_KEY, {});
    for (const [code, value] of Object.entries(stored)) {
      if (typeof value?.best === 'number' && typeof value?.max === 'number') {
        this.scores.set(code, value);
      }
    }
  }

  /**
   * Record a submit result. A worse score than the one already stored is kept
   * out, so re-running a challenge cannot lower the number the user sees.
   */
  async record(
    challengeCode: string,
    result: { score: number; max_score: number },
    at = new Date().toISOString(),
  ): Promise<void> {
    const previous = this.scores.get(challengeCode);
    if (previous && previous.best >= result.score) {
      // Still refresh the timestamp so the "scored on" line stays truthful.
      previous.at = at;
    } else {
      this.scores.set(challengeCode, {
        best: result.score,
        max: result.max_score,
        at,
      });
    }
    await this.flush();
  }

  get(challengeCode: string, fallbackMax: number): ChallengeScore | undefined {
    const stored = this.scores.get(challengeCode);
    if (!stored) {
      return undefined;
    }
    return { best: stored.best, max: stored.max || fallbackMax, at: stored.at };
  }

  /**
   * Points earned and available for one day. `solved` counts challenges with a
   * recorded full score, which is the closest we can get to server truth
   * without a scores endpoint.
   */
  day(challenges: Challenge[], day: string, solvedCodes: ReadonlySet<string>): DayScore {
    let earned = 0;
    let max = 0;
    let solved = 0;
    let started = 0;
    for (const c of challenges) {
      if (c.day !== day) {
        continue;
      }
      max += c.max_score;
      const score = this.scores.get(c.code);
      if (score) {
        started += 1;
        earned += Math.min(score.best, c.max_score);
      }
      if (solvedCodes.has(c.code) || (score && score.best >= c.max_score)) {
        solved += 1;
      }
    }
    return {
      earned,
      max,
      solved,
      total: challenges.filter((c) => c.day === day).length,
      started,
    };
  }

  /** Points earned across every day, for the tree view summary. */
  overall(challenges: Challenge[], solvedCodes: ReadonlySet<string>): DayScore {
    let earned = 0;
    let max = 0;
    let solved = 0;
    let started = 0;
    for (const c of challenges) {
      max += c.max_score;
      const score = this.scores.get(c.code);
      if (score) {
        started += 1;
        earned += Math.min(score.best, c.max_score);
      }
      if (solvedCodes.has(c.code) || (score && score.best >= c.max_score)) {
        solved += 1;
      }
    }
    return { earned, max, solved, total: challenges.length, started };
  }

  async flush(): Promise<void> {
    await this.state.update(SCORES_KEY, Object.fromEntries(this.scores));
  }
}
