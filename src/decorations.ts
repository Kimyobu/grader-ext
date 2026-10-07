import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Challenge, Language } from './api';
import { dayFolderName } from './files';
import {
  COLOR_IDS,
  aggregateState,
  explorerBadge,
  scoreFraction,
  scoreState,
  type ScoreState,
} from './icons';
import type { ChallengeScore, DayScore } from './scores';

export interface DecorationSource {
  root: string;
  pathFor(challenge: Challenge, language: Language): string;
  challenges: Challenge[];
  languages: Language[];
  scoreOf(challenge: Challenge): ChallengeScore | undefined;
  solved: ReadonlySet<string>;
  dayScore(day: string): DayScore;
  overall: DayScore;
}

function pointsText(score: ChallengeScore | undefined, state: ScoreState, fraction: number): string {
  if (state === 'none') {
    return 'not started';
  }
  if (!score) {
    return 'full score';
  }
  if (state === 'zero') {
    return `0/${score.max} pts`;
  }
  const pct = Math.round(fraction * 100);
  return state === 'full' ? `${score.best}/${score.max} pts` : `${score.best}/${score.max} pts · ${pct}%`;
}

export class GraderDecorationProvider implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<
    undefined | vscode.Uri | vscode.Uri[]
  >();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private badges = new Map<string, vscode.FileDecoration>();
  private paths = new Set<string>();

  rebuild(source: DecorationSource): void {
    const next = new Map<string, vscode.FileDecoration>();
    const days = new Set<string>();

    for (const challenge of source.challenges) {
      const score = source.scoreOf(challenge);
      const solved = source.solved.has(challenge.code);
      const state = scoreState({
        best: score?.best,
        max: score?.max ?? challenge.max_score,
        solved,
      });
      const fraction = score ? scoreFraction(score.best, score.max) : solved ? 1 : 0;
      const summary = `${challenge.code} ${challenge.title} — ${pointsText(score, state, fraction)}`;
      for (const language of source.languages) {
        next.set(
          source.pathFor(challenge, language),
          new vscode.FileDecoration(
            explorerBadge(state, fraction),
            `${summary} (${language})`,
            new vscode.ThemeColor(COLOR_IDS[state]),
          ),
        );
      }
      days.add(challenge.day);
    }

    for (const day of days) {
      const score = source.dayScore(day);
      const state = aggregateState(score);
      next.set(
        path.join(source.root, dayFolderName(day)),
        new vscode.FileDecoration(
          explorerBadge(state, scoreFraction(score.earned, score.max)),
          `${day} — ${score.earned}/${score.max} pts · ${score.solved}/${score.total} solved`,
          new vscode.ThemeColor(COLOR_IDS[state]),
        ),
      );
    }

    const overallState = aggregateState(source.overall);
    next.set(
      source.root,
      new vscode.FileDecoration(
        explorerBadge(overallState, scoreFraction(source.overall.earned, source.overall.max)),
        `Grader — ${source.overall.solved}/${source.overall.total} solved · ${source.overall.earned}/${source.overall.max} pts`,
        new vscode.ThemeColor(COLOR_IDS[overallState]),
      ),
    );

    this.badges = next;
    this.fireChange(new Set(next.keys()));
  }

  clear(): void {
    this.badges = new Map();
    this.fireChange(new Set());
  }

  private fireChange(after: Set<string>): void {
    const before = this.paths;
    this.paths = after;
    const changed = [...new Set([...before, ...after])].map((p) => vscode.Uri.file(p));
    this.emitter.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.badges.get(uri.fsPath);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
