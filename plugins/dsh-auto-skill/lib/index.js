/**
 * dsh-auto-skill — 让技能"自动生效"：用户不用点名、不用把技能内容插进对话。
 *
 * 工作方式：
 * 1. 每个用户回合的第一步（agent/pre-step，step === 1），取本轮用户输入；
 * 2. 从技能服务拿当前会话可见的技能清单（name / description / content）；
 * 3. 用确定性的关键词/名称匹配打分（不调用模型，不额外花钱）；
 * 4. 命中足够强的技能时，把它的完整内容包装成 <skill_content> 注入本轮，
 *    模型直接照做，不需要再调用 skill 工具。
 *
 * 设计约束（对应 ~/.dsh/AGENTS.md 的坑 4）：
 * - 所有逻辑包在 try/catch 里，任何异常都原样返回 decision，绝不影响会话启动；
 * - 同一会话里同一个技能只注入一次，避免每轮重复烧上下文；
 * - 只注入 modelInvocable 的技能，内容超过 maxChars 会截断并注明。
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'auto-skill';
export const inject = ['skills', 'workingDirectory'];

/** 对外健康检查用，与 package.json 同步；0.3.x 起 match/health 都带版本。 */
const VERSION = '0.3.1';

const DEFAULTS = {
  enabled: true,
  maxSkills: 1,
  maxChars: 12000,
  minShared: 2,
  minMessageChars: 8,
  minScore: 8,
  debug: false,
  learnEnabled: true,
  autoLearn: true,
  learnInjectChars: 1800,
  learnMaxEntries: 60,
  learnMaxBytes: 48 * 1024,
  // 团队/子会话策略：inherit（默认，保持旧行为）| off | allow | exclude
  teamPolicy: 'inherit',
  teamAllow: [],
  teamExclude: [],
};

/** 太泛、匹配上了也不说明问题的中文二元组。 */
const STOP_BIGRAMS = new Set([
  '帮我', '一下', '可以', '这个', '那个', '如何', '什么', '怎么', '需要', '进行',
  '我的', '我们', '你们', '他们', '现在', '然后', '如果', '因为', '所以', '但是',
  '一个', '没有', '就是', '还是', '已经', '这样', '那样', '自己', '时候', '问题',
  '文字', '内容', '任务', '要求', '希望', '想要', '看看', '试试', '好的', '谢谢',
]);

/** 太泛的英文词，参与匹配只会制造噪声。 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'use',
  'when', 'what', 'how', 'can', 'are', 'not', 'but', 'all', 'any', 'its',
]);

const LOG_MAX_BYTES = 512 * 1024;

function log(line) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = join(dshHome, 'auto-skill.log');
  const text = JSON.stringify({ at: new Date().toISOString(), ...line });
  try {
    // 日志只用于排查，超过上限就重来，避免长期使用无限增长。
    if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, '', 'utf8');
  } catch {
    // 文件还不存在时忽略。
  }
  appendFile(file, text + '\n', 'utf8').catch(() => {});
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const list = (value) => (Array.isArray(value)
    ? value
    : String(value == null ? '' : value).split(/[,\s]+/))
    .map((item) => String(item).trim())
    .filter(Boolean);
  const policyRaw = String(raw.teamPolicy || process.env.DSH_AUTO_SKILL_TEAM_POLICY || 'inherit').toLowerCase();
  const teamPolicy = ['inherit', 'off', 'allow', 'exclude'].includes(policyRaw) ? policyRaw : 'inherit';
  return {
    enabled: raw.enabled !== false,
    maxSkills: clampInt(raw.maxSkills, 1, 3, DEFAULTS.maxSkills),
    maxChars: clampInt(raw.maxChars, 1000, 60000, DEFAULTS.maxChars),
    minShared: clampInt(raw.minShared, 1, 10, DEFAULTS.minShared),
    minMessageChars: clampInt(raw.minMessageChars, 0, 2000, DEFAULTS.minMessageChars),
    minScore: clampInt(raw.minScore, 1, 999, DEFAULTS.minScore),
    debug: raw.debug === true,
    learnEnabled: raw.learnEnabled !== false,
    autoLearn: raw.autoLearn !== false,
    learnInjectChars: clampInt(raw.learnInjectChars, 0, 12000, DEFAULTS.learnInjectChars),
    learnMaxEntries: clampInt(raw.learnMaxEntries, 5, 500, DEFAULTS.learnMaxEntries),
    learnMaxBytes: clampInt(raw.learnMaxBytes, 4096, 512 * 1024, DEFAULTS.learnMaxBytes),
    teamPolicy,
    teamAllow: list(raw.teamAllow == null ? process.env.DSH_AUTO_SKILL_TEAM_ALLOW : raw.teamAllow),
    teamExclude: list(raw.teamExclude == null ? process.env.DSH_AUTO_SKILL_TEAM_EXCLUDE : raw.teamExclude),
  };
}

/** 团队/子会话：subagent origin、带父会话或非零委派深度。 */
function isTeamAgent(agent) {
  const header = (agent && agent.session && agent.session.header) || {};
  if (header.origin === 'subagent') return true;
  if (header.parentSession) return true;
  return Number(header.delegationDepth || 0) > 0;
}

