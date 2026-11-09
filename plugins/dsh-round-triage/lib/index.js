/**
 * dsh-round-triage
 *
 * At the end of each agent turn, collect files created during the turn, classify
 * them with configurable rules, and move only safe, untracked, newly-created files
 * into their target directories. Everything else is reported for review.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_CONFIG,
  applyPlan,
  buildPlan,
  compactReport,
  gitStatus,
  normalizeConfig,
  readProjectConfig,
  scanProject,
} from './core.js';

export const name = 'round-triage';
export const inject = ['workingDirectory'];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function storageRoot() {
  return join(dshHome(), 'round-triage');
}

function projectKey(root) {
  return createHash('sha1').update(String(root).toLowerCase()).digest('hex').slice(0, 16);
}

function statePath(root) {
  return join(storageRoot(), 'state', `${projectKey(root)}.json`);
}

function reportsDir(root) {
  return join(storageRoot(), 'reports', projectKey(root));
}

function latestPath(root) {
  return join(reportsDir(root), 'latest.json');
}

function log(line) {
  const file = join(storageRoot(), 'round-triage.log');
  mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, 'utf8'))
    .catch(() => {
      // Logging must never affect the turn.
    });
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function serializeSnapshot(root, snapshot) {
  return {
    project: root,
    at: new Date().toISOString(),
    truncated: Boolean(snapshot.truncated),
    files: Object.fromEntries(snapshot.files),
  };
}

function deserializeSnapshot(data) {
  const files = new Map();
  const raw = data && data.files && typeof data.files === 'object' ? data.files : {};
  for (const [path, info] of Object.entries(raw)) {
    if (info && typeof info === 'object') {
      files.set(path, { size: Number(info.size) || 0, mtimeMs: Number(info.mtimeMs) || 0 });
    }
  }
  return { at: data?.at || null, truncated: Boolean(data?.truncated), files };
}

async function saveState(root, snapshot) {
  await writeJson(statePath(root), serializeSnapshot(root, snapshot));
}

async function loadState(root) {
  const data = await readJson(statePath(root));
  if (!data) return null;
  return { ...deserializeSnapshot(data), project: data.project || root };
}

async function saveReport(root, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(reportsDir(root), `${stamp}.json`);
  await writeJson(file, report);
  await writeJson(latestPath(root), { ...report, reportPath: file });
  return file;
}

async function loadLatest(root) {
  return readJson(latestPath(root));
}

async function effectiveConfig(root, baseConfig) {
  const project = await readProjectConfig(root);
  const merged = project.raw && typeof project.raw === 'object'
    ? { ...baseConfig, ...project.raw }
    : { ...baseConfig };
  if (project.raw && Array.isArray(project.raw.rules)) merged.rules = project.raw.rules;
  return {
    config: normalizeConfig(merged, baseConfig),
    projectConfigFile: project.file,
    projectConfigError: project.error,
  };
}

function sessionKey(agent) {
  return String(agent?.session?.id || agent?.session?.header?.id || 'unknown');
}

function agentRoot(ctx, agent, signal) {
  return ctx.workingDirectory.ensure(agent, signal);
}

function withProjectQueue(queues, root, task) {
  const key = String(root).toLowerCase();
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  queues.set(key, run);
  return run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  });
}

function expandProject(value) {
  let project = String(value || '').trim();
  if (project === '') project = process.cwd();
  if (project === '~') project = homedir();
  else if (project.startsWith('~/') || project.startsWith('~\\')) project = join(homedir(), project.slice(2));
  return resolve(project);
}

function resolveProject(value) {
  const project = expandProject(value);
  if (!existsSync(project)) throw new Error(`project does not exist: ${project}`);
  return project;
}

export function apply(ctx, configInput) {
  const baseConfig = normalizeConfig(configInput || DEFAULT_CONFIG);
  const baselines = new Map();
  const busy = new Set();
  const queues = new Map();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (!baseConfig.enabled || payload.step !== 1 || !payload.agent) return decision;
      const key = sessionKey(payload.agent);
      if (baselines.has(key)) return decision;
      const root = await agentRoot(ctx, payload.agent, payload.signal);
      const { config } = await effectiveConfig(root, baseConfig);
      if (!config.enabled) return decision;
      const snapshot = await scanProject(root, config);
      baselines.set(key, {
        root,
        at: new Date().toISOString(),
        files: snapshot.files,
        truncated: snapshot.truncated,
      });
      await saveState(root, snapshot);
      log({ event: 'baseline', project: root, files: snapshot.files.size, truncated: snapshot.truncated });
    } catch (error) {
      log({ event: 'baseline-error', error: String(error?.message || error) });
    }
    return decision;
  });

  ctx.on('agent/turn-stopping', async (event) => {
    try {
      if (!baseConfig.enabled || !event?.agent) return;
      const key = sessionKey(event.agent);
      const baseline = baselines.get(key);
      if (!baseline) return;
      if (busy.has(key)) return;
      busy.add(key);
      try {
        await withProjectQueue(queues, baseline.root, async () => {
          const { config, projectConfigError } = await effectiveConfig(baseline.root, baseConfig);
          if (!config.enabled) return;
          const after = await scanProject(baseline.root, config);
          const git = await gitStatus(baseline.root);
          let report = buildPlan({
            root: baseline.root,
            before: baseline.files,
            after: after.files,
            git,
            config,
            mode: config.autoApply ? 'auto' : 'plan',
          });
          if (projectConfigError) {
            report.errors.push({ path: '.dsh-round-triage.json', error: projectConfigError });
            report.ok = false;
          }
          if (config.autoApply) report = await applyPlan(report, { root: baseline.root, config });
          const post = config.autoApply ? await scanProject(baseline.root, config) : after;
          await saveState(baseline.root, post);
          report.state = {
            at: post.at,
            files: post.files.size,
            truncated: post.truncated,
          };
          report.reportPath = await saveReport(baseline.root, report);
          log({
            event: 'turn',
            project: baseline.root,
            new: report.summary?.new,
            planned: report.summary?.planned,
            moved: report.summary?.moved,
            errors: report.summary?.errors,
            reportPath: report.reportPath,
          });
        });
      } finally {
        baselines.delete(key);
        busy.delete(key);
      }
    } catch (error) {
      log({ event: 'turn-error', error: String(error?.message || error) });
    }
  });

  ctx.inject(['tools'], (scope) => scope.effect(() => {
    const output = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    };

    const dispose = scope.tools.register({
      name: 'round_triage',
      description: '按规则归类本回合或上次基线以来新产生的文件；默认只给出计划，action=apply 才移动。只自动移动安全的、未跟踪的新文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['plan', 'apply', 'status', 'reset'],
            description: 'plan=查看分类计划；apply=执行安全移动；status=查看最近一次报告；reset=清除基线。',
          },
          project: {
            type: 'string',
            description: '项目根目录；省略时使用当前进程工作目录。',
          },
        },
        required: ['action'],
      },
      output,
      async execute(args) {
        const action = String(args?.action || 'status');
        const project = resolveProject(args?.project);
        const { config, projectConfigError } = await effectiveConfig(project, baseConfig);

        if (action === 'status') {
          const latest = await loadLatest(project);
          const state = await loadState(project);
          const body = latest
            ? compactReport({ ...latest, ok: latest.ok !== false, action: 'status', baseline: state ? { at: state.at, files: state.files.size } : null })
            : {
                ok: true,
                action: 'status',
                project,
                configured: config,
                projectConfigError,
                baseline: state ? { at: state.at, files: state.files.size, truncated: state.truncated } : null,
                latest: null,
              };
          return JSON.stringify(body, null, 2);
        }

        if (action === 'reset') {
          try {
            await unlink(statePath(project));
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          return JSON.stringify({ ok: true, action: 'reset', project }, null, 2);
        }

        if (action !== 'plan' && action !== 'apply') throw new Error(`unsupported action: ${action}`);

        const state = await loadState(project);
        if (!state) {
          const snapshot = await scanProject(project, config);
          await saveState(project, snapshot);
          return JSON.stringify({
            ok: true,
            action,
            project,
            baselineCreated: true,
            files: snapshot.files.size,
            truncated: snapshot.truncated,
            note: '已记录基线；本回合产生的文件会在下一次 plan/apply 中显示。',
          }, null, 2);
        }

        const after = await scanProject(project, config);
        const git = await gitStatus(project);
        let report = buildPlan({
          root: project,
          before: state.files,
          after: after.files,
          git,
          config,
          mode: action,
        });
        if (projectConfigError) {
          report.errors.push({ path: '.dsh-round-triage.json', error: projectConfigError });
          report.ok = false;
        }
        if (action === 'apply') {
          report = await applyPlan(report, { root: project, config });
          const post = await scanProject(project, config);
          await saveState(project, post);
          report.state = { at: post.at, files: post.files.size, truncated: post.truncated };
        }
        report.reportPath = await saveReport(project, report);
        log({ event: 'tool', action, project, moved: report.summary?.moved, errors: report.summary?.errors });
        return JSON.stringify(compactReport({ ...report, action }), null, 2);
      },
    });

    return () => {
      try {
        if (typeof dispose === 'function') dispose();
        else if (dispose && typeof dispose.dispose === 'function') dispose.dispose();
      } catch {
        // Disposal must not affect other plugins.
      }
    };
  }, 'round-triage: tools'));

  log({ event: 'apply', enabled: baseConfig.enabled, autoApply: baseConfig.autoApply, rules: baseConfig.rules.length });
}

/** Test-only surface. */
export const __internals = {
  DEFAULT_CONFIG,
  normalizeConfig,
  applyPlan,
  buildPlan,
  compactReport,
  gitStatus,
  scanProject,
  statePath,
  reportsDir,
  latestPath,
  effectiveConfig,
};
