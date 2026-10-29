/**
 * 面向模型的记忆工具（v7：分区模型）。
 *
 * 读取端只做三件事：搜、取、答。所有「想清楚」的成本都压到写入端。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { CORE_NAME, DEFAULT_SPACE, normalizeWhen } from './core.js'

/** 统一的文本渲染。 */
const textRender = (_args, value) => [{ type: 'text', text: value }]

/** 把一条事实渲染成一行。 */
function factLine(fact) {
  const slot = fact.slot ? `[${fact.slot}] ` : ''
  let suffix = ''
  if (fact.since) suffix += `（自 ${fact.since}）`
  if (fact.until) suffix += `（至 ${fact.until}）`
  return `- ${slot}${fact.text}${suffix}`
}

/** 按分节渲染事实。 */
function renderFacts(facts) {
  const lines = []
  let lastGroup = null
  for (const fact of facts) {
    const group = fact.group ?? null
    if (group !== lastGroup) {
      if (group) lines.push('', `### ${group}`)
      lastGroup = group
    }
    lines.push(factLine(fact))
  }
  return lines
}

/**
 * 渲染一条词条。
 * @param {object} entry
 * @param {{full?: boolean}} options full 为 true 时带上细节与相关词条
 */
function renderEntry(entry, options = {}) {
  const lines = [`【${entry.space} › ${entry.name}】`]
  if (entry.summary) lines.push(`摘要：${entry.summary}`)
  if (entry.aliases.length > 0) lines.push(`别名：${entry.aliases.join('、')}`)
  lines.push('')
  if (entry.facts.length === 0) {
    lines.push('（还没有任何事实）')
  } else {
    lines.push(...renderFacts(entry.facts))
  }
  if (options.full && entry.details) {
    lines.push('', '### 细节', '', entry.details)
  }
  if (options.full && entry.related.length > 0) {
    lines.push('', `相关词条：${entry.related.join('、')}（需要时用 memory_open 另外打开）`)
  }
  return lines.join('\n').trimEnd()
}

/**
 * 构造工具集。
 * @param {import('./core.js').MemoryStore} store
 */
