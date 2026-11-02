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

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log('\n[1/4] Building with base=/PickMe-Duplication/ …');
run(npm, ['run', 'build:pages']);

if (!existsSync('dist/index.html')) {
  console.error('Build produced no dist/index.html. Aborting.');
  process.exit(1);
}

console.log('\n[2/4] Adding SPA fallback and .nojekyll …');
// Pages serves 404.html for unknown paths; making it the app shell is what
// lets /rider and /admin survive a hard refresh or a shared link.
copyFileSync('dist/index.html', 'dist/404.html');
// Without this, Pages runs the content through Jekyll and drops _-prefixed files.
writeFileSync('dist/.nojekyll', '');

console.log('\n[3/4] Staging a throwaway repo …');
const work = mkdtempSync(join(tmpdir(), 'ghp-'));
try {
  cpSync('dist', work, { recursive: true });

  const git = (...args) => run('git', args, { cwd: work });
  git('init', '-q');
  git('checkout', '-q', '-b', BRANCH);
  git('add', '-A');
  git(
    '-c',
    'user.name=Thanujan01',
    '-c',
    'user.email=aralychurch001@gmail.com',
    'commit',
    '-q',
    '-m',
    `Deploy ${new Date().toISOString()}`,
  );

  console.log(`\n[4/4] Force-pushing to ${BRANCH} …`);
  // Force is correct here: the branch holds build output only, never history
  // worth keeping. Nothing on `main` is touched.
  git('push', '--force', '--quiet', REMOTE, `${BRANCH}:${BRANCH}`);

  console.log(`\nDone. Live in ~1 minute at:\n  ${SITE}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
