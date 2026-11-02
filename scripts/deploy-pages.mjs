/**
 * Build and publish the app to GitHub Pages.
 *
 *   npm run deploy
 *
 * Why this exists rather than a CI workflow: publishing from Actions needs the
 * repository's workflow token to have write permission, which is off by
 * default on new repositories. Pushing the built site to the `gh-pages` branch
 * from a machine that can already push to the repo needs no extra setup at
 * all, and Pages serves that branch automatically.
 *
 * The workflow in .github/workflows/deploy-pages.yml does the same thing and
 * is the nicer long-term option - enable it by setting
 * Settings -> Actions -> General -> Workflow permissions to "Read and write".
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REMOTE = 'https://github.com/Thanujan01/PickMe-Duplication.git';
const BRANCH = 'gh-pages';
const SITE = 'https://thanujan01.github.io/PickMe-Duplication/';

/**
 * `shell: true` is needed on Windows to launch npm.cmd, but it also re-parses
 * every argument - which splits a commit message on its spaces. So git runs
 * without a shell and npm runs with one.
 */
const git = (args, opts = {}) =>
  execFileSync('git', args, { stdio: 'inherit', shell: false, ...opts });

const runNpm = (args) =>
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

console.log('\n[1/4] Building with base=/PickMe-Duplication/ …');
runNpm(['run', 'build:pages']);

if (!existsSync('dist/index.html')) {
  console.error('Build produced no dist/index.html. Aborting.');
  process.exit(1);
}

console.log('[2/4] Adding SPA fallback and .nojekyll …');
// Pages serves 404.html for unknown paths; making it the app shell is what
// lets /rider and /admin survive a hard refresh or a shared link.
copyFileSync('dist/index.html', 'dist/404.html');
// Without this, Pages runs the content through Jekyll and drops _-prefixed files.
writeFileSync('dist/.nojekyll', '');

console.log('[3/4] Staging a throwaway repo …');
const work = mkdtempSync(join(tmpdir(), 'ghp-'));
try {
  cpSync('dist', work, { recursive: true });

  const g = (...args) => git(args, { cwd: work });
  g('init', '-q');
  g('checkout', '-q', '-b', BRANCH);
  g('add', '-A');
  g(
    '-c',
    'user.name=Thanujan01',
    '-c',
    'user.email=aralychurch001@gmail.com',
    'commit',
    '-q',
    '-m',
    `Deploy ${new Date().toISOString()}`,
  );

  console.log(`[4/4] Force-pushing to ${BRANCH} …`);
  // Force is correct here: the branch holds build output only, never history
  // worth keeping. Nothing on `main` is touched.
  g('push', '--force', '--quiet', REMOTE, `${BRANCH}:${BRANCH}`);

  console.log(`\nDone. Live in about a minute at:\n  ${SITE}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
