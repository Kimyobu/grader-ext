# POSN Grader for VS Code

Syncs the POSN Grader challenges into your workspace so you can write, run and
submit code without leaving the editor.

## Features

- **Login** with username and password; the token is kept in VS Code's
  `SecretStorage`, never in workspace state.
- **Sync all challenges** from `GET /api/challenges` into
  `grader/Day 01/B01.py` + `grader/Day 01/B01.cpp`, grouped by the challenge's
  day exactly as the server names it. Challenges you have already written get
  your saved code pulled down; unwritten ones get the starter template for that
  language. Folders from the older `Day01` layout are renamed on the next sync,
  file by file, and a file that already exists in the new folder is left alone.
- **Your local edits are never clobbered.** The extension tracks a hash of what
  it last synced per file, so reloading only overwrites a file when it is
  missing or still identical to what was synced. A file you edited is left
  alone and listed in the Grader output channel.
- **Run** the active file against a chosen stdin (defaults to the first sample
  input) and see raw stdout/stderr.
- **Submit** to the real grader, poll the job queue, and get a per-testcase
  table: input, expected, actual, pass/fail, stderr, plus score.
- **Solved / attempted markers** in the sidebar, from `GET /api/user/solved`.
- **Challenges grouped by day** in the sidebar, one collapsible folder per day
  sorted numerically (`Day 02` before `Day 10`), each labelled with the points
  earned and how many of its challenges are solved.
- **Score display.** The best score per challenge is remembered in workspace
  state, so the detail panel shows a day progress bar (`130 / 240 pts`, `13 of
  24 solved`) and the sidebar shows `7/10 pts` per challenge. The server's
  `/api/user/solved` endpoint reports no scores, so these points come from
  submits made on this machine.
- **Progress at a glance.** Every challenge and day group in the sidebar wears a
  ring icon, and the normal Explorer gets badges on the files, day folders and
  the `grader` root. Both read the same four states: green for a full score,
  yellow for partial, red for zero, grey for not started.
- **Session expiry is handled.** Any `401` raises a prompt to sign in again; a
  fresh token then retries the request that failed, so a long session does not
  end in a stream of error messages.
- **Challenge details in a split panel.** Clicking a challenge in the sidebar
  opens the problem statement beside the editor: title, topic, day, difficulty,
  the description with its tables rendered, a sample input/output table, and the
  input/output format. A sticky footer drives the work without leaving the panel.

### The detail panel footer

| Button | What it does |
| --- | --- |
| `Open File` | Opens the file for the selected language and focuses the editor |
| `Run` | Runs the file against the **first sample input** |
| `Submit` | Confirms, submits, polls, then updates the panel's solved badge |
| `Copy Input` | Copies every sample input, one per testcase |
| `Pull` | Re-fetches the server's saved code for that file |

The `python` / `cpp` toggles switch which file the footer acts on. The panel
also follows your active editor: switching from `B01.py` to `B01.cpp` re-renders
it for C++. It reuses a single panel, so opening a new challenge reveals the
same tab instead of stacking tabs.

`Run` from the footer deliberately uses the first sample input rather than
prompting for stdin; a modal input box on top of a webview is jarring. Use
`Grader: Run Active File` when you want to type your own stdin.

## Commands

| Command | What it does |
| --- | --- |
| `Grader: Login` | Prompt for credentials and store the token |
| `Grader: Logout` | Clear the stored token |
| `Grader: Reload Challenges` | Fetch challenges and sync files |
| `Grader: Show Challenge Details` | Open a challenge in the split panel |
| `Grader: Open Challenge File` | Open a challenge, or pick from a picker |
| `Grader: Run Active File` | Run with custom stdin |
| `Grader: Submit Active File` | Submit and show results |
| `Grader: Show Results Panel` | Reveal the results webview |
| `Grader: Pull Latest Saved Code for Active File` | Force-fetch server code |
| `Grader: Copy First Testcase Input` | Copy the sample inputs |
| `Grader: Set API URL` | Point at a different server |

Right-clicking a challenge gives Open File / Run / Submit / Copy Input for that
challenge. The inline icon on each row, and a single click on the row itself,
open the detail panel.
## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `grader.apiUrl` | `https://grader.krusomchai.online` | API base URL |
| `grader.workspaceFolder` | `grader` | Sync target inside the workspace |
| `grader.languages` | `["python", "cpp"]` | The API only supports these two |
| `grader.syncOnReload` | `true` | Sync automatically on activation |
| `grader.lazyLanguageFetch` | `true` | Fetch a language's code when its file opens, not on every reload |
| `grader.pushOnSave` | `true` | Push edits to the server on save |
| `grader.syncConcurrency` | `4` | Keep low; the API returns 502 under load |
| `grader.maxRetries` | `3` | Retries for 5xx and network errors |

### Why `lazyLanguageFetch` defaults to on

Fetching both languages for all 47 challenges is ~94 requests per reload. The
server returns `502 Bad Gateway` from openresty under that load, and the
capture shows real 502s on `/api/user/code`. With lazy fetch on, a reload only
creates files from templates and pulls the real code for a file when you open
it, so each reload makes two requests instead of ninety-four.

## Saving code back to the server