/** 团队会话下是否允许自动注入该技能；普通会话不调用。 */
function teamSkillAllowed(name, config) {
  const skill = String(name || '');
  if (config.teamPolicy === 'off') return false;
  if (config.teamExclude.includes(skill)) return false;
  if (config.teamPolicy === 'allow') return config.teamAllow.includes(skill);
  return true;
}

/** 抽英文词 + 中文二元组，作为匹配用的关键词集合。 */
/** 抽英文词 + 中文二元组/三元组，作为匹配用的关键词集合。 */
const PARTICLE = /[的了是在和与就都也还很太更最再又啦呢吗吧啊]/;

function keywordsOf(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const word of lower.match(/[a-z][a-z0-9-]{2,}/g) || []) {
    if (!STOP_WORDS.has(word)) out.add(word);
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length <= 2) {
      if (!STOP_BIGRAMS.has(run) && !PARTICLE.test(run)) out.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (STOP_BIGRAMS.has(gram) || PARTICLE.test(gram)) continue;
      out.add(gram);
      if (i + 3 <= run.length) out.add(run.slice(i, i + 3));
    }
  }
  return out;
}

/** 统计每个关键词出现在多少个技能里：出现得越少，权重越高。 */
function buildDf(skills) {
  const df = new Map();
  for (const skill of skills) {
    const text = String(skill.description || '') + ' ' + String(skill.whenToUse || '') + ' ' + String(skill.name || '');
    for (const kw of keywordsOf(text)) df.set(kw, (df.get(kw) || 0) + 1);
  }
  return df;
}

/**
 * 给一个技能打分。
 * - 完整技能名出现在消息里：强命中（+60）
 * - 技能名分词命中：每个 +8
 * - 描述关键词命中：按稀有度给 1~8 分，中文三元组再加 2
 * - 命中 >= minShared 个不同关键词才算强命中
 */
function scoreSkill(messageText, skill, config, df = new Map()) {
  const message = String(messageText || '').toLowerCase();
  const skillName = String(skill.name || '').toLowerCase();
  if (skillName === '') return undefined;

  let score = 0;
  let strong = false;

  if (skillName.length >= 2 && message.includes(skillName)) {
    score += 60;
    strong = true;
  }
  for (const part of skillName.split(/[-_.\s]+/)) {
    if (part.length >= 3 && message.includes(part)) score += 8;
  }

  const desc = String(skill.description || '') + ' ' + String(skill.whenToUse || '');
  const raw = [];
  for (const kw of keywordsOf(desc)) {
    if (kw.length < 2) continue;
    if (message.includes(kw)) raw.push(kw);
  }
  raw.sort((a, b) => b.length - a.length);
  const kept = [];
  for (const kw of raw) if (!kept.some((k) => k.includes(kw))) kept.push(kw);
  for (const kw of kept) {
    const dfv = df.get(kw) || 1;
    score += Math.max(2, Math.round(6 / dfv)) + (kw.length >= 3 ? 2 : 0);
  }
  if (kept.length >= config.minShared) strong = true;

  if (!strong || score < config.minScore) return undefined;
  return { score, shared: kept.slice(0, 8) };
}

