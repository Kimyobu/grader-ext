import * as vscode from 'vscode';
import { aggregateState, progressIcon, scoreFraction, scoreState } from './icons';
import type { ChallengeScore, DayScore } from './scores';

export interface DayGroup {
  day: string;
  /** Server's day string, used as the sort key so Day 2 precedes Day 10. */
  label: string;
  score: DayScore;
  /** The day folder in the workspace, so the row is decorated like its files. */
  resourceUri?: vscode.Uri;
}

export class ChallengeTreeItem extends vscode.TreeItem {
  constructor(
    readonly challengeCode: string,
    readonly title: string,
    readonly day: string,
    readonly difficulty: string,
    readonly solved: boolean,
    readonly attempted: boolean,
    readonly resourceUri: vscode.Uri | undefined,
    readonly score?: ChallengeScore,
  ) {
    super(challengeCode, vscode.TreeItemCollapsibleState.None);
    this.label = `${challengeCode}  ${title}`;
    this.description = [day, difficulty, scoreLabel(score)].filter(Boolean).join(' \u00b7 ');
    this.iconPath = progressIcon(
      scoreState({ best: score?.best, max: score?.max ?? 0, solved }),
      score ? scoreFraction(score.best, score.max) : solved ? 1 : 0,
    );
    this.contextValue = 'grader.challenge';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${challengeCode}** ${title}`,
        '',
        [day, difficulty, score?.best !== undefined ? `${score.best}/${score.max} pts` : '']
          .filter(Boolean)
          .join(' \u00b7 '),
      ].join('\n'),
    );
    this.command = {
      command: 'grader.showChallenge',
      title: 'Show Challenge',
      arguments: [this],
    };
    this.resourceUri = resourceUri;
  }
}

/** A collapsible day folder in the sidebar. */
export class DayTreeItem extends vscode.TreeItem {
  constructor(
    readonly day: string,
    readonly score: DayScore,
    expanded = false,
    readonly resourceUri?: vscode.Uri,
  ) {
    super(day, expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${score.earned}/${score.max} pts \u00b7 ${score.solved}/${score.total} solved`;
    this.iconPath = progressIcon(
      aggregateState(score),
      scoreFraction(score.earned, score.max),
    );
    this.contextValue = 'grader.day';
    this.tooltip = new vscode.MarkdownString(
      [
        `**${day}**`,
        '',
        `${score.earned} of ${score.max} points`,
        `${score.solved} of ${score.total} challenges solved`,
      ].join('\n'),
    );
  }
}

export type TreeNode = ChallengeTreeItem | DayTreeItem;

export function isDay(node: TreeNode): node is DayTreeItem {
  return node instanceof DayTreeItem;
}

function scoreLabel(score?: ChallengeScore): string {
  if (!score || score.best === undefined) {
    return '';
  }
  return `${score.best}/${score.max} pts`;
}

export class ChallengeTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Day key -> that day's challenges, in server order. */
  private groups: Array<{ day: string; items: ChallengeTreeItem[] }> = [];
  private dayScores = new Map<string, DayScore>();
  private dayUris = new Map<string, vscode.Uri | undefined>();
  private readonly expandedDays = new Set<string>();
  private loaded = false;
  private emptyMessage = 'Run "Grader: Reload Challenges" to sync';

  setExpanded(day: string, expanded: boolean): void {
    if (expanded) {
      this.expandedDays.add(day);
    } else {
      this.expandedDays.delete(day);
    }
  }

  refresh(items: ChallengeTreeItem[], days: DayGroup[] = []): void {
    const byDay = new Map<string, ChallengeTreeItem[]>();
    for (const item of items) {
      const bucket = byDay.get(item.day);
      if (bucket) {
        bucket.push(item);
      } else {
        byDay.set(item.day, [item]);
      }
    }
    // Sort on the numeric part so Day 2 comes before Day 10.
    this.groups = [...byDay.entries()]
      .map(([day, groupItems]) => ({ day, items: groupItems }))
      .sort((a, b) => daySortKey(a.day) - daySortKey(b.day) || a.day.localeCompare(b.day));
    this.dayScores = new Map(days.map((d) => [d.day, d.score]));
    this.dayUris = new Map(days.map((d) => [d.day, d.resourceUri]));
    this.loaded = true;
    this.emitter.fire(undefined);
  }

  setEmpty(message: string): void {
    this.groups = [];
    this.loaded = true;
    this.emptyMessage = message;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      return isDay(element) ? (this.groups.find((g) => g.day === element.day)?.items ?? []) : [];
    }
    if (!this.loaded) {
      return [placeholder('$(sync~spin) Loading challenges...')];
    }
    if (this.groups.length === 0) {
      return [placeholder(`$(info) ${this.emptyMessage}`)];
    }
    return this.groups.map(
      (group) =>
        new DayTreeItem(
          group.day,
          this.dayScores.get(group.day) ?? emptyScore(),
          this.expandedDays.has(group.day),
          this.dayUris.get(group.day),
        ),
    );
  }

  getChallenge(code: string): ChallengeTreeItem | undefined {
    for (const group of this.groups) {
      const found = group.items.find((i) => i.challengeCode === code);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function daySortKey(day: string): number {
  const digits = /(\d+)/.exec(day);
  return digits ? Number(digits[1]) : Number.MAX_SAFE_INTEGER;
}

function emptyScore(): DayScore {
  return { earned: 0, max: 0, solved: 0, total: 0, started: 0 };
}

function placeholder(label: string): ChallengeTreeItem {
  const item = new ChallengeTreeItem('', '', '', '', false, false, undefined);
  item.label = label;
  item.description = undefined;
  item.iconPath = undefined;
  item.command = undefined;
  item.contextValue = 'grader.placeholder';
  item.tooltip = undefined;
  return item;
}