The server exposes no code-save endpoint. The web UI keeps edits in
`localStorage`, so `GET /api/user/code` only ever returns your last *submitted*
code. This extension probes `POST /api/user/code` on save; if the server replies
`404`/`405`/`501` it stops probing, warns once, and falls back to submitting as
the only way to push code upstream.

Because that push is unconfirmed in that case, saving a file does **not** move
the recorded sync hash. The edit stays visibly "local" and reload will not
overwrite it. The hash only advances on a confirmed push or a successful submit,
both of which mean the server really holds the code on disk.

## Scores

The server's `GET /api/user/solved` answers with which codes are solved and
attempted, but never with points, and there is no scores endpoint in the API. The
best score per challenge is therefore recorded from submit results in workspace
state (`grader.scores`). Two consequences worth knowing:

- Points show for challenges submitted on this machine, not for work done on
  another device or another VS Code profile.
- A resubmission that scores lower does not lower the number shown; the best
  result wins.

`Grader: Login` clears the re-login budget described below.

## Progress colours

The sidebar rings and the Explorer badges answer the same question with the same
four states, judged from the score recorded on this machine and, when there is
no score, from the server's solved list:

| State | Meaning | Sidebar ring (light / dark) | Explorer badge |
| --- | --- | --- | --- |
| Green | full score, or solved with no score recorded here | filled tick | `✓` |
| Yellow | scored, but not full marks | arc for the earned share | `70` (percent) |
| Red | submitted and scored zero | empty ring | `0` |
| Grey | not started, or only marked attempted | empty ring | `–` |

| Colour | Light | Dark |
| --- | --- | --- |
| Green | `#1a7f37` | `#3fb950` |
| Yellow | `#bf8700` | `#d29922` |
| Red | `#cf222e` | `#f85149` |
| Grey | `#8c959f` | `#6e7681` |

- A day group totals its own challenges, so its ring and badge show the day's
  progress; the `grader` folder totals every day. Day groups start collapsed and
  remember whether you opened them.
- The same decoration covers a file in the Explorer and its row in the sidebar,
  so both the file name and the sidebar label carry the colour plus the badge
  (`✓`, percent, `0` or `–`), and both repaint as soon as a submit lands. VS Code
  checks its own `explorer.decorations.colors` / `explorer.decorations.badges`
  switches before drawing these, which is why the label text may stay plain when
  those are switched off.
- Explorer badges are limited to two characters by VS Code, which is why a
  partial score appears as a percent rather than a ring.
- The four colours are contributed as the `krusomchai.grader.score.*` theme
  colours, so they can be overridden through `workbench.colorCustomizations`.
- Points come only from submits made on this machine; a challenge the server
  marks solved but that has no score here still counts as full.

## Expired sessions

A `401` from any call raises a `Your Grader session expired. Sign in again to
continue.` prompt. Choosing `Sign In` replaces the token and retries the request
that failed, so an expired session costs one interruption instead of a run of
errors. Choosing `Later` leaves the failure in place and changes nothing on disk.

Because a misconfigured server could reject every token it issues, automatic
re-login is capped at three attempts; after that the extension asks you to run
`Grader: Login` by hand rather than looping through prompts.

## Development

```bash
npm install
npm run check-types   # tsc --noEmit
npm test              # both suites plus the layout check
npm run compile       # bundle to dist/extension.js
npm run vsix          # package an installable .vsix
```

`npm test` runs the two TypeScript suites, then renders the detail panel for
three real challenges from the API capture and measures the result in headless
Chrome at four pane widths, checking that the footer stays pinned, never covers
the end of the problem statement, and that nothing overflows horizontally. It
skips the layout check when Chrome or the capture is unavailable. To inspect the
panel by hand:

```bash
npm run preview -- /path/to/challenges.json B01   # writes out/panel-preview.html
npm run check-layout                              # measure what preview wrote
```

`src/test/unit.test.ts` stubs `fetch` and covers the retry policy (5xx retried,
4xx not), the 401 handler, the HTML-error-page-behind-a-200 case, submit queue
polling, the sync rule that keeps locally edited files, the day-folder migration,
the score store, the four-state score colours and ring geometry, their agreement
with the colours contributed in `package.json`, and the Markdown renderer against
the real `B01` description
shape. `src/test/extension.test.ts` drives the real `activate`
against a stubbed `vscode` module and asserts every contributed command is
registered, that a signed-out session makes no API calls, that reload/run/submit
produce the expected request payloads and files on disk, that the sidebar groups by
day and a legacy folder is migrated by the sync, that scores reach the panel,
that day groups start collapsed and keep their expansion across a refresh, that
the ring icons follow a submit, that Explorer badges report file, day and
workspace progress, and
that an expired session prompts once, retries the failed call, and stops after the
attempt limit. The detail panel is checked to open beside the editor with its
footer buttons working.

## Security notes

Challenge text is server-supplied, so the panel escapes everything before
rendering and declares a `default-src 'none'` CSP with a per-render nonce on its
script. Your login token lives in VS Code's `SecretStorage` and is only ever sent
as a query parameter or JSON body, never logged. The panel receives no token.

To try it without publishing: `code --extensionDevelopmentPath=<repo>`.