function renderSkillContent(skill, maxChars, learned) {
  const body = String(skill.content || '');
  const clipped = body.length > maxChars
    ? body.slice(0, maxChars) + `\n\n[auto-skill 已截断：原正文 ${body.length} 字符，只注入前 ${maxChars} 字符。需要完整内容请调用 skill("${skill.name}")。]`
    : body;
  const base = skill.resourceBase;
  let resourceLine = `Resources for this skill are managed by provider "${skill.provider}".`;
  if (base && base.kind === 'directory') resourceLine = `Base directory for this skill: ${base.path}`;
  else if (base && base.kind === 'url') resourceLine = `Base URL for this skill: ${base.url}`;
  const lines = [
    `<skill_content name="${String(skill.name).replace(/"/g, '&quot;')}">`,
    '<skill_resources>',
    resourceLine,
    'Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    clipped,
    '</skill_instructions>',
  ];
  if (learned && String(learned).trim() !== '') {
    lines.push('', '<skill_learned>', String(learned).trim(), '</skill_learned>');
  }
  lines.push('</skill_content>');
  return lines.join('\n');
}

function renderAutoSkillMessage(skill, hit, config, learned) {
  const header = [
    '<system-reminder>',
    `自动技能：本轮任务与技能「${skill.name}」匹配（相关词：${hit.shared.slice(0, 6).join('、') || '技能名'}），已自动加载。`,
    '直接按下面的技能说明执行，不需要再调用 `skill` 工具，也不需要向用户复述这段说明。',
    `如果本轮摸索出了该技能没写、但确实有效的做法，任务结束时调用 skill_learn(skill="${skill.name}", method="...", evidence="...") 记一条，下次会自动带上。`,
    '</system-reminder>',
    '',
  ].join('\n');
  return header + renderSkillContent(skill, config.maxChars, learned);
}

/* ---------------------------------------------------------------- learnings */

/** 技能目录：~/.dsh/skills */
function skillsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills');
}

