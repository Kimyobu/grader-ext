import * as vscode from 'vscode';

export type ScoreState = 'full' | 'partial' | 'zero' | 'none';

export interface ScoreInput {
  best?: number;
  max: number;
  solved?: boolean;
}

export const PALETTES = {
  light: { green: '#1a7f37', yellow: '#bf8700', red: '#cf222e', gray: '#8c959f', track: '#d0d7de' },
  dark: { green: '#3fb950', yellow: '#d29922', red: '#f85149', gray: '#6e7681', track: '#30363d' },
} as const;

export const COLOR_IDS: Record<ScoreState, string> = {
  full: 'krusomchai.grader.score.full',
  partial: 'krusomchai.grader.score.partial',
  zero: 'krusomchai.grader.score.zero',
  none: 'krusomchai.grader.score.none',
};

export function scoreFraction(best: number | undefined, max: number): number {
  if (best === undefined || best <= 0) {
    return 0;
  }
  if (max <= 0) {
    return 1;
  }
  return Math.min(1, best / max);
}

export function scoreState(input: ScoreInput): ScoreState {
  if (input.best !== undefined) {
    const fraction = scoreFraction(input.best, input.max);
    if (fraction <= 0) {
      return 'zero';
    }
    return fraction >= 1 ? 'full' : 'partial';
  }
  return input.solved ? 'full' : 'none';
}

export function aggregateState(score: { earned: number; max: number; started: number }): ScoreState {
  if (score.started <= 0 || score.max <= 0) {
    return 'none';
  }
  if (score.earned <= 0) {
    return 'zero';
  }
  return score.earned >= score.max ? 'full' : 'partial';
}

export function explorerBadge(state: ScoreState, fraction: number): string {
  if (state === 'full') {
    return '\u2713';
  }
  if (state === 'zero') {
    return '0';
  }
  if (state === 'none') {
    return '\u2013';
  }
  return String(Math.min(99, Math.max(1, Math.round(fraction * 100))));
}

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function progressSvg(state: ScoreState, fraction: number, theme: 'light' | 'dark'): string {
  const palette = PALETTES[theme];
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">';
  if (state === 'full') {
    return `${head}<circle cx="8" cy="8" r="7" fill="${palette.green}"/><path d="M4.6 8.4 7 10.8 11.4 5.8" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (state === 'zero') {
    return `${head}<circle cx="8" cy="8" r="${RADIUS}" fill="none" stroke="${palette.red}" stroke-width="2"/></svg>`;
  }
  if (state === 'none') {
    return `${head}<circle cx="8" cy="8" r="${RADIUS}" fill="none" stroke="${palette.gray}" stroke-width="2"/></svg>`;
  }
  const arc = Math.max(1, fraction * CIRCUMFERENCE).toFixed(2);
  const rest = CIRCUMFERENCE.toFixed(2);
  return `${head}<circle cx="8" cy="8" r="${RADIUS}" fill="none" stroke="${palette.track}" stroke-width="2"/><circle cx="8" cy="8" r="${RADIUS}" fill="none" stroke="${palette.yellow}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${arc} ${rest}" transform="rotate(-90 8 8)"/></svg>`;
}

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function progressIcon(
  state: ScoreState,
  fraction: number,
): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.parse(dataUri(progressSvg(state, fraction, 'light'))),
    dark: vscode.Uri.parse(dataUri(progressSvg(state, fraction, 'dark'))),
  };
}
