#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 0.3.2 固定 5 行报告校验（自包含）。
 *
 * 标准格式（顺序固定，最多 8 行）：
 *   结论：…
 *   交付：…
 *   证据：…
 *   需审核：…
 *   遗留：…
 *
 * - 缺段、乱序、超过 8 行都返回结构化错误（不静默截断）；
 * - 允许在 5 个标签行后追加续行（例如证据里的命令/数字），总行数 ≤ 8；
 * - formatReport() 用同一份 LABELS 生成标准 5 行，hub 汇总与镜像共用。
 */

const LABELS = ['结论', '交付', '证据', '需审核', '遗留'];
const MAX_LINES = 8;
const LABEL_LINE_RE = /^\s*(结论|交付|证据|需审核|遗留)\s*[：:]\s*(.*)$/;

function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trimEnd();
}

function splitLines(text) {
  const normalized = normalize(text);
  return normalized ? normalized.split('\n') : [];
}

function validate(text) {
  const lines = splitLines(text);
  const totalLines = lines.length;
  if (totalLines === 0) {
    return { ok: false, code: 'empty', message: '报告为空', totalLines, limit: MAX_LINES, missing: LABELS.slice() };
  }
  const entries = [];
  lines.forEach((line, index) => {
    const match = LABEL_LINE_RE.exec(line);
    if (match) entries.push({ label: match[1], content: match[2].trim(), index });
  });
  const present = new Set(entries.map((entry) => entry.label));
  const missing = LABELS.filter((label) => !present.has(label));
  const order = entries.map((entry) => entry.label);
  const expected = LABELS.filter((label) => present.has(label));
  const outOfOrder = order.some((label, index) => label !== expected[index]);

  if (totalLines > MAX_LINES) {
    return {
      ok: false,
      code: 'too-many-lines',
      message: `报告 ${totalLines} 行，超过上限 ${MAX_LINES} 行`,
      totalLines,
      limit: MAX_LINES,
      missing,
      order,
    };
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'missing-sections',
      message: `缺少固定段：${missing.join('、')}`,
      totalLines,
      limit: MAX_LINES,
      missing,
      order,
    };
  }
  if (outOfOrder) {
    return {
      ok: false,
      code: 'out-of-order',
      message: `固定段顺序应为：${LABELS.join(' → ')}`,
      totalLines,
      limit: MAX_LINES,
      missing,
      order,
    };
  }
  const empty = entries.filter((entry) => !entry.content).map((entry) => entry.label);
  if (empty.length) {
    return {
      ok: false,
      code: 'empty-sections',
      message: `这些段没有内容：${empty.join('、')}`,
      totalLines,
      limit: MAX_LINES,
      missing,
      order,
    };
  }
  return {
    ok: true,
    code: 'ok',
    message: 'ok',
    totalLines,
    limit: MAX_LINES,
    lines,
    labels: LABELS.slice(),
    sections: Object.fromEntries(entries.map((entry) => [entry.label, entry.content])),
  };
}

function formatReport(sections = {}) {
  const body = Array.isArray(sections)
    ? Object.fromEntries(sections.map((value, index) => [LABELS[index], value]))
    : sections;
  const lines = LABELS.map((label) => {
    const raw = body?.[label];
    const text = Array.isArray(raw) ? raw.map((part) => String(part).trim()).filter(Boolean).join('；') : String(raw ?? '').trim();
    if (!text) throw new Error(`missing section: ${label}`);
    return `${label}：${text}`;
  });
  return lines.join('\n');
}

module.exports = { LABELS, MAX_LINES, validate, formatReport, splitLines, normalize };
