/**
 * 一次性迁移：v5 → v6
 *
 * 1. 把「生活/饮食」这一支提到顶层「饮食」，给高频主题腾出层级。
 * 2. 清理存量数据里的近似重复事实（同一件事记了多遍）。
 *
 * 默认只预览，加 --apply 才真正写入。写入前自动整目录备份。
 *
 *   node tools/migrate-v6.mjs            # 预览
 *   node tools/migrate-v6.mjs --apply    # 执行
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isNearDuplicate, parseNodeFile, serializeNodeFile } from '../lib/core.js'

const apply = process.argv.includes('--apply')
const dir = process.env.MEMORY_DIR || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory')

/** 需要搬家的节点：[源相对路径, 目标相对路径] */
const MOVES = [
  ['生活/饮食/午餐.md', '饮食/午餐.md'],
  ['生活/饮食/晚餐.md', '饮食/晚餐.md'],
  ['生活/饮食.md', '饮食.md'],
]

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function listNodeFiles(root, base = root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
    const abs = path.join(root, entry.name)
    if (entry.isDirectory()) listNodeFiles(abs, base, out)
    else if (entry.name.endsWith('.md')) out.push(path.relative(base, abs).replace(/\\/g, '/'))
  }
  return out
}

function rewriteMeta(text, newPath) {
  const parsed = parseNodeFile(text)
  const segments = newPath.replace(/\.md$/, '').split('/')
  const meta = { ...parsed.meta, path: segments.join('/'), title: segments[segments.length - 1] }
  return serializeNodeFile({ meta, overview: parsed.overview, facts: parsed.facts, history: parsed.history })
}

function dedupeFacts(facts) {
  const kept = []
  const dropped = []
  for (const fact of facts) {
    const duplicate = kept.find((existing) => isNearDuplicate(existing.text, fact.text))
    if (!duplicate) {
      kept.push(fact)
      continue
    }
    // 有槽位的优先保留，因为它是「可被覆盖」的那一条
    if (fact.slot && !duplicate.slot) {
      const index = kept.indexOf(duplicate)
      kept[index] = fact
      dropped.push({ kept: fact, dropped: duplicate })
    } else {
      dropped.push({ kept: duplicate, dropped: fact })
    }
  }
  return { kept, dropped }
}

if (!fs.existsSync(dir)) {
  console.log(`记忆目录不存在：${dir}`)
  process.exit(0)
}

console.log(`记忆目录：${dir}`)
console.log(apply ? '模式：执行' : '模式：预览（加 --apply 执行）')
console.log('')

// ---------- 1. 搬家 ----------
const movePlan = []
for (const [from, to] of MOVES) {
  const src = path.join(dir, ...from.split('/'))
  const dst = path.join(dir, ...to.split('/'))
  if (fs.existsSync(src)) movePlan.push({ from, to, src, dst })
}

if (movePlan.length === 0) {
  console.log('没有需要搬家的节点。')
} else {
  console.log('搬家计划：')
  for (const item of movePlan) console.log(`  ${item.from}  →  ${item.to}`)
}

// ---------- 2. 去重 ----------
const dupPlan = []
for (const rel of listNodeFiles(dir)) {
  const parsed = parseNodeFile(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'))
  if (parsed.facts.length < 2) continue
  const { kept, dropped } = dedupeFacts(parsed.facts)
  if (dropped.length > 0) dupPlan.push({ rel, kept, dropped, parsed })
}

if (dupPlan.length === 0) {
  console.log('\n没有需要清理的重复事实。')
} else {
  console.log('\n重复事实清理：')
  for (const item of dupPlan) {
    console.log(`  ${item.rel}`)
    for (const entry of item.dropped) {
      console.log(`    删：${entry.dropped.text}`)
      console.log(`    留：${entry.kept.text}`)
    }
  }
}

if (!apply) {
  console.log('\n以上为预览。确认无误后执行：node tools/migrate-v6.mjs --apply')
  process.exit(0)
}

// ---------- 执行 ----------
const backup = `${dir}-backup-${stamp()}`
fs.cpSync(dir, backup, { recursive: true })
console.log(`\n已备份到：${backup}`)

for (const item of movePlan) {
  fs.mkdirSync(path.dirname(item.dst), { recursive: true })
  if (path.resolve(item.src) === path.resolve(item.dst)) continue
  fs.renameSync(item.src, item.dst)
  console.log(`移动 ${item.from} → ${item.to}`)
}

// 搬完再改元数据：路径变化了，front matter 里的 path/title 要跟着变
for (const item of movePlan) {
  if (!fs.existsSync(item.dst)) continue
  const text = fs.readFileSync(item.dst, 'utf8')
  fs.writeFileSync(item.dst, rewriteMeta(text, item.to), 'utf8')
  console.log(`更新元数据 ${item.to}`)
}

// 清理空目录
function pruneEmpty(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const abs = path.join(current, entry.name)
    pruneEmpty(abs)
    if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
  }
}
pruneEmpty(dir)

for (const item of dupPlan) {
  const target = item.rel === '生活/饮食.md' ? '饮食.md' : item.rel
  const abs = path.join(dir, ...target.split('/'))
  if (!fs.existsSync(abs)) continue
  const parsed = parseNodeFile(fs.readFileSync(abs, 'utf8'))
  const { kept } = dedupeFacts(parsed.facts)
  fs.writeFileSync(
    abs,
    serializeNodeFile({ meta: parsed.meta, overview: parsed.overview, facts: kept, history: parsed.history }),
    'utf8'
  )
  console.log(`去重 ${target}：${parsed.facts.length} → ${kept.length} 条`)
}

console.log('\n完成。')
