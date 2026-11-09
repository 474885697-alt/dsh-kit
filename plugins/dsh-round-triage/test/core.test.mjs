import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyPlan,
  buildPlan,
  gitStatus,
  globToRegExp,
  isInbox,
  matchGlob,
  normalizeConfig,
  scanProject,
} from '../lib/core.js';
import { apply as applyPlugin, __internals } from '../lib/index.js';

async function setupProject() {
  const root = await mkdtemp(join(tmpdir(), 'round-triage-test-'));
  await writeFile(join(root, 'tracked.txt'), 'tracked\n', 'utf8');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root, stdio: 'ignore' });
  return root;
}

test('glob semantics: root and nested files', () => {
  assert.equal(matchGlob('**/*.{png,jpg}', 'shot.png'), true);
  assert.equal(matchGlob('**/*.{png,jpg}', 'output/shot.png'), true);
  assert.equal(matchGlob('*.png', 'shot.png'), true);
  assert.equal(matchGlob('*.png', 'output/shot.png'), false);
  assert.equal(globToRegExp('**/*.md').test('docs/a/b.md'), true);
});

test('inbox only covers configured source directories', () => {
  const inbox = ['', 'tmp', 'output', 'outputs', 'generated'];
  assert.equal(isInbox('shot.png', inbox), true);
  assert.equal(isInbox('output/shot.png', inbox), true);
  assert.equal(isInbox('output/deep/shot.png', inbox), true);
  assert.equal(isInbox('docs/tmp/shot.png', inbox), false);
  assert.equal(isInbox('src/shot.png', inbox), false);
});

test('normalizeConfig keeps rules and clamps limits', () => {
  const config = normalizeConfig({
    maxFiles: 2,
    maxDepth: 99,
    rules: [{ id: 'x', match: '**/*.bin', to: 'out', auto: true }],
  });
  assert.equal(config.maxFiles, 100);
  assert.equal(config.maxDepth, 20);
  assert.equal(config.rules.length, 1);
  assert.equal(config.rules[0].auto, true);
});

test('plans only safe new untracked files and applies without overwrite', async () => {
  const root = await setupProject();
  try {
    const before = await scanProject(root);
    await mkdir(join(root, 'output'), { recursive: true });
    await mkdir(join(root, 'docs', 'tmp'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'assets', 'art', 'generated'), { recursive: true });
    await writeFile(join(root, 'shot.png'), 'png', 'utf8');
    await writeFile(join(root, 'output', 'voice.mp3'), 'mp3', 'utf8');
    await writeFile(join(root, 'output', 'collision.png'), 'png', 'utf8');
    await writeFile(join(root, 'assets', 'art', 'generated', 'collision.png'), 'old', 'utf8');
    await writeFile(join(root, 'docs', 'tmp', 'screen.png'), 'png', 'utf8');
    await writeFile(join(root, 'src', 'new.js'), 'js', 'utf8');
    await writeFile(join(root, '.env'), 'SECRET=1', 'utf8');
    await writeFile(join(root, 'notes.md'), 'notes', 'utf8');
    await writeFile(join(root, 'tool.cjs'), 'code', 'utf8');

    const after = await scanProject(root);
    const git = await gitStatus(root);
    const report = buildPlan({ root, before: before.files, after: after.files, git, config: {} });
    const byPath = new Map(report.changes.map((row) => [row.path, row]));

    assert.equal(byPath.get('shot.png').eligible, true);
    assert.equal(byPath.get('output/voice.mp3').eligible, true);
    assert.equal(byPath.get('output/collision.png').eligible, true);
    assert.equal(byPath.get('docs/tmp/screen.png').eligible, false);
    assert.equal(byPath.get('docs/tmp/screen.png').reason, 'outside-inbox');
    assert.equal(byPath.get('src/new.js').eligible, false);
    assert.equal(byPath.get('.env').eligible, false);
    assert.equal(byPath.get('notes.md').eligible, false);
    assert.equal(byPath.get('tool.cjs').eligible, false);
    assert.equal(byPath.get('tracked.txt'), undefined);

    const applied = await applyPlan(report, { root, config: {} });
    assert.equal(applied.ok, true);
    assert.equal(applied.summary.moved, 3);
    assert.equal(existsSync(join(root, 'shot.png')), false);
    assert.equal(existsSync(join(root, 'assets', 'art', 'generated', 'shot.png')), true);
    assert.equal(existsSync(join(root, 'assets', 'audio', 'voice.mp3')), true);
    assert.equal(existsSync(join(root, 'assets', 'art', 'generated', 'collision.png')), true);
    assert.equal(existsSync(join(root, 'assets', 'art', 'generated', 'collision-2.png')), true);
    assert.equal(await readFile(join(root, 'assets', 'art', 'generated', 'collision-2.png'), 'utf8'), 'png');
    assert.equal(existsSync(join(root, 'docs', 'tmp', 'screen.png')), true);
    assert.equal(existsSync(join(root, 'src', 'new.js')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tracked modified files are never auto-moved', async () => {
  const root = await setupProject();
  try {
    await writeFile(join(root, 'tracked.txt'), 'changed\n', 'utf8');
    const before = await scanProject(root);
    await writeFile(join(root, 'tracked.txt'), 'changed again\n', 'utf8');
    const after = await scanProject(root);
    const git = await gitStatus(root);
    const report = buildPlan({ root, before: before.files, after: after.files, git, config: {} });
    const row = report.changes.find((item) => item.path === 'tracked.txt');
    assert.ok(row);
    assert.equal(row.status, 'modified');
    assert.equal(row.eligible, false);
    assert.equal(row.reason, 'modified-not-moved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('turn hooks create a baseline, move safe files and write a report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'round-triage-hook-'));
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, '.dsh-home');
  try {
    const handlers = new Map();
    const ctx = {
      on(name, handler) {
        handlers.set(name, handler);
        return () => {};
      },
      inject() {},
      workingDirectory: { ensure: async () => root },
    };
    applyPlugin(ctx, {
      autoApply: true,
      inboxDirs: [''],
      rules: [{ id: 'images', match: '**/*.png', to: 'assets/art/generated', auto: true }],
    });
    const agent = { session: { id: 'test-session' } };
    await handlers.get('agent/pre-step')({ agent, step: 1 }, async () => ({ kind: 'continue', messages: [] }));
    await writeFile(join(root, 'shot.png'), 'png', 'utf8');
    await handlers.get('agent/turn-stopping')({ agent, turn: 1 });
    assert.equal(existsSync(join(root, 'shot.png')), false);
    assert.equal(existsSync(join(root, 'assets', 'art', 'generated', 'shot.png')), true);
    const latest = JSON.parse(await readFile(__internals.latestPath(root), 'utf8'));
    assert.equal(latest.summary.moved, 1);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});
