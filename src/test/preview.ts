/**
 * Dumps the real detail-panel HTML for a challenge so it can be eyeballed or
 * screenshotted. A development aid, not part of the test suite.
 *
 *   npm run preview -- /path/to/challenges.json [challengeCode]
 *
 * `challenges.json` is the decoded body of GET /api/challenges, i.e.
 * `{ "challenges": [ ... ] }`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Challenge } from '../api';
import { ChallengePanel, ChallengeView } from '../challengePanel';

const [, , input, code = 'B01'] = process.argv;
if (!input) {
  console.error('usage: npm run preview -- <challenges.json> [challengeCode]');
  process.exit(1);
}

const chs: Challenge[] = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8')).challenges;
const challenge = chs.find((c) => c.code === code);
if (!challenge) {
  console.error(`no challenge ${code} in ${input}`);
  process.exit(1);
}

const view: ChallengeView = {
  challenge,
  language: 'python',
  fileExists: true,
  codeLength: 120,
  solved: true,
  attempted: true,
  busy: null,
  signedIn: true,
  languages: ['python', 'cpp'],
  score: { best: 7, max: challenge.max_score },
  dayScore: {
    earned: 130,
    max: 240,
    solved: 13,
    total: 24,
    started: 18,
  },
};

const panel = new ChallengePanel(() => {});
// Reach the private renderer; this file exists only to look at the output.
const html = (panel as unknown as { html(v: ChallengeView): string }).html(view);
const out = path.join(__dirname, 'panel-preview.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes) for ${code}`);
