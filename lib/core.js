/**
 * 记忆词典 · 核心存储层（v7：分区模型）
 *
 * 只依赖 Node 内置模块，可单独测试。
 *
 * 目录结构：
 *   <dir>/spaces/日常/分区.md         分区元信息
 *   <dir>/spaces/日常/基本记忆.md     该分区专属的常驻记忆
 *   <dir>/spaces/日常/词条/饮食.md    扁平词条，一个主题一个文件
 *
 * 设计取舍：不再有层级、不再有继承。一个主题一个词条，写透、不拆碎。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 默认分区。用户不特别说明时，一切都在这里。 */
export const DEFAULT_SPACE = '日常'

/** 基本记忆的保留文件名。 */
export const CORE_NAME = '基本记忆'

/** 基本记忆的常驻字数预算。 */
export const CORE_LIMIT = 400

/** 词条与分区的目录名。 */
const ENTRY_DIR = '词条'
const SPACE_META = '分区'

const ILLEGAL_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]/g

/** 把名字安全化成可用作文件名/目录名的形式。 */
export function safeSegment(segment) {
  return String(segment).trim().replace(ILLEGAL_SEGMENT, '_').replace(/^\.+/, '').replace(/[. ]+$/, '')
}

/** 取当前日期，YYYY-MM-DD。 */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------------------
// front matter
// ---------------------------------------------------------------------------

function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: text }
  const head = text.slice(3, end).trim()
  const body = text.slice(end + 4).replace(/^\s*\n/, '')
  const meta = {}
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const [, key, rawValue] = m
    let value = rawValue.trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    meta[key] = value
  }
  return { meta, body }
}

function buildFrontMatter(meta) {
  const lines = ['---']
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}: [${value.join(', ')}]`)
    } else {
      lines.push(`${key}: ${value}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 事实
// ---------------------------------------------------------------------------

/** `- [槽位] 正文 @since 2026-10 @until 2026-12` */
function parseFactLine(line) {
  let text = String(line).replace(/^\s*[-*]\s+/, '').trim()
  if (!text) return null

  let slot = null
  const slotMatch = /^\[([^\]]+)\]\s*/.exec(text)
  if (slotMatch) {
    slot = slotMatch[1].trim()
    text = text.slice(slotMatch[0].length).trim()
  }

  let since = null
  let until = null
  const sinceMatch = /\s*@since\s+(\S+)\s*$/.exec(text)
  if (sinceMatch) {
    since = sinceMatch[1]
    text = text.slice(0, sinceMatch.index).trim()
  }
  const untilMatch = /\s*@until\s+(\S+)\s*$/.exec(text)
  if (untilMatch) {
    until = untilMatch[1]
    text = text.slice(0, untilMatch.index).trim()
  }

  if (!text) return null
  return { slot, text, since, until, group: null }
}

function formatFact(fact) {
  const parts = []
  if (fact.slot) parts.push(`[${fact.slot}]`)
  parts.push(fact.text)
  let line = parts.join(' ')
  if (fact.since) line += ` @since ${fact.since}`
  if (fact.until) line += ` @until ${fact.until}`
  return line
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[\s，。、；：！？,.;:!?"'“”‘’()（）[\]【】—\-~·]/g, '')
}

/**
 * 中文按相邻两字切分，算 Jaccard 相似度。
 * 专治「两版几乎一样、只有个别字不同」——这种句子谁也不是谁的子串，
 * 包含判断抓不到，但换一版说法时重合度会高达 0.8 以上。
 */
function bigrams(text) {
  const t = normalizeText(text)
  const out = new Set()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  return out
}

/** 0~1 的相似度，完全相同为 1。 */
export function similarity(a, b) {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const A = bigrams(x)
  const B = bigrams(y)
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const gram of A) if (B.has(gram)) hit += 1
  return hit / (A.size + B.size - hit)
}

/**
 * 判断两条事实是否在说同一件事。规则刻意保守：
 * 1. 完全相同 → 是。
 * 2. 短句被长句完整包含、且长度比够高 → 是（「对花生过敏」⊂「他对花生过敏」）。
 * 3. 两句都够长（≥10 字）、相邻二字重合度 ≥0.78 → 是。
 *    门槛卡在 10 字，是因为「晚餐不能太油腻」和「午餐不能太油腻」只差一个字，
 *    短句靠 bigram 分不清——宁可漏，也不误伤。
 */