export function buildTools(store) {
  const resolveSpace = (input) => String(input ?? '').trim() || store.defaultSpace

  const recallTool = defineTool({
    name: 'memory_recall',
    description:
      '按话题取回最相关的记忆词条（含摘要与事实）。这是回答个人问题时的首选工具：只要话题可能和用户的个人情况、偏好、经历、健康、工作、正在做的事有关，就先调用它再回答，不要凭记忆猜测。默认只在「日常」分区检索；用户明确说在做另一件长期的事（比如一起写小说、做某个项目）时，传对应的 space。',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: '话题关键词，尽量短，例如「晚饭」「血压」「主角设定」。',
      },
      space: {
        type: 'string',
        description: '分区名，省略则用默认分区「日常」。',
      },
      limit: {
        type: 'number',
        description: '最多取回几条词条，默认 3，上限 5。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const topic = String(args.topic ?? '').trim()
      if (!topic) return '话题不能为空。'
      const space = resolveSpace(args.space)
      const limit = Math.min(Math.max(Math.round(args.limit ?? 3), 1), 5)

      if (!store.hasSpace(space)) {
        return `分区「${space}」不存在。现有分区：${store.listSpaces().map((s) => s.name).join('、')}。`
      }

      const hits = store.search(space, topic, limit)
      const core = store.renderCore(space)
      const blocks = hits.map((hit) => {
        store.bumpUsage(`${space}/${hit.entry.name}`)
        return renderEntry(hit.entry)
      })

      if (blocks.length > 0) {
        const parts = []
        if (core) parts.push(core, '')
        parts.push(`按「${topic}」在「${space}」取回 ${blocks.length} 条：`, '')
        parts.push(blocks.join('\n\n'))
        return parts.join('\n')
      }

      // 当前分区没命中 → 跨分区兜底一次
      const fallback = store.searchAll(topic, limit, space)
      if (fallback.length > 0) {
        const parts = [`「${space}」里没有与「${topic}」相关的记忆。跨分区找到 ${fallback.length} 条（来自其他分区）：`, '']
        parts.push(fallback.map((hit) => renderEntry(hit.entry)).join('\n\n'))
        parts.push('', '（跨分区结果仅供参考，不要当成当前分区的事实。）')
        return parts.join('\n')
      }

      return `没有找到与「${topic}」相关的记忆。\n（如果用户正在告诉你相关的事，可以用 memory_save 记下来。）`
    },
  })

  const openTool = defineTool({
    name: 'memory_open',
    description:
      '打开一个词条的完整内容（含细节段落与相关词条）。当 memory_recall 给出的摘要不够、或者你知道确切的词条名时用它。',
    parameters: {
      entry: {
        type: 'string',
        required: true,
        description: '词条名，例如「饮食」「主角设定」。',
      },
      space: {
        type: 'string',
        description: '分区名，省略则用默认分区「日常」。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const entryName = String(args.entry ?? '').trim()
      if (!entryName) return '词条名不能为空。'
      const space = resolveSpace(args.space)

      if (!store.hasSpace(space)) {
        return `分区「${space}」不存在。现有分区：${store.listSpaces().map((s) => s.name).join('、')}。`
      }

      if (entryName === CORE_NAME) {
        const text = store.renderCore(space)
        return text || `「${space}」的基本记忆还是空的。`
      }

      const entry = store.readEntry(space, entryName)
      if (!entry) {
        return `「${space}」里没有名为「${entryName}」的词条。\n现有词条：${store.entryNames(space).join('、') || '（还没有）'}`
      }
      store.bumpUsage(`${space}/${entryName}`)
      return renderEntry(entry, { full: true })
    },
  })

  const saveTool = defineTool({
    name: 'memory_save',
    description:
      '把用户的事写入长期记忆。只记关于用户本人的、或用户与你之间发生过的事；不要记网上查得到的通用知识。每条事实写成一句独立、完整、能脱离上下文读懂的话。需要「以后被修正」的事实加方括号槽位（例如 [辣度] 微辣），同槽位新值会自动替换旧值。写入前把功夫做足：一个主题一个词条，写透，不要把同一主题拆成许多小词条。',
    parameters: {
      entry: {
        type: 'string',
        description: '词条名，一个主题一个词条，例如「饮食」「主角设定」。写基本记忆时省略。',
      },
      facts: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          '要写入的事实。可用前缀 [槽位] 与后缀 @since/@until；用「分组名：」开头可归入分节，例如「晚餐：[油腻] 不要太油」。',
      },
      summary: {
        type: 'string',
        description: '词条摘要，一两句话，用于检索排序和判断要不要展开。新建词条时必填。',
      },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description:
          '词条名的同义词，务必写全，否则检索不到。例如「饮食」的：吃饭、口味、忌口、点餐、外卖。',
      },
      related: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。高度相关、常常需要一起看的其他词条名。',
      },
      details: {
        type: 'string',
        description: '可选。散文形式的补充细节，可长。只在 memory_open 时返回。',
      },
      space: {
        type: 'string',
        description: '分区名，省略则用默认分区「日常」。分区必须已经存在。',
      },
      core: {
        type: 'boolean',
        description:
          '可选。true 表示写进基本记忆——每次对话都常驻的那几条，只放「不知道就会出错」的底线信息（过敏、称呼、语言偏好、当前主线）。此时 entry 被忽略。',
      },
      global: {
        type: 'boolean',
        description:
          '可选。配合 core: true 使用：true 写进**全局基本记忆**（所有分区都常驻），适合称呼、过敏、语言这类跨分区都成立的事；省略则写进当前分区的基本记忆。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const space = resolveSpace(args.space)
      const facts = Array.isArray(args.facts) ? args.facts : []
      const writeGlobalCore = Boolean(args.core && args.global)

      if (!writeGlobalCore && !store.hasSpace(space)) {
        return [
          `分区「${space}」不存在，未写入。`,
          `现有分区：${store.listSpaces().map((s) => s.name).join('、')}。`,
          '注意：新建分区必须先征得用户同意。请先问用户「要不要为这件事单独开一个分区？」，得到同意后再调用 memory_space_create。',
        ].join('\n')
      }

      if (args.core) {
        if (facts.length === 0) return '未写入：写基本记忆时 facts 不能为空。'
        const result = writeGlobalCore ? store.appendGlobalCore(facts) : store.appendCore(space, facts)
        const where = writeGlobalCore ? '全局基本记忆（所有分区都常驻）' : `「${space}」的基本记忆（每次对话都会常驻）`
        const lines = [`已写入${where}`]
        lines.push(`新增 ${result.added} 条，跳过 ${result.skipped} 条。`)
        lines.push(`额度：${result.chars} / ${result.limit} 字`)
        if (result.similar.length > 0) {
          lines.push('', '以下内容重复，未写入：')
          for (const item of result.similar) lines.push(`  - ${item}`)
        }
        if (result.cross.length > 0) {
          lines.push('', '以下内容在另一级基本记忆里已经有了，未写入：')
          for (const item of result.cross) lines.push(`  - ${item}`)
          lines.push('  （两级基本记忆都会常驻上下文，重复一条就浪费一条。要换层级，得先把原来那条删掉。）')
        }
        if (result.replaced.length > 0) {
          lines.push('', '同槽位的新值已替换旧值：')
          for (const item of result.replaced) lines.push(`  - 「${item.from}」 → 「${item.to}」`)
        }
        if (result.chars > result.limit) {
          lines.push('', '⚠ 已超出额度，超出部分不会常驻，请删减。')
        }
        return lines.join('\n')
      }

      const entryName = String(args.entry ?? '').trim()
      if (!entryName) return '未写入：请给出 entry（或用 core: true 写基本记忆）。'
      if (entryName === CORE_NAME) return '未写入：基本记忆请用 core: true，不要当普通词条写。'
      if (facts.length === 0 && !args.details) return '未写入：facts 和 details 至少要有一项。'

      const existed = store.readEntry(space, entryName) !== null
      if (!existed && !args.summary) {
        return [
          `未写入：「${space}」里还没有「${entryName}」这个词条，新建时必须同时给出 summary（一两句话的摘要）。`,
          '摘要用于检索排序，没有它这条记忆基本等于搜不到。',
        ].join('\n')
      }

      // 「分组名：」前缀 → 分节
      const normalizedFacts = facts.map((raw) => {
        const text = String(raw).trim()
        const groupMatch = /^([^：:\[\]]{1,12})[：:]\s*(.+)$/.exec(text)
        if (!groupMatch) return text
        let body = groupMatch[2].trim()
        let slot = null
        const slotMatch = /^\[([^\]]+)\]\s*/.exec(body)
        if (slotMatch) {
          slot = slotMatch[1]
          body = body.slice(slotMatch[0].length)
        }
        return { text: body, slot, group: groupMatch[1], since: null, until: null }
      })

      const result = store.appendFacts(space, entryName, normalizedFacts, {
        summary: args.summary,
        aliases: args.aliases,
        related: args.related,
        details: args.details,
      })

      const lines = [`已写入「${space} › ${result.entry}」`]
      lines.push(`新增 ${result.added} 条，跳过 ${result.skipped} 条。`)
      if (!existed) lines.push('（新建词条）')
      if (result.similar.length > 0) {
        lines.push('', '以下内容与已有事实过于相似，未写入：')
        for (const item of result.similar) lines.push(`  - ${item}`)
      }
      if (result.replaced.length > 0) {
        lines.push('', '同槽位的新值已替换旧值：')
        for (const item of result.replaced) lines.push(`  - 「${item.from}」 → 「${item.to}」`)
      }
      // 提醒要看词条实际的别名，而不是本次调用有没有传
      const savedEntry = store.readEntry(space, entryName)
      if (savedEntry && savedEntry.aliases.length === 0) {
        lines.push('', '提示：这个词条还没有同义词。补上 aliases 能显著提高检索命中率。')
      }
      return lines.join('\n')
    },
  })

  const journalWriteTool = defineTool({
    name: 'journal_write',
    description:
      '把某段时间发生的事记进日记。只在用户主动要求记录、或明确在回顾某段经历时使用；不要自动生成流水账。时间可以是精确到天（2026-10-29）、粗略到月（2026-10）、季节（2026-秋）或整年（2026）——用户说得模糊就按模糊的记，不要编造具体日期。日记全局一份，不分分区。',
    parameters: {
      when: {
        type: 'string',
        required: true,
        description: '时间，例如 2026-10-29、2026-10、2026-秋、2026。用户说「去年秋天」就换算成 2026-秋。',
      },
      text: {
        type: 'string',
        required: true,
        description: '日记正文，写清发生了什么。可以长。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const result = store.appendJournal(args.when, args.text)
      if (!result.ok) return `未写入：${result.error}`
      return [
        '已记入日记',
        `时间：${result.label}（对应区间 ${result.start} ~ ${result.end}）`,
        `文件：${result.file}`,
      ].join('\n')
    },
  })

  const journalReadTool = defineTool({
    name: 'journal_read',
    description:
      '按时间读取日记。当用户提到某个具体日期、某个月、某个季节或某一年发生的事时用它——例如「10 月 2 号我干嘛了」「去年秋天」。不指定 to 时，读的正好是 from 所代表的整段（一天/一月/一季/一年）。日记全局一份，不看分区。',
    parameters: {
      from: {
        type: 'string',
        required: true,
        description: '起点，例如 2026-10-29、2026-10、2026-秋、2026。',
      },
      to: {
        type: 'string',
        description: '可选的终点（不含），用于读一段范围，例如 from=2026-01 to=2027-01。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const start = normalizeWhen(args.from)
      if (!start.ok) return `读取失败：${start.error}`
      let end = start.end
      if (args.to) {
        const to = normalizeWhen(args.to)
        if (!to.ok) return `读取失败：${to.error}`
        end = to.end
      }

      const sections = store.readJournal(start.start, end)
      if (sections.length === 0) {
        return `日记里 ${start.start} ~ ${end} 没有记录。\n（日记只在用户要求记录时才有，没记过就是空的。）`
      }
      const lines = [`【日记】${start.start} ~ ${end}，共 ${sections.length} 段`, '']
      for (const section of sections) {
        lines.push(`## ${section.label}`, '', section.text || '（空）', '')
      }
      return lines.join('\n').trimEnd()
    },
  })

  const spacesTool = defineTool({
    name: 'memory_spaces',
    description:
      '列出所有记忆分区及其词条名。分区间默认互相隔离：日常对话只用「日常」，做某件长期的事时才用对应分区。当你需要知道某个分区里有什么时用它。',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
      const spaces = store.listSpaces()
      if (spaces.length === 0) return '还没有任何分区。'
      const lines = ['【记忆分区】', '']
      for (const space of spaces) {
        const mark = space.isDefault ? '（默认）' : ''
        lines.push(`· ${space.name}${mark}${space.description ? `：${space.description}` : ''}`)
        if (space.entries.length > 0) {
          lines.push(`  词条：${space.entries.join('、')}`)
        } else {
          lines.push('  词条：（还没有）')
        }
      }
      return lines.join('\n')
    },
  })

  const createSpaceTool = defineTool({
    name: 'memory_space_create',
    description:
      '新建一个记忆分区。必须先征得用户明确同意——分区是一件长期独立的事，不是随口一提的话题，也不是一个人、一个群。\n\n' +
      '【该建的信号，通常要中两条以上】\n' +
      '· 会持续多次会话，不是一次性任务\n' +
      '· 内容会积累、会变化，不是静态知识\n' +
      '· 能一句话说清它管什么、不管什么\n' +
      '· 用户主动说过「以后还要…」「长期…」\n\n' +
      '【不该建的信号，中一条就别建】\n' +
      '· 一次性的事（一次旅行、一次考试、一部作品的观后感）\n' +
      '· 一个现有分区里的一个词条就能装下\n' +
      '· 边界说不清（「杂事」「其他」「重要」这类名字）\n' +
      '· 按人、按群、按平台建——人一多就会炸，混在一起检索必然串味\n' +
      '· 只是这一阵子聊得多\n\n' +
      'description 必填：写清「管什么、不管什么」。含糊的描述会让日后每一次判断都靠猜。',
    parameters: {
      space: {
        type: 'string',
        required: true,
        description: '分区名，简短明确，例如「小说-归墟」「工作-甲项目」。名字要能独立看懂，别用「项目」这种离开上下文就不成立的词。',
      },
      description: {
        type: 'string',
        required: true,
        description: '写清这个分区管什么、不管什么。例如「工作-甲项目：需求、决策记录与进度；不管日常闲聊」。',
      },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description: '可选。这个分区的其他叫法，模型靠它判断该不该用这个分区。',
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const space = String(args.space ?? '').trim()
      if (!space) return '分区名不能为空。'
      if (store.hasSpace(space)) return `分区「${space}」已经存在。`
      const description = String(args.description ?? '').trim()
      if (!description) {
        return [
          `未创建：分区「${space}」缺少 description。`,
          '描述是日后判断「这条记忆该进哪个分区」的唯一依据，必须写清它管什么、不管什么。',
          '例如：「工作-甲项目：需求、决策记录与进度；不管日常闲聊。」',
        ].join('\n')
      }
      const result = store.createSpace(space, description, args.aliases)
      if (!result.created) return `未创建：${result.reason}`
      return [
        `已创建分区「${space}」。`,
        `说明：${description}`,
        `之后在这个分区里记录时，调用工具请带上 space: '${space}'。`,
      ].join('\n')
    },
  })

  return [recallTool, openTool, saveTool, journalWriteTool, journalReadTool, spacesTool, createSpaceTool]
}

export { DEFAULT_SPACE }
