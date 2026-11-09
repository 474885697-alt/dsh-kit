/**
 * round-triage core: scan, classify and safely move files produced in one turn.
 * This module deliberately has no dependency on the DSH host so it can be tested
 * with plain Node.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

export const DEFAULT_RULES = [
  {
    id: 'images',
    label: '图片',
    match: '**/*.{png,jpg,jpeg,webp,gif,svg,avif}',
    to: 'assets/art/generated',
    auto: true,
  },
  {
    id: 'audio',
    label: '音频',
    match: '**/*.{mp3,wav,ogg,m4a,flac,aac}',
    to: 'assets/audio',
    auto: true,
  },
  {
    id: 'video',
    label: '视频',
    match: '**/*.{mp4,webm,mov,mkv}',
    to: 'assets/video',
    auto: false,
  },
  {
    id: 'docs',
    label: '文档',
    match: '**/*.{md,mdx,txt,rst}',
    to: 'docs/notes',
    auto: false,
  },
  {
    id: 'scripts',
    label: '脚本',
    match: '**/*.{cjs,mjs,js,ts,tsx,jsx,py,ps1,sh}',
    to: 'tools',
    auto: false,
  },
  {
    id: 'data',
    label: '数据',
    match: '**/*.{json,jsonl,csv,tsv,yml,yaml,xml}',
    to: 'data',
    auto: false,
  },
  {
    id: 'archives',
    label: '归档',
    match: '**/*.{zip,7z,tar,gz,tgz,bz2,xz}',
    to: 'dist',
    auto: false,
  },
];

export const DEFAULT_CONFIG = {
  enabled: true,
  autoApply: true,
  maxFiles: 20000,
  maxDepth: 8,
  maxFileBytes: 200 * 1024 * 1024,
  maxChanges: 600,
  inboxDirs: ['', 'tmp', 'output', 'outputs', 'generated', 'generated-assets'],
  skipDirs: [
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.cache',
    '.dsh',
    '.idea',
    '.vscode',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
  ],
  rules: DEFAULT_RULES,
};

const GLOB_CACHE = new Map();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeRel(value) {
  let p = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  while (p.startsWith('/')) p = p.slice(1);
  return p;
}

function normalizeDir(value) {
  const p = normalizeRel(value).replace(/\/+$/, '');
  if (p === '' || p === '.') return '';
  if (p.split('/').some((part) => part === '..')) return null;
  return p;
}

function normalizeRule(rule, index) {
  if (!rule || typeof rule !== 'object') return null;
  const match = String(rule.match || rule.glob || '').trim();
  const to = normalizeDir(rule.to || rule.target || '');
  if (!match || to === null || to === '') return null;
  const rawId = String(rule.id || rule.category || rule.name || `rule-${index + 1}`).trim();
  const id = rawId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `rule-${index + 1}`;
  return {
    id,
    label: String(rule.label || rule.description || id),
    match,
    to,
    auto: rule.auto === true,
  };
}

export function normalizeConfig(input, base = DEFAULT_CONFIG) {
  const raw = input && typeof input === 'object' ? input : {};
  const ruleSource = Array.isArray(raw.rules)
    ? raw.rules
    : Array.isArray(raw.routes)
      ? raw.routes
      : base.rules;
  const rules = ruleSource.map(normalizeRule).filter(Boolean);
  const inbox = Array.isArray(raw.inboxDirs) ? raw.inboxDirs : base.inboxDirs;
  const skip = Array.isArray(raw.skipDirs) ? raw.skipDirs : base.skipDirs;
  return {
    enabled: raw.enabled !== false,
    autoApply: raw.autoApply !== false,
    maxFiles: clampInt(raw.maxFiles, 100, 100000, base.maxFiles),
    maxDepth: clampInt(raw.maxDepth, 1, 20, base.maxDepth),
    maxFileBytes: clampInt(raw.maxFileBytes, 1024, 2 * 1024 * 1024 * 1024, base.maxFileBytes),
    maxChanges: clampInt(raw.maxChanges, 20, 5000, base.maxChanges),
    inboxDirs: inbox.map(normalizeDir).filter((value) => value !== null),
    skipDirs: skip.map((value) => String(value || '').trim()).filter(Boolean),
    rules,
  };
}