export function isNearDuplicate(a, b) {
  const x = normalizeText(a)
  const y = normalizeText(b)
  if (!x || !y) return false
  if (x === y) return true
  const shorter = x.length <= y.length ? x : y
  const longer = x.length <= y.length ? y : x
  if (shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.45) return true
  if (shorter.length >= 10 && similarity(a, b) >= 0.78) return true
  return false
}

// ---------------------------------------------------------------------------
// 时间归一化：任何说法都变成 [start, end) 区间
// ---------------------------------------------------------------------------

/** 中文四季对应的区间（月-日）。冬季跨年，单独处理。 */
const SEASON_START = { 春: '03-01', 夏: '06-01', 秋: '09-01', 冬: '12-01' }
const SEASON_END = { 春: '06-01', 夏: '09-01', 秋: '12-01', 冬: '03-01' }

const pad2 = (n) => String(n).padStart(2, '0')

/** ISO 日期加减天数。 */
function addDays(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + delta)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/**
 * 把各种时间说法归一化成区间。
 * 支持 2026-10-29 / 2026-10 / 2026-秋 / 2026 / 2026年10月29日 等写法。
 * @returns {{ok:true, year:number, label:string, start:string, end:string} | {ok:false, error:string}}
 */
export function normalizeWhen(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: '没有给出时间' }

  const normalized = raw
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/[／/]/g, '-')
    .replace(/\s+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  let m
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized))) {
    const year = Number(m[1])
    const start = `${year}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`
    return { ok: true, year, label: `${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`, start, end: addDays(start, 1) }
  }
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(normalized))) {
    const year = Number(m[1])
    const month = Number(m[2])
    if (month < 1 || month > 12) return { ok: false, error: `月份不合法：${m[2]}` }
    const start = `${year}-${pad2(month)}-01`
    const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`
    return { ok: true, year, label: `${month}月`, start, end }
  }
  if ((m = /^(\d{4})-(春|夏|秋|冬)$/.exec(normalized))) {
    const year = Number(m[1])
    const season = m[2]
    const start = `${year}-${SEASON_START[season]}`
    const end = season === '冬' ? `${year + 1}-${SEASON_END[season]}` : `${year}-${SEASON_END[season]}`
    return { ok: true, year, label: season, start, end }
  }
  if ((m = /^(\d{4})$/.exec(normalized))) {
    const year = Number(m[1])
    return { ok: true, year, label: '全年', start: `${year}-01-01`, end: `${year + 1}-01-01` }
  }
  return { ok: false, error: `看不懂的时间写法：${raw}（可用 2026-10-29、2026-10、2026-秋、2026）` }
}

/**
 * 解析日记文件里的 `## 标题` 对应的区间。
 * 标题形态：10-29（天）、10月（月）、秋（季）、全年（年）。
 */
export function sectionRange(label, year) {
  const text = String(label).trim()
  let m
  if ((m = /^(\d{2})-(\d{2})$/.exec(text))) {
    const start = `${year}-${m[1]}-${m[2]}`
    return { start, end: addDays(start, 1) }
  }
  if ((m = /^(\d{1,2})月$/.exec(text))) {
    const month = Number(m[1])
    if (month < 1 || month > 12) return null
    return {
      start: `${year}-${pad2(month)}-01`,
      end: month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`,
    }
  }
  if (SEASON_START[text]) {
    return {
      start: `${year}-${SEASON_START[text]}`,
      end: text === '冬' ? `${year + 1}-${SEASON_END[text]}` : `${year}-${SEASON_END[text]}`,
    }
  }
  if (text === '全年') return { start: `${year}-01-01`, end: `${year + 1}-01-01` }
  return null
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// 词条解析与序列化
// ---------------------------------------------------------------------------

/**
 * @returns {{meta: object, facts: object[], details: string}}
 */
export function parseEntryFile(text) {
  const { meta, body } = parseFrontMatter(text)
  const lines = String(body).split('\n')

  const facts = []
  const detailLines = []
  let section = 'facts'
  let group = null

  for (const line of lines) {
    const h2 = /^##(?!#)\s*(.+?)\s*$/.exec(line)
    if (h2) {
      const title = h2[1]
      if (/^事实/.test(title)) {
        section = 'facts'
        group = null
      } else if (/^(细节|正文)/.test(title)) {
        section = 'details'
      } else {
        section = 'details'
      }
      continue
    }
    const h3 = /^###\s*(.+?)\s*$/.exec(line)
    if (h3 && section === 'facts') {
      group = h3[1]
      continue
    }
    if (/^#\s+/.test(line)) continue // 一级标题只是装饰

    if (section === 'facts') {
      if (/^\s*[-*]\s+/.test(line)) {
        const fact = parseFactLine(line)
        if (fact) {
          fact.group = group
          facts.push(fact)
        }
      }
      continue
    }
    detailLines.push(line)
  }

  return { meta, facts, details: detailLines.join('\n').trim() }
}

export function serializeEntryFile({ meta, facts, details }) {
  const out = [buildFrontMatter(meta), '']
  out.push(`# ${meta.name ?? ''}`, '')
  out.push('## 事实', '')

  if (facts.length === 0) {
    out.push('-（暂无）')
  } else {
    let lastGroup = null
    for (const fact of facts) {
      const group = fact.group ?? null
      if (group !== lastGroup) {
        if (group) out.push('', `### ${group}`, '')
        else if (lastGroup) out.push('')
        lastGroup = group
      }
      out.push(`- ${formatFact(fact)}`)
    }
  }
  out.push('')

  if (details && details.trim()) {
    out.push('## 细节', '', details.trim(), '')
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export class MemoryStore {
  /**
   * @param {{dir: string, defaultSpace?: string, coreLimit?: number}} options
   */
  constructor(options) {
    this.dir = options.dir
    this.defaultSpace = options.defaultSpace || DEFAULT_SPACE
    this.coreLimit = options.coreLimit ?? CORE_LIMIT
    /** @type {Map<string, {mtimeMs: number, entry: object}>} */
    this.cache = new Map()
    this.usageCache = null
  }

  spacesRoot() {
    return path.join(this.dir, 'spaces')
  }

  spaceDir(space) {
    return path.join(this.spacesRoot(), safeSegment(space))
  }

  spaceMetaFile(space) {
    return path.join(this.spaceDir(space), `${SPACE_META}.md`)
  }

  entryDir(space) {
    return path.join(this.spaceDir(space), ENTRY_DIR)
  }

  entryFile(space, name) {
    return path.join(this.entryDir(space), `${safeSegment(name)}.md`)
  }

  coreFile(space) {
    return path.join(this.spaceDir(space), `${CORE_NAME}.md`)
  }

  /** 全局基本记忆：和分区同级，任何分区下都常驻。 */
  globalCoreFile() {
    return path.join(this.spacesRoot(), `${CORE_NAME}.md`)
  }

  usageFile() {
    return path.join(this.dir, '_usage.json')
  }

  /** 确保根目录与默认分区存在。 */
  ensure() {
    fs.mkdirSync(this.entryDir(this.defaultSpace), { recursive: true })
    if (!fs.existsSync(this.spaceMetaFile(this.defaultSpace))) {
      this.writeSpaceMeta(this.defaultSpace, { description: '关于用户本人与日常。' })
    }
  }

  writeSpaceMeta(space, meta) {
    fs.mkdirSync(this.spaceDir(space), { recursive: true })
    const data = { name: space, description: '', ...meta, created: meta.created ?? today() }
    const tmp = `${this.spaceMetaFile(space)}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${buildFrontMatter(data)}\n`, 'utf8')
    fs.renameSync(tmp, this.spaceMetaFile(space))
  }

  readSpaceMeta(space) {
    try {
      const { meta } = parseFrontMatter(fs.readFileSync(this.spaceMetaFile(space), 'utf8'))
      return meta
    } catch {
      return null
    }
  }

  /** 列出所有分区（含词条名）。 */
  listSpaces() {
    const root = this.spacesRoot()
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    const spaces = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const meta = this.readSpaceMeta(entry.name)
      if (!meta) continue
      spaces.push({
        name: entry.name,
        description: meta.description ?? '',
        aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
        entries: this.entryNames(entry.name),
        isDefault: entry.name === this.defaultSpace,
      })
    }
    spaces.sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name, 'zh')))
    return spaces
  }

  /** 只有分区名，不读词条目录——写入时查重要用它，越快越好。 */
  spaceNames() {
    try {
      return fs
        .readdirSync(this.spacesRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .filter((name) => this.hasSpace(name))
        .sort((a, b) => a.localeCompare(b, 'zh'))
    } catch {
      return []
    }
  }

  /** 某分区是否存在。 */
  hasSpace(space) {
    return fs.existsSync(this.spaceMetaFile(space))
  }

  /** 新建分区。调用方负责先征得用户同意。 */
  createSpace(space, description, aliases = []) {
    if (this.hasSpace(space)) return { created: false, reason: '已存在' }
    this.writeSpaceMeta(space, { description, aliases: Array.isArray(aliases) ? aliases : [] })
    fs.mkdirSync(this.entryDir(space), { recursive: true })
    return { created: true, name: space }
  }

  /** 分区里的词条名列表。 */
  entryNames(space) {
    try {
      return fs
        .readdirSync(this.entryDir(space), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name.slice(0, -3))
        .filter((name) => name !== CORE_NAME)
        .sort((a, b) => a.localeCompare(b, 'zh'))
    } catch {
      return []
    }
  }

  /** 读取单个词条。 */
  readEntry(space, name) {
    const file = this.entryFile(space, name)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      this.cache.delete(file)
      return null
    }
    const cached = this.cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.entry

    const parsed = parseEntryFile(fs.readFileSync(file, 'utf8'))
    const entry = {
      space,
      name,
      file,
      aliases: Array.isArray(parsed.meta.aliases) ? parsed.meta.aliases : [],
      related: Array.isArray(parsed.meta.related) ? parsed.meta.related : [],
      summary: parsed.meta.summary ?? '',
      facts: parsed.facts,
      details: parsed.details,
    }
    this.cache.set(file, { mtimeMs: stat.mtimeMs, entry })
    return entry
  }

  /** 某分区的全部词条。 */
  listEntries(space) {
    return this.entryNames(space)
      .map((name) => this.readEntry(space, name))
      .filter(Boolean)
  }

  /** 写入词条（整体替换，原子）。 */
  writeEntry(space, name, data) {
    const file = this.entryFile(space, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const meta = {
      name,
      aliases: data.aliases ?? [],
      summary: data.summary ?? '',
      related: data.related ?? [],
      updated: today(),
    }
    const text = serializeEntryFile({ meta, facts: data.facts, details: data.details })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    this.cache.delete(file)
    return file
  }

  /**
   * 往词条追加事实。
   * 同槽位覆盖（旧值进历史由调用方展示），近似重复拦下。
   */
  appendFacts(space, name, newFacts, extra = {}) {
    const existing = this.readEntry(space, name)
    const entry = existing
      ? { aliases: [...existing.aliases], related: [...existing.related], summary: existing.summary, facts: [...existing.facts], details: existing.details }
      : { aliases: [], related: [], summary: '', facts: [], details: '' }

    if (extra.summary) entry.summary = extra.summary
    if (Array.isArray(extra.aliases) && extra.aliases.length > 0) {
      entry.aliases = [...new Set([...entry.aliases, ...extra.aliases])]
    }
    if (Array.isArray(extra.related) && extra.related.length > 0) {
      entry.related = [...new Set([...entry.related, ...extra.related])]
    }
    if (extra.details) {
      entry.details = entry.details ? `${entry.details}\n\n${extra.details}` : extra.details
    }

    const keyOf = (f) => `${f.group ?? ''}\u0000${f.slot ?? ''}\u0000${f.text}`
    const seen = new Set(entry.facts.map(keyOf))
    const bySlot = new Map()
    for (const fact of entry.facts) {
      if (fact.slot) bySlot.set(fact.slot, fact)
    }

    let added = 0
    let skipped = 0
    const similar = []
    const replaced = []

    for (const raw of newFacts) {
      const fact = typeof raw === 'string' ? parseFactLine(`- ${raw}`) : { ...raw }
      if (!fact) continue
      if (fact.group === undefined) fact.group = null

      if (seen.has(keyOf(fact))) {
        skipped += 1
        continue
      }
      if (fact.slot && bySlot.has(fact.slot)) {
        const old = bySlot.get(fact.slot)
        entry.facts = entry.facts.filter((item) => item !== old)
        replaced.push({ from: old.text, to: fact.text })
        entry.facts.push(fact)
        bySlot.set(fact.slot, fact)
        seen.add(keyOf(fact))
        added += 1
        continue
      }
      const dup = entry.facts.find((item) => isNearDuplicate(item.text, fact.text))
      if (dup) {
        similar.push(`${fact.text}　≈　本词条已有「${dup.text}」`)
        skipped += 1
        continue
      }
      const inCore = this.findInCores(
        [
          { file: this.globalCoreFile(), label: '全局基本记忆' },
          { file: this.coreFile(space), label: `「${space}」的基本记忆` },
        ],
        fact.text,
        fact.slot,
      )
      if (inCore) {
        similar.push(`${fact.text}　已在${inCore.label}里常驻，不必再写进词条`)
        skipped += 1
        continue
      }
      entry.facts.push(fact)
      if (fact.slot) bySlot.set(fact.slot, fact)
      seen.add(keyOf(fact))
      added += 1
    }

    const file = this.writeEntry(space, name, entry)
    return { file, added, skipped, similar, replaced, space, entry: name }
  }

  // ---- 基本记忆 -----------------------------------------------------------

  readCore(space) {
    return this.readCoreFile(this.coreFile(space))
  }

  readGlobalCore() {
    return this.readCoreFile(this.globalCoreFile())
  }

  readCoreFile(file) {
    try {
      const parsed = parseEntryFile(fs.readFileSync(file, 'utf8'))
      return { facts: parsed.facts, details: parsed.details, meta: parsed.meta }
    } catch {
      return { facts: [], details: '', meta: {} }
    }
  }

  appendCore(space, newFacts) {
    return this.appendCoreFile(this.coreFile(space), newFacts)
  }

  appendGlobalCore(newFacts) {
    return this.appendCoreFile(this.globalCoreFile(), newFacts)
  }

  /**
   * 在给定的一批核心记忆文件里找这条事实。
   * 槽位相同时优先报槽位，否则报近似重复。
   * @returns {{file:string,label:string,text:string,kind:'slot'|'near'} | null}
   */
  findInCores(files, text, slot) {
    const key = normalizeText(text)
    for (const target of files) {
      const { facts } = this.readCoreFile(target.file)
      // 短句（如「对花生过敏」）过不了 isNearDuplicate 的长度门槛，先按原文比一次。
      const exact = facts.find((fact) => normalizeText(fact.text) === key)
      if (exact) return { ...target, text: exact.text, kind: 'near' }
      if (slot) {
        const same = facts.find((fact) => fact.slot === slot)
        if (same) return { ...target, text: same.text, slot, kind: 'slot' }
      }
      const twin = facts.find((fact) => isNearDuplicate(fact.text, text))
      if (twin) return { ...target, text: twin.text, kind: 'near' }
    }
    return null
  }

  /** 除 excludeFile 之外的所有核心记忆（全局 + 各分区）。 */
  otherCoreFiles(excludeFile) {
    const files = []
    const globalFile = this.globalCoreFile()
    if (globalFile !== excludeFile) {
      files.push({ file: globalFile, label: '全局基本记忆' })
    }
    for (const name of this.spaceNames()) {
      const file = this.coreFile(name)
      if (file === excludeFile) continue
      files.push({ file, label: `「${name}」的基本记忆` })
    }
    return files
  }

  appendCoreFile(file, newFacts) {
    const current = this.readCoreFile(file)
    const entry = { aliases: [], related: [], summary: '', facts: [...current.facts], details: current.details }
    const seen = new Set(entry.facts.map((f) => f.text))
    const bySlot = new Map()
    for (const fact of entry.facts) if (fact.slot) bySlot.set(fact.slot, fact)

    let added = 0
    let skipped = 0
    const similar = []
    const replaced = []
    const cross = []

    for (const raw of newFacts) {
      const fact = typeof raw === 'string' ? parseFactLine(`- ${raw}`) : { ...raw }
      if (!fact) continue
      if (seen.has(fact.text)) {
        skipped += 1
        continue
      }
      if (fact.slot && bySlot.has(fact.slot)) {
        const old = bySlot.get(fact.slot)
        entry.facts = entry.facts.filter((item) => item !== old)
        replaced.push({ from: old.text, to: fact.text })
        entry.facts.push(fact)
        bySlot.set(fact.slot, fact)
        seen.add(fact.text)
        added += 1
        continue
      }
      const dup = entry.facts.find((item) => isNearDuplicate(item.text, fact.text))
      if (dup) {
        similar.push(`${fact.text}　≈　本层已有「${dup.text}」`)
        skipped += 1
        continue
      }
      // 两级核心记忆都会常驻上下文，重复一次就是浪费一次。
      const twin = this.findInCores(this.otherCoreFiles(file), fact.text, fact.slot)
      if (twin) {
        const reason = twin.kind === 'slot' ? `同槽位 ${fact.slot}` : '近似重复'
        cross.push(`${fact.text}　已存在（${reason}）：${twin.label}「${twin.text}」`)
        skipped += 1
        continue
      }
      entry.facts.push(fact)
      if (fact.slot) bySlot.set(fact.slot, fact)
      seen.add(fact.text)
      added += 1
    }

    fs.mkdirSync(path.dirname(file), { recursive: true })
    const text = serializeEntryFile({
      meta: { name: CORE_NAME, updated: today() },
      facts: entry.facts,
      details: entry.details,
    })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)

    const chars = entry.facts.reduce((sum, fact) => sum + fact.text.length + 2, 0)
    return { added, skipped, similar, replaced, cross, file, chars, limit: this.coreLimit }
  }

  renderCore(space) {
    return this.renderCoreFile(this.coreFile(space), `基本记忆 · ${space}`)
  }

  renderGlobalCore() {
    return this.renderCoreFile(this.globalCoreFile(), '全局基本记忆')
  }

  renderCoreFile(file, label) {
    const { facts } = this.readCoreFile(file)
    if (facts.length === 0) return ''
    const lines = [`【${label}】`]
    let used = 0
    let dropped = 0
    for (const fact of facts) {
      const line = `· ${fact.text}`
      if (used + line.length > this.coreLimit) {
        dropped += 1
        continue
      }
      lines.push(line)
      used += line.length
    }
    if (dropped > 0) lines.push(`· （另有 ${dropped} 条超出预算，未常驻。）`)
    return lines.join('\n')
  }

  // ---- 日记 ---------------------------------------------------------------
  //
  // 全局一份，不属于任何分区——时间是条线，不分分区。
  // 放在 spaces 下，和分区目录、全局基本记忆并列。
  // 一年一个文件，日期是标题。精确到天用 `## 10-29`，模糊时间用 `## 秋` / `## 5月`。
  // 任何时间说法都归一化成 [start, end) 区间，检索就是区间重叠。

  journalDir() {
    return path.join(this.spacesRoot(), '日记')
  }

  journalFile(year) {
    return path.join(this.journalDir(), `${year}.md`)
  }

  readJournalYear(year) {
    let text
    try {
      text = fs.readFileSync(this.journalFile(year), 'utf8')
    } catch {
      return []
    }
    const sections = []
    const lines = text.split('\n')
    let current = null
    for (const line of lines) {
      const heading = /^##\s*(.+?)\s*$/.exec(line)
      if (heading) {
        const range = sectionRange(heading[1], year)
        current = range ? { label: heading[1], ...range, lines: [] } : null
        if (current) sections.push(current)
        continue
      }
      if (current) current.lines.push(line)
    }
    for (const section of sections) {
      section.text = section.lines.join('\n').trim()
      delete section.lines
    }
    return sections.sort((a, b) => a.start.localeCompare(b.start))
  }

  /** 读某段日期范围内的日记。 */
  readJournal(from, to) {
    const startYear = Number(from.slice(0, 4))
    const endYear = Number(to.slice(0, 4))
    const out = []
    for (let year = startYear; year <= endYear; year += 1) {
      for (const section of this.readJournalYear(year)) {
        if (section.end <= from || section.start >= to) continue
        out.push(section)
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start))
  }

  /** 往某一天/某个模糊时段追加一段日记。 */
  appendJournal(when, text) {
    const range = normalizeWhen(when)
    if (!range.ok) return { ok: false, error: range.error }

    const file = this.journalFile(range.year)
    fs.mkdirSync(this.journalDir(), { recursive: true })

    let existing = ''
    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch {
      existing = `---\nyear: ${range.year}\n---\n\n# ${range.year} 年日记\n`
    }

    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: '内容不能为空' }

    const lines = existing.split('\n')
    const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s*${escapeRegExp(range.label)}\\s*$`).test(line))

    if (headingIndex === -1) {
      lines.push('', `## ${range.label}`, '', body, '')
    } else {
      // 找到本节结束位置（下一个 ## 或文件末尾）
      let end = lines.length
      for (let i = headingIndex + 1; i < lines.length; i += 1) {
        if (/^##\s/.test(lines[i])) {
          end = i
          break
        }
      }
      const insertAt = end
      lines.splice(insertAt, 0, '', body, '')
    }

    const output = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, output, 'utf8')
    fs.renameSync(tmp, file)
    return { ok: true, file, label: range.label, start: range.start, end: range.end }
  }

  // ---- 检索 ---------------------------------------------------------------

  usage() {
    if (this.usageCache) return this.usageCache
    try {
      this.usageCache = JSON.parse(fs.readFileSync(this.usageFile(), 'utf8'))
    } catch {
      this.usageCache = {}
    }
    return this.usageCache
  }

  bumpUsage(key) {
    const usage = this.usage()
    usage[key] = (usage[key] ?? 0) + 1
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.usageFile(), JSON.stringify(usage), 'utf8')
    } catch {
      // 计数失败不能影响记忆本身
    }
    return usage[key]
  }

  /** 在一个分区内检索词条。 */
  search(space, query, limit = 3) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const normalized = q.toLowerCase()
    const terms = new Set([normalized])
    if (normalized.length >= 2) {
      for (let i = 0; i < normalized.length - 1; i += 1) {
        const bigram = normalized.slice(i, i + 2)
        if (/[\u4e00-\u9fa5a-z0-9]/.test(bigram)) terms.add(bigram)
      }
    }
    for (const char of normalized) {
      if (/[\u4e00-\u9fa5]/.test(char)) terms.add(char)
    }

    const usage = this.usage()
    const results = []

    for (const entry of this.listEntries(space)) {
      const name = entry.name.toLowerCase()
      const aliases = entry.aliases.map((a) => String(a).toLowerCase())
      const summary = String(entry.summary).toLowerCase()
      const factTexts = entry.facts.map((f) => f.text.toLowerCase())
      let score = 0

      for (const term of terms) {
        const weight = term === normalized ? 1 : term.length === 1 ? 0.12 : 0.32
        if (name === term) score += 110 * weight
        else if (name.includes(term)) score += 60 * weight
        if (aliases.some((a) => a === term)) score += 95 * weight
        else if (aliases.some((a) => a.includes(term))) score += 50 * weight
        if (summary.includes(term)) score += 30 * weight
        for (const text of factTexts) {
          if (text.includes(term)) {
            score += 12 * weight
            break
          }
        }
      }

      if (score > 0) {
        score += Math.min(entry.facts.length, 20) * 0.2
        score += Math.min(usage[`${space}/${entry.name}`] ?? 0, 10) * 1.5
        results.push({ space, entry, score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /** 跨分区兜底检索：只在当前分区没结果时使用。 */
  searchAll(query, limit = 3, excludeSpace = null) {
    const hits = []
    for (const space of this.listSpaces()) {
      if (space.name === excludeSpace) continue
      for (const hit of this.search(space.name, query, limit)) hits.push(hit)
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  /** 常驻的分区列表。 */
  renderSpaceList() {
    const spaces = this.listSpaces()
    const lines = ['【记忆分区】']
    for (const space of spaces) {
      const mark = space.isDefault ? '（默认）' : ''
      const desc = space.description ? `：${space.description}` : ''
      lines.push(`· ${space.name}${mark}${desc}`)
    }
    lines.push('默认只在当前分区检索；用户明确说在做别的事时，用对应分区。')
    lines.push('问「某天/某段时间发生了什么」时用 journal_read——日记全局一份，不受分区限制。')
    lines.push(
      '想开新分区，先自问三条：① 会持续多次会话吗？② 内容会积累、会变化吗？③ 能一句话说清它管什么、不管什么吗？',
    )
    lines.push('三条都成立，再问用户要不要建；中一条不成立，就写成现有分区里的一个词条。')
    lines.push('不要按人、按群、按平台开分区——人一多就会炸，而且混在一起检索必然串味。')
    return lines.join('\n')
  }
}
