const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Pull GET /api/challenges out of the Burp capture so the layout check can use
 * real descriptions. The capture holds base64 response bodies inside <item>
 * elements; there is no XML parser in the dependency tree on purpose.
 */
function extractChallenges(capturePath, outPath) {
  const xml = fs.readFileSync(capturePath, 'utf8');
  const items = xml.split(/<item>/).slice(1);
  // Values in the capture are wrapped in CDATA, so match the tags around it.
  // `<response base64="true">` contains the CDATA payload directly, with no
  // length element to trip the non-greedy match over.
  const field = (tag, item) => {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item);
    if (!match) {
      return '';
    }
    return match[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
  };

  for (const item of items) {
    if (!field('path', item).startsWith('/api/challenges')) {
      continue;
    }
    const body = field('response', item);
    if (!body || !/^[A-Za-z0-9+/=\s]+$/.test(body)) {
      continue;
    }
    const text = Buffer.from(body, 'base64').toString('utf8');
    const start = text.indexOf('{');
    if (start < 0) {
      continue;
    }
    const json = JSON.parse(text.slice(start));
    if (!Array.isArray(json.challenges)) {
      continue;
    }
    fs.writeFileSync(outPath, JSON.stringify(json));
    return json.challenges.length;
  }
  return 0;
}

async function main() {
  const alias = {
    vscode: path.join(__dirname, 'src/test/vscode-stub.ts'),
  };

  const entryPoints = ['src/test/unit.test.ts', 'src/test/extension.test.ts'];

  await esbuild.build({
    entryPoints,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: 'out',
    sourcemap: 'inline',
    external: ['node:*'],
    alias,
    logLevel: 'warning',
  });

  let failed = false;
  for (const file of ['unit.test.js', 'extension.test.js']) {
    // Each suite runs in its own process so a crash or a stray global
    // (fetch, vscode stub state) cannot leak between them.
    const result = spawnSync(process.execPath, [path.join(__dirname, 'out', file)], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      failed = true;
    }
  }

  if (failed) {
    process.exit(1);
  }

  // Layout is checked with real Chrome when it is available, since a webview's
  // appearance is exactly what unit tests cannot see.
  const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((bin) => {
    try {
      spawnSync('which', [bin], { stdio: 'ignore' });
      return spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
    } catch {
      return false;
    }
  });

  if (!chrome) {
    console.log('\nAll test suites passed. (No Chrome found; skipped the layout check.)');
    return;
  }

  await esbuild.build({
    entryPoints: ['src/test/layout.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(__dirname, 'out/layout.js'),
    logLevel: 'warning',
  });

  // The layout probe needs a rendered panel, which comes from the capture.
  const capture = path.join(__dirname, 'grader');
  if (!fs.existsSync(capture)) {
    console.log('\nAll test suites passed. (No API capture; skipped the layout check.)');
    return;
  }

  await esbuild.build({
    entryPoints: ['src/test/preview.ts'],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(__dirname, 'out/preview.js'),
    alias,
    logLevel: 'warning',
  });

  const challengesPath = path.join(__dirname, 'out/challenges.json');
  let available = 0;
  try {
    available = extractChallenges(capture, challengesPath);
  } catch (err) {
    console.log(`\nCould not read the API capture (${err.message}); skipped the layout check.`);
  }
  if (!available) {
    console.log('\nAll test suites passed. (No challenges in the capture; skipped the layout check.)');
    return;
  }

  // One table-heavy description, one short one, and one long one.
  const samples = ['B07', 'B01', 'E11'].filter((code) =>
    JSON.parse(fs.readFileSync(challengesPath, 'utf8')).challenges.some((c) => c.code === code),
  );

  for (const code of samples) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'out/preview.js'), challengesPath, code],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      failed = true;
      continue;
    }
    for (const width of ['320', '500', '900', '1600']) {
      const measured = spawnSync(
        process.execPath,
        [path.join(__dirname, 'out/layout.js')],
        { stdio: 'inherit', env: { ...process.env, PANEL_WIDTH: width, CHROME: chrome } },
      );
      if (measured.status !== 0) {
        failed = true;
      }
    }
  }

  if (failed) {
    process.exit(1);
  }
  console.log('\nAll test suites and layout checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});