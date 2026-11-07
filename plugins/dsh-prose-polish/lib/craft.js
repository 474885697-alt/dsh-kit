/**
 * Shared prose-craft rules for the DSH panel, the Agent tool and the game
 * server.  The rules deliberately describe editing behaviour, not a house
 * style: the model must keep the author's voice while removing the habits that
 * make generated Chinese fiction feel flat.
 */

export const MODES = {
  novel: {
    label: '小说润色',
    instruction: '按中文长篇连载的阅读节奏润色。保留原有情节、人物关系、视角和时态；让每一场戏更具体、更有推进感，而不是换一个故事。',
  },
  tighten: {
    label: '收紧',
    instruction: '在不丢信息的前提下压缩。删掉重复解释、空泛抒情和可以靠动作带出的心理描写；让句子更短、更准，但保留关键停顿。',
  },
  expand: {
    label: '扩写',
    instruction: '只补有信息量的细节：动作、感官、环境反应、人物选择。不要新增情节转折，不要替角色解释动机，不要用形容词灌水。',
  },
  hook: {
    label: '强化开头与钩子',
    instruction: '重点改开头 100 字和结尾最后三句。开头先出现异常、动作或带信息的对话；结尾停在具体动作、台词、发现或反转上，不总结主题。',
  },
  copy: {
    label: '通用文案',
    instruction: '面向游戏、社区、公告或产品说明时，先给结论，再给限制，最后给操作。具体名词和动词优先，少用口号、夸张形容词和空泛承诺。',
  },
}

export const STRENGTHS = {
  light: {
    label: '轻',
    instruction: '只改病句、重复、抽象词和明显不顺的节奏；至少保留原文八成句子。',
  },
  medium: {
    label: '中',
    instruction: '可以调整句序、拆分长句、替换空泛表达，允许删掉约两成冗余；情节事实不变。',
  },
  deep: {
    label: '深',
    instruction: '可以重组段落和场景内部的节奏，允许较大幅度改写；但人物、事实、视角、时间线不能变。',
  },
}

export const CRAFT_RULES = [
  '1. 具体名词、动作和五感承载情绪；少堆形容词，少用“仿佛/像是/似乎”来偷懒。',
  '2. 句子长短交替。紧张处用短句，舒缓处才用长句；不要每段同一个节奏。',
  '3. 对话要有潜台词和人物腔调。不同角色不能像同一个人在说话；不要用对话解释设定。',
  '4. 每一段至少推进一件事：新信息、新动作、新选择、新代价，或人物关系的变化。',
  '5. 开头一百字内出现异常、动作或带信息的对话，不要先讲天气和背景。',
  '6. 每 800–1200 字至少有一次小转折：判断被推翻、代价出现、盟友隐瞒、规则失效。',
  '7. 章末停在具体动作、台词、发现、倒计时或反转上；不要总结主题，不要替读者抒情。',
  '8. 禁止套话：“有些东西一旦回应……”“无名之神没有说明代价”“先看清它，再决定要不要碰”“没有稳赢的路时……”。',
  '9. 不新增原文没有的剧情事实、人物、能力或世界观设定；需要补细节时，只能从已有信息里长出来。',
  '10. 保留原有段落、对话、标点和专有名词；不要输出标题、提纲、改动说明或 Markdown 代码块。',
]

function clean(value, limit = 400) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

export function modeInfo(mode) {
  return MODES[mode] || MODES.novel
}

export function strengthInfo(strength) {
  return STRENGTHS[strength] || STRENGTHS.medium
}

export function buildPolishSystem({ mode = 'novel', strength = 'medium', style = '', instruction = '' } = {}) {
  const selectedMode = modeInfo(mode)
  const selectedStrength = strengthInfo(strength)
  const styleLine = clean(style, 200)
  const extraLine = clean(instruction, 800)
  return [
    '你是一位中文长篇小说的资深编辑，专门做“保留作者声音”的润色。',
    '你的任务不是重写故事，而是让现有文字更有阅读欲望；作者的情节、人物和世界观必须被保留。',
    '',
    `【本次模式】${selectedMode.label}：${selectedMode.instruction}`,
    `【改写力度】${selectedStrength.label}：${selectedStrength.instruction}`,
    styleLine ? `【文体/题材】${styleLine}` : '',
    extraLine ? `【额外要求】${extraLine}` : '',
    '',
    '【硬规则】',
    ...CRAFT_RULES,
    '',
    '【输出】只输出润色后的完整正文。不要解释，不要列改动点，不要加“润色后：”之类的标签，不要用代码块。',
  ].filter(Boolean).join('\n')
}

export function buildPolishUser({ text = '' } = {}) {
  return [
    '【原文开始】',
    String(text),
    '【原文结束】',
    '',
    '请直接输出润色后的完整文本，保留原有段落与对话格式。若原文很短，保持它的信息量，不要扩写成另一篇。',
  ].join('\n')
}

export function normalizePolishOutput(value) {
  let text = typeof value === 'string' ? value : ''
  text = text.replace(/^\uFEFF/, '').trim()
  text = text.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  text = text.replace(/^(?:润色后|修改后|优化后|改写后|正文)\s*[:：]\s*/i, '').trim()
  text = text.replace(/^【(?:润色后|修改后|优化后)】\s*/, '').trim()
  return text
}

export function validatePolishRequest(body) {
  const text = typeof body?.text === 'string' ? body.text : ''
  if (!text.trim()) throw new Error('原文为空')
  if (text.length > 32000) throw new Error('原文过长（上限 32,000 字符）')
  const mode = Object.prototype.hasOwnProperty.call(MODES, body?.mode) ? body.mode : 'novel'
  const strength = Object.prototype.hasOwnProperty.call(STRENGTHS, body?.strength) ? body.strength : 'medium'
  return {
    text,
    mode,
    strength,
    style: clean(body?.style, 200),
    instruction: clean(body?.instruction, 800),
  }
}
