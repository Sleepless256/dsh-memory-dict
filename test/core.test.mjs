/**
 * 核心层自测（v7 分区模型）：不依赖 DSH，直接用 node 跑。
 *   node test/core.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SPACE, MemoryStore, isNearDuplicate, normalizeWhen, parseEntryFile, serializeEntryFile } from '../lib/core.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memdict-'))
  const store = new MemoryStore({ dir })
  store.ensure()
  return { store, dir }
}

console.log('解析与序列化')
test('解析摘要、别名、分节事实与细节', () => {
  const text = `---
name: 饮食
aliases: [吃饭, 口味]
summary: 点餐口味偏好
---

# 饮食

## 事实

### 通用
- [辣度] 微辣或不辣
- 多加葱花

### 晚餐
- 不要太油腻

## 细节

火锅只吃清汤。
`
  const entry = parseEntryFile(text)
  assert.equal(entry.meta.summary, '点餐口味偏好')
  assert.deepEqual(entry.meta.aliases, ['吃饭', '口味'])
  assert.equal(entry.facts.length, 3)
  assert.equal(entry.facts[0].slot, '辣度')
  assert.equal(entry.facts[0].group, '通用')
  assert.equal(entry.facts[2].group, '晚餐')
  assert.match(entry.details, /火锅/)
})

test('序列化后可再次解析', () => {
  const source = {
    meta: { name: '饮食', aliases: ['吃饭'], summary: '摘要' },
    facts: [
      { slot: '辣度', text: '微辣', since: null, until: null, group: '通用' },
      { slot: null, text: '多葱', since: null, until: null, group: '通用' },
      { slot: null, text: '晚上清淡', since: null, until: null, group: '晚餐' },
    ],
    details: '细节文字。',
  }
  const round = parseEntryFile(serializeEntryFile(source))
  assert.equal(round.meta.summary, '摘要')
  assert.equal(round.facts.length, 3)
  assert.equal(round.facts[2].group, '晚餐')
  assert.equal(round.details, '细节文字。')
})

console.log('近似重复')
test('包含关系且比例够高才算重复', () => {
  assert.equal(isNearDuplicate('对花生过敏', '对花生过敏'), true)
  assert.equal(isNearDuplicate('晚餐要控制盐分', '晚餐要控制盐分摄入'), true)
  assert.equal(isNearDuplicate('不要辣', '可以微辣'), false, '相反的意思不能被当成重复')
})

test('两版几乎一样、只差几个字也能认出来', () => {
  const a =
    '这家店的招牌是红烧肉（选五花三层）、糖醋小排（酸甜口）、清炒时蔬，人均八十左右，适合四个人吃，周末要排队。'
  const b =
    '这家店的招牌是红烧肉（选五花三层）、糖醋小排（酸甜口）、清炒时蔬，人均八十上下，适合三四个人吃，周末要排队。'
  assert.equal(isNearDuplicate(a, b), true)

  const c =
    '第一步备料（切块焯水）、第二步炒糖色（小火慢熬）、第三步炖煮（四十分钟）、第四步收汁（大火翻炒），最后撒葱花。'
  const d =
    '第一步备料（切块焯水）、第二步炒糖色（小火慢熬）、第三步炖煮（四十分钟）、第四步收汁（大火翻炒），最后撒一把葱花。'
  assert.equal(isNearDuplicate(c, d), true)
})

test('短句只差一个字不算重复', () => {
  assert.equal(isNearDuplicate('晚餐不能太油腻', '午餐不能太油腻'), false)
  assert.equal(isNearDuplicate('午饭买饮料', '晚饭买饮料'), false)
})

test('说相关但不同的事不算重复', () => {
  assert.equal(
    isNearDuplicate('沈砚是这本书的主角，穿越者', '周晚是沈砚唯一的同门，是沈砚的师姐'),
    false,
  )
})

console.log('分区')
test('ensure 建出默认分区', () => {
  const { store } = freshStore()
  const spaces = store.listSpaces()
  assert.equal(spaces.length, 1)
  assert.equal(spaces[0].name, DEFAULT_SPACE)
  assert.equal(spaces[0].isDefault, true)
})

test('新建分区并列出词条', () => {
  const { store } = freshStore()
  const result = store.createSpace('小说-归墟', '一部长篇的设定')
  assert.equal(result.created, true)
  store.appendFacts('小说-归墟', '主角', ['主角叫沈砚'], { summary: '主角设定' })

  const spaces = store.listSpaces()
  const novel = spaces.find((s) => s.name === '小说-归墟')
  assert.ok(novel)
  assert.deepEqual(novel.entries, ['主角'])
  assert.equal(novel.isDefault, false)
})

console.log('词条写入')
test('写入事实并分节', () => {
  const { store, dir } = freshStore()
  store.appendFacts(
    DEFAULT_SPACE,
    '饮食',
    [
      { text: '微辣或不辣', slot: '辣度', group: '通用', since: null, until: null },
      { text: '不要太油腻', slot: null, group: '晚餐', since: null, until: null },
    ],
    { summary: '点餐口味', aliases: ['吃饭'] }
  )
  const entry = store.readEntry(DEFAULT_SPACE, '饮食')
  assert.equal(entry.facts.length, 2)
  assert.equal(entry.summary, '点餐口味')
  assert.deepEqual(entry.aliases, ['吃饭'])

  const raw = fs.readFileSync(path.join(dir, 'spaces', DEFAULT_SPACE, '词条', '饮食.md'), 'utf8')
  assert.match(raw, /### 晚餐/)
})

test('同槽位覆盖', () => {
  const { store } = freshStore()
  store.appendFacts(DEFAULT_SPACE, '饮食', ['[辣度] 微辣'], { summary: 'x' })
  const result = store.appendFacts(DEFAULT_SPACE, '饮食', ['[辣度] 中辣'])
  assert.equal(result.replaced.length, 1)
  const entry = store.readEntry(DEFAULT_SPACE, '饮食')
  assert.equal(entry.facts.length, 1)
  assert.equal(entry.facts[0].text, '中辣')
})

test('近似重复被拦下', () => {
  const { store } = freshStore()
  store.appendFacts(DEFAULT_SPACE, '饮食', ['晚餐要控制盐分'], { summary: 'x' })
  const result = store.appendFacts(DEFAULT_SPACE, '饮食', ['晚餐要控制盐分摄入'])
  assert.equal(result.added, 0)
  assert.equal(result.similar.length, 1)
})

console.log('检索')
test('分区内按词条名检索', () => {
  const { store } = freshStore()
  store.appendFacts(DEFAULT_SPACE, '饮食', ['微辣'], { summary: '点餐口味', aliases: ['吃饭'] })
  const hits = store.search(DEFAULT_SPACE, '饮食')
  assert.equal(hits[0].entry.name, '饮食')
})

test('分区内按别名检索', () => {
  const { store } = freshStore()
  store.appendFacts(DEFAULT_SPACE, '饮食', ['微辣'], { summary: '点餐口味', aliases: ['吃饭', '口味'] })
  const hits = store.search(DEFAULT_SPACE, '口味')
  assert.equal(hits[0].entry.name, '饮食')
})

test('分区之间默认互不可见', () => {
  const { store } = freshStore()
  store.createSpace('小说-归墟', '小说')
  store.appendFacts('小说-归墟', '主角', ['沈砚'], { summary: '主角' })
  store.appendFacts(DEFAULT_SPACE, '饮食', ['微辣'], { summary: '口味' })

  assert.equal(store.search(DEFAULT_SPACE, '主角').length, 0)
  assert.equal(store.search('小说-归墟', '饮食').length, 0)
})

test('跨区兜底能找回其他分区', () => {
  const { store } = freshStore()
  store.createSpace('小说-归墟', '小说')
  store.appendFacts('小说-归墟', '主角', ['主角叫沈砚'], { summary: '主角设定' })
  const fallback = store.searchAll('主角', 3, DEFAULT_SPACE)
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].space, '小说-归墟')
})

console.log('基本记忆')
test('写入、去重与渲染', () => {
  const { store } = freshStore()
  const first = store.appendCore(DEFAULT_SPACE, ['对花生过敏', '称呼用「念念」'])
  assert.equal(first.added, 2)
  const again = store.appendCore(DEFAULT_SPACE, ['对花生过敏'])
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 1)

  const text = store.renderCore(DEFAULT_SPACE)
  assert.match(text, /对花生过敏/)
  assert.match(text, /念念/)
})

test('基本记忆支持同槽位改写', () => {
  const { store } = freshStore()
  store.appendCore(DEFAULT_SPACE, ['[昵称] 叫我小晴'])
  const result = store.appendCore(DEFAULT_SPACE, ['[昵称] 叫我念念'])
  assert.equal(result.replaced.length, 1)
  const text = store.renderCore(DEFAULT_SPACE)
  assert.match(text, /念念/)
  assert.ok(!text.includes('小晴'))
})

test('基本记忆不进检索', () => {
  const { store } = freshStore()
  store.appendCore(DEFAULT_SPACE, ['对花生过敏'])
  assert.equal(store.search(DEFAULT_SPACE, '花生').length, 0)
})

test('全局基本记忆放在 spaces 下，与分区同级', () => {
  const { store, dir } = freshStore()
  store.appendGlobalCore(['对花生过敏'])
  assert.ok(fs.existsSync(path.join(dir, 'spaces', '基本记忆.md')))
})

test('全局与分区基本记忆互不混入', () => {
  const { store } = freshStore()
  store.appendGlobalCore(['对花生过敏'])
  store.appendCore(DEFAULT_SPACE, ['早餐不吃甜的'])

  const global = store.renderGlobalCore()
  const space = store.renderCore(DEFAULT_SPACE)
  assert.match(global, /花生过敏/)
  assert.ok(!global.includes('早餐不吃甜的'))
  assert.match(space, /早餐不吃甜的/)
  assert.ok(!space.includes('花生过敏'))
})

test('全局已有的事实不会重复写进分区', () => {
  const { store } = freshStore()
  store.appendGlobalCore(['对花生过敏'])
  const result = store.appendCore(DEFAULT_SPACE, ['对花生过敏'])
  assert.equal(result.added, 0)
  assert.equal(result.cross.length, 1)
  assert.match(result.cross[0], /全局基本记忆/)
})

test('分区已有的事实不会重复写进全局', () => {
  const { store } = freshStore()
  store.appendCore(DEFAULT_SPACE, ['对花生过敏'])
  const result = store.appendGlobalCore(['对花生过敏'])
  assert.equal(result.added, 0)
  assert.equal(result.cross.length, 1)
  assert.match(result.cross[0], /日常/)
})

test('跨层同槽位会被拦下并说明是槽位冲突', () => {
  const { store } = freshStore()
  store.appendGlobalCore(['[昵称] 叫我念念'])
  const result = store.appendCore(DEFAULT_SPACE, ['[昵称] 叫我小晴'])
  assert.equal(result.added, 0)
  assert.equal(result.cross.length, 1)
  assert.match(result.cross[0], /同槽位 昵称/)
})

test('不相干的事实能正常写进另一层', () => {
  const { store } = freshStore()
  store.appendGlobalCore(['对花生过敏'])
  const result = store.appendCore(DEFAULT_SPACE, ['早餐不吃甜的'])
  assert.equal(result.added, 1)
  assert.equal(result.cross.length, 0)
})

test('词条里不再重复写基本记忆已有的事实', () => {
  const { store } = freshStore()
  store.appendGlobalCore(['对花生过敏'])
  const result = store.appendFacts(DEFAULT_SPACE, '饮食', ['对花生过敏'], { summary: '平时吃什么' })
  assert.equal(result.added, 0)
  assert.equal(result.similar.length, 1)
  assert.match(result.similar[0], /全局基本记忆/)
})

test('超出预算时明确报告未常驻条数', () => {
  const { store } = freshStore()
  for (let i = 0; i < 40; i += 1) store.appendCore(DEFAULT_SPACE, [`第 ${i} 条测试记忆内容`])
  const text = store.renderCore(DEFAULT_SPACE)
  assert.match(text, /超出预算/)
})

console.log('时间归一化')
test('精确到天', () => {
  const r = normalizeWhen('2026-10-29')
  assert.equal(r.ok, true)
  assert.equal(r.label, '10-29')
  assert.equal(r.start, '2026-10-29')
  assert.equal(r.end, '2026-10-30')
})

test('中文写法也能认', () => {
  const r = normalizeWhen('2026年10月29日')
  assert.equal(r.ok, true)
  assert.equal(r.start, '2026-10-29')
})

test('月份与季节', () => {
  const m = normalizeWhen('2026-10')
  assert.equal(m.label, '10月')
  assert.equal(m.end, '2026-11-01')

  const autumn = normalizeWhen('2025-秋')
  assert.equal(autumn.label, '秋')
  assert.equal(autumn.start, '2025-09-01')
  assert.equal(autumn.end, '2025-12-01')
})

test('冬季跨年', () => {
  const r = normalizeWhen('2026-冬')
  assert.equal(r.start, '2026-12-01')
  assert.equal(r.end, '2027-03-01')
})

test('整年', () => {
  const r = normalizeWhen('2026')
  assert.equal(r.label, '全年')
  assert.equal(r.end, '2027-01-01')
})

test('看不懂的写法报错', () => {
  const r = normalizeWhen('去年秋天')
  assert.equal(r.ok, false)
  assert.match(r.error, /看不懂/)
})

console.log('日记')
test('写入并按天读回', () => {
  const { store } = freshStore()
  const written = store.appendJournal('2026-10-02', '下午爬了泰山，山顶风大。')
  assert.equal(written.ok, true)

  const sections = store.readJournal('2026-10-02', '2026-10-03')
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /泰山/)
})

test('模糊时间记进季节，能被月份查询带出', () => {
  const { store } = freshStore()
  store.appendJournal('2025-秋', '去了趟婺源，赶上晒秋。')
  const hits = store.readJournal('2025-09-01', '2025-12-01')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].label, '秋')
  assert.match(hits[0].text, /婺源/)
})

test('同一天写两次会追加到同一节', () => {
  const { store } = freshStore()
  store.appendJournal('2026-10-02', '第一段。')
  store.appendJournal('2026-10-02', '第二段。')
  const sections = store.readJournal('2026-10-02', '2026-10-03')
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /第一段/)
  assert.match(sections[0].text, /第二段/)
})

test('范围查询跨年', () => {
  const { store } = freshStore()
  store.appendJournal('2025-12-31', '去年最后一天。')
  store.appendJournal('2026-01-01', '今年第一天。')
  const hits = store.readJournal('2025-12-01', '2026-02-01')
  assert.equal(hits.length, 2)
})

test('没记过的那天返回空', () => {
  const { store } = freshStore()
  assert.deepEqual(store.readJournal('2026-07-01', '2026-07-02'), [])
})

test('日记放在 spaces 下，不属于任何分区', () => {
  const { store, dir } = freshStore()
  store.appendJournal('2026-10-02', '记一笔。')
  const file = path.join(dir, 'spaces', '日记', '2026.md')
  assert.ok(fs.existsSync(file))
  assert.ok(!fs.existsSync(path.join(dir, 'spaces', '日常', '日记')))
})

test('空内容拒绝写入', () => {
  const { store } = freshStore()
  const result = store.appendJournal('2026-10-02', '   ')
  assert.equal(result.ok, false)
})

console.log('分区列表')
test('渲染分区列表并标注默认', () => {
  const { store } = freshStore()
  store.createSpace('小说-归墟', '一部长篇的设定')
  const text = store.renderSpaceList()
  assert.match(text, /日常（默认）/)
  assert.match(text, /小说-归墟/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
