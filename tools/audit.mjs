/**
 * 记忆体检：扫描已有数据，找出写入时的查重没拦住、或者手工改出来的问题。
 *   node tools/audit.mjs
 *   node tools/audit.mjs --cross   连跨词条重复也一起查（噪音更多）
 */

import os from 'node:os'
import path from 'node:path'
import { MemoryStore, isNearDuplicate } from '../lib/core.js'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const dir = process.env.MEMORY_DIR ?? path.join(home, 'memory')
const crossEntries = process.argv.includes('--cross')
const store = new MemoryStore({ dir })

const issues = []
const add = (kind, where, detail) => issues.push({ kind, where, detail })

const coreFacts = []
coreFacts.push({ label: '全局基本记忆', facts: store.readGlobalCore().facts })
for (const space of store.listSpaces()) {
  coreFacts.push({ label: `「${space.name}」的基本记忆`, facts: store.readCore(space.name).facts })
}

// 1. 词条内部：两条事实在说同一件事
for (const space of store.listSpaces()) {
  for (const name of space.entries) {
    const entry = store.readEntry(space.name, name)
    if (!entry) continue
    const facts = entry.facts
    for (let i = 0; i < facts.length; i += 1) {
      for (let j = i + 1; j < facts.length; j += 1) {
        if (isNearDuplicate(facts[i].text, facts[j].text)) {
          add('词条内重复', `${space.name} › ${name}`, `「${facts[i].text}」\n      ≈「${facts[j].text}」`)
        }
      }
    }
    if (!entry.summary) add('缺摘要', `${space.name} › ${name}`, '检索排序会很吃亏')
    if (entry.aliases.length === 0) add('缺别名', `${space.name} › ${name}`, '换个说法就搜不到')
  }
}

// 2. 词条事实 vs 基本记忆（常驻内容不该在词条里再来一遍）
for (const space of store.listSpaces()) {
  for (const target of coreFacts) {
    if (target.label.startsWith('「') && !target.label.includes(space.name)) continue
    for (const fact of target.facts) {
      for (const name of space.entries) {
        const entry = store.readEntry(space.name, name)
        if (!entry) continue
        const twin = entry.facts.find((item) => isNearDuplicate(item.text, fact.text))
        if (twin) {
          add('词条与基本记忆重复', `${space.name} › ${name}`, `「${twin.text}」\n      ≈ ${target.label}「${fact.text}」`)
        }
      }
    }
  }
}

// 3. 基本记忆之间（全局 vs 各分区）
for (let i = 0; i < coreFacts.length; i += 1) {
  for (let j = i + 1; j < coreFacts.length; j += 1) {
    for (const a of coreFacts[i].facts) {
      for (const b of coreFacts[j].facts) {
        if (isNearDuplicate(a.text, b.text)) {
          add('基本记忆重复', `${coreFacts[i].label} × ${coreFacts[j].label}`, `「${a.text}」\n      ≈「${b.text}」`)
        }
      }
    }
  }
}

// 4. 同一分区不同词条之间的重复
if (crossEntries) {
  for (const space of store.listSpaces()) {
    const entries = space.entries.map((name) => store.readEntry(space.name, name)).filter(Boolean)
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        for (const a of entries[i].facts) {
          for (const b of entries[j].facts) {
            if (isNearDuplicate(a.text, b.text)) {
              add('跨词条重复', `${space.name} › ${entries[i].name} × ${entries[j].name}`, `「${a.text}」\n      ≈「${b.text}」`)
            }
          }
        }
      }
    }
  }
}

// 5. 基本记忆超额
for (const target of coreFacts) {
  const chars = target.facts.reduce((sum, fact) => sum + fact.text.length + 2, 0)
  if (chars > store.coreLimit) add('基本记忆超额', target.label, `${chars} / ${store.coreLimit} 字`)
}

// 输出
const byKind = new Map()
for (const issue of issues) {
  if (!byKind.has(issue.kind)) byKind.set(issue.kind, [])
  byKind.get(issue.kind).push(issue)
}

console.log(`记忆体检：${dir}`)
console.log(`分区 ${store.listSpaces().length} 个，问题 ${issues.length} 处\n`)

for (const [kind, list] of byKind) {
  console.log(`【${kind}】${list.length} 处`)
  for (const issue of list) {
    console.log(`  · ${issue.where}`)
    console.log(`      ${issue.detail}`)
  }
  console.log('')
}

if (issues.length === 0) console.log('没有发现问题。')