function readFrontmatterName(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return '';
  const line = match[1].split(/\r?\n/).find((row) => /^name\s*:/.test(row));
  if (!line) return '';
  return line.replace(/^name\s*:\s*/, '').replace(/^["']|["']$/g, '').trim();
}

/** 按技能名（或目录名）找本地技能目录；找不到返回 null。 */
function findSkillDir(skillName) {
  const wanted = String(skillName || '').trim();
  if (wanted === '') return null;
  const root = skillsRoot();
  let entries = [];
  try {
    entries = readdirSyncSafe(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(root, entry.name);
    if (entry.name === wanted) return dir;
    try {
      const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      if (readFrontmatterName(text) === wanted) return dir;
    } catch {
      // 没有 SKILL.md 就不是技能目录。
    }
  }
  return null;
}

function readdirSyncSafe(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
}

function learnedFile(dir) {
  return join(dir, 'learned.md');
}

function parseLearned(text) {
  const entries = [];
  const blocks = String(text || '').split(/^## /m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const heading = lines.shift() || '';
    entries.push({ heading: heading.trim(), body: lines.join('\n').trim() });
  }
  return entries;
}

function serializeLearned(entries) {
  return entries.map((entry) => `## ${entry.heading}\n${entry.body}`.trimEnd()).join('\n\n') + '\n';
}

/**
 * 经验里出现的是工具调用原文，可能顺手带上密钥（例如某条命令里写了 token）。
 * 写盘前一律打码：宁可丢掉细节，也不把凭据落进技能目录。
 */
const SECRET_RULES = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];

const SECRET_PREFIX_RULES = [
  /\b(Bearer\s+)[A-Za-z0-9._-]{16,}/g,
  /\b((?:api[-_]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*["']?)[^\s"',}]{8,}/gi,
];

function redactSecrets(text) {
  let out = String(text || '');
  for (const rule of SECRET_RULES) out = out.replace(rule, '<redacted>');
  for (const rule of SECRET_PREFIX_RULES) out = out.replace(rule, (_match, prefix) => `${prefix}<redacted>`);
  return out;
}

function normalizeLearning(text) {
  return String(text || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[，。；：、"“”（）()\[\]【】]/g, '');
}

/** 追加一条经验；重复的（同做法）直接跳过。返回 {ok, reason, count} */
function appendLearning(skillName, entry, config) {
  const dir = findSkillDir(skillName);
  if (!dir) return { ok: false, reason: 'skill-not-found' };
  const file = learnedFile(dir);
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  const method = redactSecrets(entry.method).trim();
  const evidence = entry.evidence ? redactSecrets(entry.evidence).trim() : '';
  const hash = createHash('sha256').update(normalizeLearning(method + '|' + evidence)).digest('hex').slice(0, 12);
  if (existing.includes('h:' + hash)) return { ok: false, reason: 'duplicate' };

  const stamp = new Date().toISOString();
  const lines = [
    `## ${stamp} [${entry.tag || 'manual'}] <!-- h:${hash} -->`,
    `- 做法：${method}`,
  ];
  if (evidence) lines.push(`- 依据：${evidence}`);
  if (entry.session) lines.push(`- 会话：${entry.session}`);
  const next = (existing.trimEnd() ? existing.trimEnd() + '\n\n' : '') + lines.join('\n') + '\n';

  // 条目数与字节数双上限：超了就从最旧的开始丢。
  let entries = parseLearned(next);
  if (entries.length > config.learnMaxEntries) entries = entries.slice(entries.length - config.learnMaxEntries);
  let text = serializeLearned(entries);
  while (text.length > config.learnMaxBytes && entries.length > 1) {
    entries = entries.slice(1);
    text = serializeLearned(entries);
  }
  writeFileSync(file, text, 'utf8');
  return { ok: true, count: entries.length, dir, hash };
}

/** 取注入用的经验正文（按时间顺序，保留最新的尾部）。 */
function learnedDigest(skillName, maxChars) {
  if (!maxChars || maxChars <= 0) return '';
  const dir = findSkillDir(skillName);
  if (!dir) return '';
  let text = '';
  try {
    text = readFileSync(learnedFile(dir), 'utf8');
  } catch {
    return '';
  }
  let entries = parseLearned(text);
  if (!entries.length) return '';
  // 去掉内部 hash 注释，注入内容更干净。
  const cleaned = entries.map((entry) => ({ heading: entry.heading.replace(/\s*<!--.*?-->\s*/, ''), body: entry.body }));
  let out = cleaned.map((entry) => `## ${entry.heading}\n${entry.body}`).join('\n\n');
  while (out.length > maxChars && cleaned.length > 1) {
    cleaned.shift();
    out = cleaned.map((entry) => `## ${entry.heading}\n${entry.body}`).join('\n\n');
  }
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  const prefix = '（本机积累的有效做法，按时间顺序，越靠后越新）\n';
  // 总长必须守住调用方给的上限，宁可从最旧的截断。
  const room = Math.max(0, maxChars - prefix.length);
  return prefix + (room > 0 ? out.slice(Math.max(0, out.length - room)) : '');
}

/** 从 tools/result 的回调里抽出一条可读的操作记录。 */
function describeToolCall(exec, result) {
  const toolName = String((exec && (exec.name || exec.tool)) || 'tool');
  let ok = true;
  if (result && typeof result === 'object') {
    if (result.ok === false || result.isError === true) ok = false;
    if (result.error) ok = false;
  }
  let args = '';
  try {
    const raw = (exec && (exec.args || exec.arguments)) || {};
    args = JSON.stringify(raw);
  } catch {
    args = '';
  }
  return { tool: toolName, ok, args: redactSecrets(args).slice(0, 140) };
}

/** 取本轮用户输入：最后一条真正的用户消息（排除技能目录/注入类消息）。 */
const NON_USER_SOURCES = new Set(['skill-catalog', 'auto-skill', 'agent-instructions', 'skill-invocation', 'runtime-context']);
function latestUserText(messages) {
  const textOf = (message) => (message.content || [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const kindOf = (message) => ((message.source && message.source.kind) || '');
  const pick = (keep) => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role !== 'user') continue;
      if (!keep(message)) continue;
      const text = textOf(message);
      if (text !== '') return text;
    }
    return '';
  };
  // 1) 真正的用户输入：会话把任务消息标为 kind === 'user'
  const direct = pick((message) => kindOf(message) === 'user');
  if (direct !== '') return direct;
  // 2) 没有来源标记的用户消息（历史会话/测试环境）
  return pick((message) => !NON_USER_SOURCES.has(kindOf(message)));
}

export function apply(ctx, configInput) {
  const config = normalizeConfig(configInput);
  /** sessionId -> Set<skillName>，同一会话里同一个技能只自动注入一次。 */
  const applied = new Map();
  /** 学习状态：buffer 记录注入之后发生的工具调用，last 记录上一次注入的技能。 */
  const learnState = { buffer: [], last: null };

  const rankSkills = async (lookup, messageText) => {
    // 会话作用域的清单最准；再补一份不带 scope 的，避免某个 provider 只在
    // 其中一种 lookup 下才列出技能（例如本机 skills 目录）。
    const [scoped, plain] = await Promise.all([
      ctx.skills.snapshot(lookup),
      ctx.skills.snapshot({ cwd: lookup.cwd, signal: lookup.signal }),
    ]);
    const byName = new Map();
    for (const snapshot of [scoped, plain]) {
      const list = snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : [];
      for (const skill of list) {
        if (!skill || !skill.name || byName.has(skill.name)) continue;
        if (skill.invocation && skill.invocation.modelInvocable === false) continue;
        byName.set(skill.name, skill);
      }
    }
    const skills = [...byName.values()];
    const df = buildDf(skills);
    const ranked = [];
    for (const skill of skills) {
      const hit = scoreSkill(messageText, skill, config, df);
      if (hit) ranked.push({ skill, hit });
    }
    ranked.sort((a, b) => b.hit.score - a.hit.score || String(a.skill.name).localeCompare(String(b.skill.name)));
    return { ranked, total: skills.length };
  };

  if (config.debug) log({ event: 'apply', config });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision.kind === 'reject') return decision;
      if (payload.step !== 1) return decision;
      if (!config.enabled) return decision;

      const agent = payload.agent;
      if (config.debug) log({ event: 'step', session: String((payload.agent && payload.agent.session && payload.agent.session.id) || '?'), msgs: decision.messages.map((m) => ({ role: m.role, kind: m.source && m.source.kind, len: (m.content || []).reduce((n, b) => n + (typeof b.text === 'string' ? b.text.length : 0), 0), head: ((m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ') || '').slice(0, 60) })) });
      if (!agent) return decision;
      const messageText = latestUserText(decision.messages);
      if (messageText.length < config.minMessageChars) return decision;

      // 新一轮开始前，先把上一轮「注入过技能 + 随后确实跑通的工具链」沉淀成一条经验。
      if (config.learnEnabled && config.autoLearn) {
        const pending = learnState.last;
        if (pending && pending.skills.length > 0 && learnState.buffer.length >= 2) {
          const okCalls = learnState.buffer.filter((call) => call.ok);
          if (okCalls.length >= 2) {
            const chain = learnState.buffer.slice(-8).map((call) => call.tool + (call.ok ? '' : '(失败)')).join(' → ');
            const args = okCalls.slice(-3).map((call) => `${call.tool}: ${call.args}`).join(' ; ');
            const saved = appendLearning(pending.skills[0], {
              tag: 'auto',
              method: `本轮任务的有效操作链：${chain}`,
              evidence: args ? `关键调用参数：${args}` : '',
              session: pending.session,
            }, config);
            log({ event: 'learn-auto', skill: pending.skills[0], ok: saved.ok, reason: saved.reason, calls: learnState.buffer.length });
          }
        }
        learnState.buffer = [];
      }

      const sessionKey = String((agent.session && agent.session.id) || 'unknown');
      const seen = applied.get(sessionKey) || new Set();
      const teamSession = isTeamAgent(agent);
      if (teamSession && config.teamPolicy !== 'inherit') {
        log({ event: 'team-policy', session: sessionKey, policy: config.teamPolicy, allow: config.teamAllow, exclude: config.teamExclude });
      }

      const cwd = await ctx.workingDirectory.ensure(agent, payload.signal);
      const lookup = { cwd, signal: payload.signal, scope: agent };
      const { ranked, total } = await rankSkills(lookup, messageText);
      if (ranked.length === 0) {
        if (config.debug) log({ event: 'no-match', session: sessionKey, skills: total, chars: messageText.length });
        return decision;
      }

      const picked = [];
      for (const entry of ranked) {
        if (picked.length >= config.maxSkills) break;
        if (seen.has(entry.skill.name)) continue;
        if (teamSession && !teamSkillAllowed(entry.skill.name, config)) continue;
        // 摘要里没有正文，必须再 get 一次拿到完整内容。
        const full = await ctx.skills.get(entry.skill.name, lookup);
        if (!full || !full.content) continue;
        if (full.invocation && full.invocation.modelInvocable === false) continue;
        picked.push({ skill: full, hit: entry.hit });
      }
      if (picked.length === 0) return decision;

      const injections = picked.map(({ skill, hit }) => ({
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: renderAutoSkillMessage(skill, hit, config, config.learnEnabled ? learnedDigest(skill.name, config.learnInjectChars) : ''),
        }],
        source: { kind: 'auto-skill', form: 'instructions', name: skill.name, score: hit.score },
      }));

      for (const { skill } of picked) seen.add(skill.name);
      applied.set(sessionKey, seen);
      learnState.last = { session: sessionKey, skills: picked.map((entry) => entry.skill.name), at: Date.now() };
      learnState.buffer = [];

      log({
        event: 'inject',
        session: sessionKey,
        skills: picked.map((p) => ({ name: p.skill.name, score: p.hit.score, shared: p.hit.shared.slice(0, 8) })),
        chars: messageText.length,
      });

      return { ...decision, messages: [...decision.messages, ...injections] };
    } catch (error) {
      log({ event: 'error', message: String(error && error.message ? error.message : error) });
      return decision;
    }
  });

  // 观察工具最终结果：注入技能之后跑通的调用链，会在下一轮开始时沉淀成一条经验。
  ctx.on('tools/result', (exec, result) => {
    try {
      if (!config.learnEnabled || !learnState.last) return;
      const call = describeToolCall(exec, result);
      learnState.buffer.push(call);
      if (learnState.buffer.length > 40) learnState.buffer.shift();
    } catch {
      // 观察失败绝不影响工具本身。
    }
  });

  ctx.inject(['tools'], (scope) => scope.effect(() => {
    const disposers = [];
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

    disposers.push(scope.tools.register({
      name: 'skill_learn',
      description: '把一条「有效做法」记到某个技能名下（写进技能目录的 learned.md，不改 SKILL.md）。下次该技能被自动加载时会带上，重复做法自动跳过。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', description: '技能名（frontmatter 里的 name）' },
          method: { type: 'string', description: '具体做法：命令、步骤、参数、注意事项' },
          evidence: { type: 'string', description: '为什么有效 / 验证结果，可省略' },
        },
        required: ['skill', 'method'],
      },
      output,
      async execute(args) {
        if (!config.learnEnabled) throw new Error('学习功能已关闭（learnEnabled=false）');
        const skill = String(args?.skill || '').trim();
        const method = String(args?.method || '').trim();
        if (!skill || !method) throw new Error('需要 skill 与 method');
        const saved = appendLearning(skill, { tag: 'manual', method, evidence: args?.evidence }, config);
        log({ event: 'learn-manual', skill, ok: saved.ok, reason: saved.reason });
        if (!saved.ok) return JSON.stringify({ ok: false, reason: saved.reason, skill }, null, 2);
        return JSON.stringify({ ok: true, skill, entries: saved.count, file: learnedFile(saved.dir) }, null, 2);
      },
    }));

    disposers.push(scope.tools.register({
      name: 'skill_learnings',
      description: '列出本机各技能积累了多少条有效做法，以及最近一条的内容。',
      parameters: { type: 'object', additionalProperties: false, properties: { skill: { type: 'string', description: '只看某个技能' } } },
      output,
      async execute(args) {
        const wanted = String(args?.skill || '').trim();
        const root = skillsRoot();
        let dirs = [];
        try {
          dirs = readdirSyncSafe(root);
        } catch {
          return JSON.stringify({ ok: true, skills: [] }, null, 2);
        }
        const rows = [];
        for (const entry of dirs) {
          const dir = join(root, entry.name);
          const skillName = (() => {
            try {
              return readFrontmatterName(readFileSync(join(dir, 'SKILL.md'), 'utf8')) || entry.name;
            } catch {
              return entry.name;
            }
          })();
          if (wanted && skillName !== wanted) continue;
          let text = '';
          try {
            text = readFileSync(learnedFile(dir), 'utf8');
          } catch {
            continue;
          }
          const entries = parseLearned(text);
          rows.push({ skill: skillName, dir, entries: entries.length, last: entries.length ? entries[entries.length - 1].heading : '' });
        }
        return JSON.stringify({ ok: true, skills: rows }, null, 2);
      },
    }));

    disposers.push(scope.tools.register({
      name: 'skill_forget',
      description: '清空某个技能积累的有效做法（learned.md）。需要 confirm="CLEAR" 才会执行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { skill: { type: 'string' }, confirm: { type: 'string', description: '固定写 CLEAR' } },
        required: ['skill', 'confirm'],
      },
      output,
      async execute(args) {
        if (args?.confirm !== 'CLEAR') throw new Error('需要 confirm="CLEAR"');
        const dir = findSkillDir(String(args?.skill || ''));
        if (!dir) throw new Error('找不到技能：' + args?.skill);
        const file = learnedFile(dir);
        if (!existsSync(file)) return JSON.stringify({ ok: true, cleared: false, reason: 'no-learnings' }, null, 2);
        writeFileSync(file, '', 'utf8');
        log({ event: 'learn-clear', skill: args.skill });
        return JSON.stringify({ ok: true, cleared: true, skill: args.skill }, null, 2);
      },
    }));

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
          else if (dispose && typeof dispose.dispose === 'function') dispose.dispose();
        } catch {
          // 清理失败不影响其它插件。
        }
      }
    };
  }));

  // 诊断路由：GET /api/dsh-auto-skill/match?text=...&dir=...
  ctx.inject(['webServer'], (scope) => scope.effect(() => {
    const route = scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-auto-skill/match',
      handler(req, res) {
        const remote = String((req.socket && req.socket.remoteAddress) || '');
        if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
          res.statusCode = 403;
          res.end('loopback only');
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const text = (url.searchParams.get('text') || '').slice(0, 20000);
        const dir = url.searchParams.get('dir') || process.cwd();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        (async () => {
          const lookup = { cwd: dir, signal: controller.signal };
          const snapshot = await ctx.skills.snapshot(lookup);
          const skills = (snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : [])
            .filter((skill) => skill && (!skill.invocation || skill.invocation.modelInvocable !== false));
          const df = buildDf(skills);
          const scored = [];
          for (const skill of skills) {
            const hit = scoreSkill(text, skill, config, df);
            if (hit) scored.push({ skill, hit });
          }
          scored.sort((a, b) => b.hit.score - a.hit.score);
          const rows = [];
          for (const { skill, hit } of scored.slice(0, 10)) {
            const full = await ctx.skills.get(skill.name, lookup);
            rows.push({
              name: skill.name,
              description: skill.description,
              chars: full && full.content ? full.content.length : 0,
              score: hit.score,
              shared: hit.shared,
            });
          }
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, version: VERSION, text, total: skills.length, matches: rows, config }, null, 2));
        })().catch((error) => {
          res.statusCode = 500;
          res.end(String(error && error.message ? error.message : error));
        }).finally(() => clearTimeout(timer));
      },
    });
    const learnedRoute = scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-auto-skill/learned',
      handler(req, res) {
        const remote = String((req.socket && req.socket.remoteAddress) || '');
        if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
          res.statusCode = 403;
          res.end('loopback only');
          return;
        }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const skill = (url.searchParams.get('name') || '').trim();
          if (!skill) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'missing name' }));
            return;
          }
          const digest = learnedDigest(skill, 20000);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, skill, chars: digest.length, learned: digest }, null, 2));
        } catch (error) {
          res.statusCode = 500;
          res.end(String((error && error.message) || error));
        }
      },
    });

    const healthRoute = scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-auto-skill/health',
      handler(req, res) {
        const remote = String((req.socket && req.socket.remoteAddress) || '');
        if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
          res.statusCode = 403;
          res.end('loopback only');
          return;
        }
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          ok: true,
          version: VERSION,
          teamPolicy: config.teamPolicy,
          teamAllow: config.teamAllow,
          teamExclude: config.teamExclude,
        }, null, 2));
      },
    });

    return () => {
      route.dispose?.();
      learnedRoute.dispose?.();
      healthRoute.dispose?.();
    };
  }));
}

/** Test-only surface (kept ASCII so the file stays valid UTF-8). */
export const __internals = { keywordsOf, buildDf, scoreSkill, latestUserText, renderAutoSkillMessage, renderSkillContent, normalizeConfig, isTeamAgent, teamSkillAllowed, appendLearning, learnedDigest, parseLearned, findSkillDir, describeToolCall, skillsRoot, redactSecrets };
