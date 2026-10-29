/**
 * 一次性迁移：v6 → v7（分区模型）
 *
 * v6：memory/饮食.md + memory/饮食/晚餐.md + memory/基本记忆.md
 * v7：memory/spaces/日常/词条/饮食.md + memory/spaces/日常/基本记忆.md
 *
 * 规则：
 *   - 根目录的 xxx.md          → 词条 xxx
 *   - 目录 xxx/ 下的 yyy.md    → 并入词条 xxx，事实归入分节 yyy
 *   - 基本记忆.md              → 搬进默认分区
 *   - 目录层级彻底消失，一个主题一个词条
 *
 * 默认只预览，加 --apply 才写入。写入前整目录备份。
 *
 *   node tools/migrate-v7.mjs
 *   node tools/migrate-v7.mjs --apply
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SPACE, parseEntryFile, serializeEntryFile } from '../lib/core.js'

const apply = process.argv.includes('--apply')
const dir = process.env.MEMORY_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory')
const CORE_NAME = '基本记忆'

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function listMarkdown(root) {
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const abs = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...listMarkdown(abs))
    else if (entry.name.endsWith('.md')) out.push(abs)
  }
  return out
}

function deriveSummary(parsed, fallback) {
  if (parsed.meta.summary) return parsed.meta.summary
  if (parsed.overview && parsed.overview.trim()) {
    const first = parsed.overview.trim().split(/\n/)[0]
    return first.length > 80 ? `${first.slice(0, 80)}…` : first
  }
  if (parsed.facts.length > 0) return parsed.facts[0].text
  return fallback
}

if (!fs.existsSync(dir)) {
  console.log(`记忆目录不存在：${dir}`)
  process.exit(0)
}

if (fs.existsSync(path.join(dir, 'spaces'))) {
  console.log('看起来已经是 v7 结构（存在 spaces/ 目录），无需迁移。')
  process.exit(0)
}

const rootFiles = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.md'))
  .map((e) => e.name)
const rootDirs = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
  .map((e) => e.name)

/** @type {Map<string, {facts: object[], aliases: string[], summary: string, details: string}>} */
const entries = new Map()

function ensureEntry(name) {
  if (!entries.has(name)) entries.set(name, { facts: [], aliases: [], summary: '', details: '' })
  return entries.get(name)
}

// 根目录文件：基本记忆单独处理，其余都是词条
for (const file of rootFiles) {
  const name = file.slice(0, -3)
  const parsed = parseEntryFile(fs.readFileSync(path.join(dir, file), 'utf8'))
  if (name === CORE_NAME) continue
  const target = ensureEntry(name)
  target.aliases = Array.isArray(parsed.meta.aliases) ? parsed.meta.aliases : []
  target.summary = deriveSummary(parsed, name)
  target.details = parsed.details || ''
  for (const fact of parsed.facts) target.facts.push({ ...fact, group: null })
}

// 目录：目录名是词条名，子文件的事实归入对应分节
for (const dirName of rootDirs) {
  const files = listMarkdown(path.join(dir, dirName))
  const hasOwnFile = rootFiles.includes(`${dirName}.md`)

  // 只有一个子文件、且自己没有同名根文件的目录，其实是「分类」而非「主题」：
  // 兴趣/动漫.md 应该变成词条「动漫」，而不是词条「兴趣」。
  if (!hasOwnFile && files.length === 1) {
    const leaf = files[0].slice(0, -3)
    const leafName = path.basename(leaf)
    const parsed = parseEntryFile(fs.readFileSync(files[0], 'utf8'))
    const target = ensureEntry(leafName)
    target.aliases = [...new Set([...(Array.isArray(parsed.meta.aliases) ? parsed.meta.aliases : []), dirName])]
    target.summary = deriveSummary(parsed, leafName)
    target.details = parsed.details || ''
    for (const fact of parsed.facts) target.facts.push({ ...fact, group: null })
    continue
  }

  const target = ensureEntry(dirName)
  const groups = []
  for (const abs of files) {
    const rel = path.relative(path.join(dir, dirName), abs).replace(/\\/g, '/').replace(/\.md$/, '')
    const group = rel.split('/').join(' / ')
    groups.push(group)
    const parsed = parseEntryFile(fs.readFileSync(abs, 'utf8'))
    for (const fact of parsed.facts) target.facts.push({ ...fact, group })
    if (!target.summary) target.summary = deriveSummary(parsed, dirName)
    if (parsed.details) target.details = target.details ? `${target.details}\n\n${parsed.details}` : parsed.details
  }
  target.aliases = [...new Set([dirName, ...groups, ...target.aliases])]
}

// 基本记忆
const corePath = path.join(dir, `${CORE_NAME}.md`)
const coreFacts = fs.existsSync(corePath) ? parseEntryFile(fs.readFileSync(corePath, 'utf8')).facts : []

// ---------- 预览 ----------
console.log(`记忆目录：${dir}`)
console.log(apply ? '模式：执行' : '模式：预览（加 --apply 执行）')
console.log('')
console.log(`默认分区「${DEFAULT_SPACE}」下将建立：`)
for (const [name, entry] of entries) {
  console.log(`  词条 ${name}　${entry.facts.length} 条事实，别名 ${entry.aliases.length} 个`)
  console.log(`    摘要：${entry.summary}`)
}
console.log(`  基本记忆　${coreFacts.length} 条`)

if (!apply) {
  console.log('\n以上为预览。确认无误后执行：node tools/migrate-v7.mjs --apply')
  process.exit(0)
}

// ---------- 执行 ----------
const backup = `${dir}-backup-${stamp()}`
fs.cpSync(dir, backup, { recursive: true })
console.log(`\n已备份到：${backup}`)

const spaceDir = path.join(dir, 'spaces', DEFAULT_SPACE)
fs.mkdirSync(path.join(spaceDir, '词条'), { recursive: true })

fs.writeFileSync(
  path.join(spaceDir, '分区.md'),
  ['---', `name: ${DEFAULT_SPACE}`, 'description: 关于用户本人与日常。', `created: ${new Date().toISOString().slice(0, 10)}`, '---', ''].join('\n'),
  'utf8'
)

for (const [name, entry] of entries) {
  const text = serializeEntryFile({
    meta: { name, aliases: entry.aliases, summary: entry.summary, related: [], updated: new Date().toISOString().slice(0, 10) },
    facts: entry.facts,
    details: entry.details,
  })
  fs.writeFileSync(path.join(spaceDir, '词条', `${name}.md`), text, 'utf8')
  console.log(`写入词条 ${name}`)
}

if (coreFacts.length > 0) {
  const text = serializeEntryFile({
    meta: { name: CORE_NAME, updated: new Date().toISOString().slice(0, 10) },
    facts: coreFacts,
    details: '',
  })
  fs.writeFileSync(path.join(spaceDir, `${CORE_NAME}.md`), text, 'utf8')
  console.log(`写入基本记忆 ${coreFacts.length} 条`)
}

// 清理旧结构（备份里还有）
for (const file of rootFiles) fs.rmSync(path.join(dir, file), { force: true })
for (const dirName of rootDirs) fs.rmSync(path.join(dir, dirName), { recursive: true, force: true })
fs.rmSync(path.join(dir, '_usage.json'), { force: true })

console.log('\n完成。')