function escapeRegExpChar(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(pattern) {
  const p = normalizeRel(pattern);
  const cached = GLOB_CACHE.get(p);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const char = p[i];
    if (char === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (char === '?') {
      re += '[^/]';
    } else if (char === '{') {
      const end = p.indexOf('}', i);
      if (end > i) {
        const parts = p.slice(i + 1, end).split(',');
        re += `(?:${parts.map((part) => part.split('').map(escapeRegExpChar).join('')).join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else if (char === '[') {
      const end = p.indexOf(']', i);
      if (end > i) {
        re += p.slice(i, end + 1);
        i = end;
      } else {
        re += '\\[';
      }
    } else {
      re += escapeRegExpChar(char);
    }
  }
  const result = new RegExp(`^${re}$`, 'i');
  GLOB_CACHE.set(p, result);
  return result;
}

export function matchGlob(pattern, relPath) {
  return globToRegExp(pattern).test(normalizeRel(relPath));
}

export function ruleFor(relPath, rules) {
  const rel = normalizeRel(relPath);
  for (const rule of rules || []) {
    if (matchGlob(rule.match, rel)) return rule;
  }
  return null;
}

export function isInside(root, absPath) {
  const rel = relative(root, absPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isInbox(relPath, inboxDirs) {
  const dir = dirname(normalizeRel(relPath));
  const sourceDir = dir === '.' ? '' : dir;
  for (const entry of inboxDirs || []) {
    if (entry === '') {
      if (sourceDir === '') return true;
    } else if (sourceDir === entry || sourceDir.startsWith(`${entry}/`)) {
      return true;
    }
  }
  return false;
}

const RESERVED = new Set([
  'readme.md',
  'readme',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'index.html',
  'server.js',
  '.gitignore',
  '.gitattributes',
  '.dsh-round-triage.json',
]);

const SENSITIVE_RE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(id_rsa|id_ed25519|credentials|secrets?|passwd|shadow)(\.|$)/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.git-credentials$/i,
];

export function isReservedName(relPath) {
  const name = basename(normalizeRel(relPath)).toLowerCase();
  return RESERVED.has(name);
}

export function isSensitiveName(relPath) {
  const rel = normalizeRel(relPath);
  return SENSITIVE_RE.some((re) => re.test(rel));
}

export function isProtectedSource(relPath) {
  const rel = normalizeRel(relPath);
  const first = rel.split('/')[0];
  if (first === '.git' || first === 'node_modules') return true;
  const name = basename(rel);
  return name.startsWith('.');
}

export async function scanProject(root, configInput = {}) {
  const config = normalizeConfig(configInput);
  const files = new Map();
  const errors = [];
  let truncated = false;
  let count = 0;

  async function walk(absDir, relDir, depth) {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (errors.length < 30) errors.push({ path: relDir || '.', error: String(error?.message || error) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (count >= config.maxFiles) {
        truncated = true;
        return;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (config.skipDirs.includes(entry.name)) continue;
        if (depth >= config.maxDepth) continue;
        await walk(join(absDir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        let info;
        try {
          info = await stat(join(absDir, entry.name));
        } catch (error) {
          if (errors.length < 30) errors.push({ path: rel, error: String(error?.message || error) });
          continue;
        }
        files.set(rel, { size: info.size, mtimeMs: info.mtimeMs });
        count += 1;
      }
    }
  }

  await walk(resolve(root), '', 0);
  return { files, truncated, errors };
}

export function diffSnapshots(before, after) {
  const oldFiles = before instanceof Map ? before : new Map(Object.entries(before || {}));
  const newFiles = after instanceof Map ? after : new Map(Object.entries(after || {}));
  const changes = [];
  for (const [path, info] of newFiles) {
    const old = oldFiles.get(path);
    if (!old) {
      changes.push({ path, status: 'new', size: info?.size ?? null });
    } else if (old.size !== info?.size || old.mtimeMs !== info?.mtimeMs) {
      changes.push({ path, status: 'modified', size: info?.size ?? null });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

export async function gitStatus(root) {
  try {
    const [{ stdout }, { stdout: prefixOut }] = await Promise.all([
      execFileAsync(
        'git',
        ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        { cwd: root, maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      ),
      execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd: root, windowsHide: true }),
    ]);
    const prefix = normalizeRel(String(prefixOut || '').trim());
    const map = new Map();
    const entries = String(stdout || '').split('\0');
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      let path = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') {
        i += 1;
        if (path.includes(' -> ')) path = path.split(' -> ').pop();
      }
      path = normalizeRel(path);
      if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
      if (path) map.set(path, code);
    }
    return { available: true, map };
  } catch (error) {
    return { available: false, map: new Map(), reason: String(error?.message || error) };
  }
}

function targetFor(root, rule, relPath) {
  if (!rule) return { targetRel: '', targetAbs: '', inside: false };
  const targetRel = normalizeRel(join(rule.to, basename(relPath)));
  const targetAbs = resolve(root, targetRel);
  return { targetRel, targetAbs, inside: isInside(root, targetAbs) };
}

export function buildPlan({ root, before, after, git, config: configInput, mode = 'plan' }) {
  const config = normalizeConfig(configInput);
  const changes = diffSnapshots(before, after);
  const gitAvailable = Boolean(git?.available);
  const gitMap = git?.map instanceof Map ? git.map : new Map();
  const rows = [];
  let newCount = 0;
  let modifiedCount = 0;
  let planned = 0;
  let moved = 0;
  let hidden = 0;

  for (const change of changes) {
    if (change.status === 'new') newCount += 1;
    else modifiedCount += 1;

    const rule = ruleFor(change.path, config.rules);
    const { targetRel, targetAbs, inside } = targetFor(root, rule, change.path);
    const inbox = isInbox(change.path, config.inboxDirs);
    const sensitive = isSensitiveName(change.path);
    const reserved = isReservedName(change.path);
    const protectedSource = isProtectedSource(change.path);
    const tooLarge = Number(change.size || 0) > config.maxFileBytes;
    const auto = rule?.auto === true;
    const collision = targetAbs ? existsSync(targetAbs) : false;

    let eligible = change.status === 'new' && Boolean(rule) && auto && inbox && inside
      && !sensitive && !reserved && !protectedSource && !tooLarge;
    let reason = 'eligible';

    if (change.status !== 'new') {
      eligible = false;
      reason = 'modified-not-moved';
    } else if (!rule) {
      reason = 'no-rule';
    } else if (!auto) {
      reason = 'rule-manual';
    } else if (!inbox) {
      reason = 'outside-inbox';
    } else if (sensitive) {
      reason = 'sensitive';
    } else if (reserved) {
      reason = 'reserved';
    } else if (protectedSource) {
      reason = 'protected';
    } else if (tooLarge) {
      reason = 'too-large';
    } else if (!inside) {
      reason = 'unsafe-target';
    } else if (gitAvailable) {
      const code = gitMap.get(change.path);
      if (code !== '??') {
        eligible = false;
        reason = code ? 'tracked-or-ignored' : 'not-untracked';
      }
    }

    if (eligible) planned += 1;
    if (rows.length < config.maxChanges) {
      rows.push({
        path: change.path,
        status: change.status,
        size: change.size,
        category: rule?.id || 'unknown',
        label: rule?.label || '未分类',
        rule: rule?.id || null,
        target: targetRel || null,
        targetAbs: targetAbs || null,
        auto,
        eligible,
        collision,
        reason,
      });
    } else {
      hidden += 1;
    }
  }

  return {
    ok: true,
    project: root,
    at: new Date().toISOString(),
    mode,
    summary: {
      scanned: after instanceof Map ? after.size : Object.keys(after || {}).length,
      new: newCount,
      modified: modifiedCount,
      planned,
      moved,
      skipped: newCount - planned,
      errors: 0,
    },
    changes: rows,
    hidden,
    moved: [],
    skipped: rows.filter((row) => !row.eligible).map((row) => ({ path: row.path, reason: row.reason })),
    errors: [],
    git: { available: gitAvailable },
  };
}

function uniqueDestination(targetAbs) {
  if (!existsSync(targetAbs)) return targetAbs;
  const ext = extname(targetAbs);
  const stem = ext ? targetAbs.slice(0, -ext.length) : targetAbs;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find a free name for ${targetAbs}`);
}

async function moveFile(sourceAbs, targetAbs) {
  await mkdir(dirname(targetAbs), { recursive: true });
  try {
    await rename(sourceAbs, targetAbs);
  } catch (error) {
    if (error?.code === 'EXDEV' || error?.code === 'EPERM') {
      await copyFile(sourceAbs, targetAbs);
      await unlink(sourceAbs);
      return;
    }
    throw error;
  }
}

export async function applyPlan(report, { root, config: configInput } = {}) {
  const config = normalizeConfig(configInput);
  const project = root || report.project;
  const result = { ...report, changes: report.changes.map((row) => ({ ...row })), moved: [], errors: [] };
  for (const change of result.changes) {
    if (!change.eligible || change.status !== 'new') continue;
    const sourceAbs = resolve(project, change.path);
    if (!isInside(project, sourceAbs)) {
      result.errors.push({ path: change.path, error: 'source-outside-project' });
      continue;
    }
    if (!change.targetAbs) {
      result.errors.push({ path: change.path, error: 'missing-target' });
      continue;
    }
    try {
      const targetAbs = uniqueDestination(resolve(change.targetAbs));
      await moveFile(sourceAbs, targetAbs);
      const targetRel = normalizeRel(relative(project, targetAbs));
      change.movedTo = targetRel;
      change.reason = 'moved';
      result.moved.push({ from: change.path, to: targetRel });
    } catch (error) {
      result.errors.push({ path: change.path, error: String(error?.message || error) });
    }
  }
  result.at = new Date().toISOString();
  result.mode = 'apply';
  result.summary = {
    ...result.summary,
    moved: result.moved.length,
    errors: result.errors.length,
  };
  result.ok = result.errors.length === 0;
  return result;
}

export async function readProjectConfig(root) {
  const file = join(root, '.dsh-round-triage.json');
  try {
    const text = await readFile(file, 'utf8');
    return { file, raw: JSON.parse(text), error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, raw: null, error: null };
    return { file, raw: null, error: String(error?.message || error) };
  }
}

export function compactReport(report, limit = 20) {
  const rows = Array.isArray(report?.changes) ? report.changes : [];
  const reasons = {};
  for (const row of rows) {
    const key = row && row.reason ? row.reason : 'unknown';
    reasons[key] = (reasons[key] || 0) + 1;
  }
  return {
    ...report,
    changes: rows.slice(0, limit),
    skipped: (report?.skipped || []).slice(0, limit),
    moved: (report?.moved || []).slice(0, limit),
    reasons,
    returned: Math.min(rows.length, limit),
    totalChanges: rows.length,
  };
}

export { moveFile, uniqueDestination };
