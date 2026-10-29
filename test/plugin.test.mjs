/**
 * 插件层自测（v7 分区模型）：用假的 ctx 验证工具注册与行为。
 *   node test/plugin.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as plugin from '../index.js'
import { DEFAULT_SPACE } from '../lib/core.js'

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
    if (process.env.VERBOSE) console.log(error.stack)
  }
}

function harness(dir) {
  const tools = new Map()
  const sections = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
  }
  plugin.apply(ctx, { dir, defaultSpace: DEFAULT_SPACE, coreLimit: 400, order: 9500 })
  return { tools, sections }
}

const signal = new AbortController().signal
const run = (tool, args) => tool.execute(args, { signal })

console.log('配置与注册')
await test('Config 提供默认值', () => {
  const config = plugin.Config({})
  assert.equal(typeof config.dir, 'string')
  assert.equal(config.defaultSpace, DEFAULT_SPACE)
  assert.equal(config.coreLimit, 400)
})

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memdict-plugin-'))
const { tools, sections } = harness(baseDir)

await test('七个工具都注册了', () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['journal_read', 'journal_write', 'memory_open', 'memory_recall', 'memory_save', 'memory_space_create', 'memory_spaces']
  )
})

await test('注册了全局基本记忆、分区基本记忆、分区列表三段', () => {
  assert.equal(sections.length, 3)
  const byName = new Map(sections.map((s) => [s.name, s]))
  const global = byName.get('memory-dict:core-global')
  const core = byName.get('memory-dict:core')
  const spaces = byName.get('memory-dict:spaces')
  assert.ok(global && core && spaces)
  assert.ok(global.order < core.order, '全局基本记忆应排最前')
  assert.ok(core.order < spaces.order)
})

console.log('写入')
await test('新建词条必须给摘要', async () => {
  const out = await run(tools.get('memory_save'), {
    entry: '饮食',
    facts: ['微辣或不辣'],
  })
  assert.match(out, /未写入/)
  assert.match(out, /summary/)
})

await test('给了摘要就能建', async () => {
  const out = await run(tools.get('memory_save'), {
    entry: '饮食',
    facts: ['通用：[辣度] 微辣或不辣', '晚餐：不要太油腻'],
    summary: '点餐口味：微辣、晚餐忌油腻',
    aliases: ['吃饭', '口味', '忌口', '点餐'],
  })
  assert.match(out, /已写入「日常 › 饮食」/)
  assert.match(out, /新建词条/)
})

await test('分组前缀写进了文件', () => {
  const raw = fs.readFileSync(path.join(baseDir, 'spaces', DEFAULT_SPACE, '词条', '饮食.md'), 'utf8')
  assert.match(raw, /### 通用/)
  assert.match(raw, /### 晚餐/)
  assert.match(raw, /\[辣度\] 微辣或不辣/)
})

await test('往不存在的分区写会被拦住并提示先问用户', async () => {
  const out = await run(tools.get('memory_save'), {
    entry: '主角',
    facts: ['主角叫沈砚'],
    summary: '主角设定',
    space: '小说-归墟',
  })
  assert.match(out, /分区「小说-归墟」不存在/)
  assert.match(out, /征得用户同意/)
})

console.log('分区')
await test('建分区后可以写入', async () => {
  const created = await run(tools.get('memory_space_create'), {
    space: '小说-归墟',
    description: '一部长篇的设定',
  })
  assert.match(created, /已创建分区/)

  const out = await run(tools.get('memory_save'), {
    entry: '主角',
    facts: ['主角叫沈砚，二十七岁'],
    summary: '主角的基本设定',
    space: '小说-归墟',
  })
  assert.match(out, /已写入「小说-归墟 › 主角」/)
})

await test('description 是必填参数，不写就调不动', async () => {
  const tool = tools.get('memory_space_create')
  assert.ok(tool.parameters.required.includes('description'))
  await assert.rejects(() => run(tool, { space: '随手一拍' }), /description/)
})

await test('分区列表常驻判断依据', async () => {
  const text = sections.find((s) => s.name === 'memory-dict:spaces').text()
  assert.match(text, /会持续多次会话/)
  assert.match(text, /管什么、不管什么/)
  assert.match(text, /不要按人、按群、按平台开分区/)
})

await test('memory_spaces 列出分区与词条', async () => {
  const out = await run(tools.get('memory_spaces'), {})
  assert.match(out, /日常（默认）/)
  assert.match(out, /小说-归墟/)
  assert.match(out, /饮食/)
  assert.match(out, /主角/)
})

console.log('检索')
await test('recall 在默认分区找到饮食', async () => {
  const out = await run(tools.get('memory_recall'), { topic: '吃饭' })
  assert.match(out, /日常 › 饮食/)
  assert.match(out, /微辣或不辣/)
})

await test('recall 默认看不到小说分区', async () => {
  const out = await run(tools.get('memory_recall'), { topic: '沈砚' })
  assert.match(out, /跨分区找到/)
  assert.match(out, /小说-归墟 › 主角/)
})

await test('指定分区后能直接找到', async () => {
  const out = await run(tools.get('memory_recall'), { topic: '沈砚', space: '小说-归墟' })
  assert.match(out, /小说-归墟 › 主角/)
  assert.ok(!out.includes('跨分区找到'))
})

await test('open 返回完整词条', async () => {
  const out = await run(tools.get('memory_open'), { entry: '饮食' })
  assert.match(out, /摘要：点餐口味/)
  assert.match(out, /别名：吃饭/)
  assert.match(out, /### 晚餐/)
})

await test('open 不存在的词条给出清单', async () => {
  const out = await run(tools.get('memory_open'), { entry: '不存在' })
  assert.match(out, /没有名为「不存在」/)
  assert.match(out, /饮食/)
})

console.log('基本记忆')
await test('写进基本记忆并常驻', async () => {
  const out = await run(tools.get('memory_save'), {
    core: true,
    facts: ['对花生过敏', '称呼用户为「阿哲」'],
  })
  assert.match(out, /基本记忆/)
  const core = sections.find((s) => s.name === 'memory-dict:core')
  const text = core.text()
  assert.match(text, /花生过敏/)
  assert.match(text, /阿哲/)
})

await test('global: true 写进全局基本记忆', async () => {
  const out = await run(tools.get('memory_save'), {
    core: true,
    global: true,
    facts: ['对海鲜过敏'],
  })
  assert.match(out, /全局基本记忆/)
  const core = sections.find((s) => s.name === 'memory-dict:core-global')
  assert.match(core.text(), /海鲜过敏/)

  const spaceCore = sections.find((s) => s.name === 'memory-dict:core')
  assert.ok(!spaceCore.text().includes('海鲜过敏'), '全局的不该混进分区基本记忆')
})

await test('基本记忆不参与检索', async () => {
  const out = await run(tools.get('memory_recall'), { topic: '花生' })
  assert.match(out, /没有找到/)
})

await test('基本记忆支持同槽位改写', async () => {
  await run(tools.get('memory_save'), { core: true, facts: ['[昵称] 叫我小晴'] })
  const out = await run(tools.get('memory_save'), { core: true, facts: ['[昵称] 叫我念念'] })
  assert.match(out, /替换旧值/)
  const text = sections.find((s) => s.name === 'memory-dict:core').text()
  assert.match(text, /念念/)
  assert.ok(!text.includes('小晴'))
})

console.log('日记')
await test('写入后能按天读回', async () => {
  const written = await run(tools.get('journal_write'), {
    when: '2026-10-02',
    text: '下午爬了泰山，山顶风大。',
  })
  assert.match(written, /已记入日记/)
  assert.match(written, /10-02/)

  const read = await run(tools.get('journal_read'), { from: '2026-10-02' })
  assert.match(read, /共 1 段/)
  assert.match(read, /泰山/)
})

await test('模糊时间写得进、查得出', async () => {
  await run(tools.get('journal_write'), { when: '2025-秋', text: '去了趟婺源，赶上晒秋。' })
  const read = await run(tools.get('journal_read'), { from: '2025-09-01', to: '2025-12-01' })
  assert.match(read, /## 秋/)
  assert.match(read, /婺源/)
})

await test('没记过的日期明确说没有', async () => {
  const read = await run(tools.get('journal_read'), { from: '2026-03-15' })
  assert.match(read, /没有记录/)
})

await test('看不懂的时间报错', async () => {
  const read = await run(tools.get('journal_read'), { from: '去年秋天' })
  assert.match(read, /看不懂的时间写法/)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
