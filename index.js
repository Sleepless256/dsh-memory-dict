/**
 * 记忆词典插件入口（v7：分区模型）。
 *
 * 注册两件事：
 *   1. 五个面向模型的工具（memory_recall / memory_open / memory_save / memory_spaces / memory_space_create）
 *   2. 两段常驻提示词：默认分区的基本记忆 + 分区列表
 *
 * 数据是纯文本 Markdown，用户可以随时用记事本打开、修改、删除。
 */

import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_SPACE, MemoryStore } from './lib/core.js'
import { buildTools } from './lib/tools.js'

export const name = 'memory-dict'

/** tools 提供工具注册表，systemPrompt 提供提示词片段注册表。 */
export const inject = ['tools', 'systemPrompt']

/** 默认把记忆放在 DSH 的用户目录下。 */
function defaultDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memory')
}

export const Config = z.object({
  /** 记忆库根目录。 */
  dir: z.string().default(defaultDir()),
  /** 默认分区名。用户不特别说明时，一切都在这里。 */
  defaultSpace: z.string().default(DEFAULT_SPACE),
  /** 基本记忆的常驻字数预算。 */
  coreLimit: z.number().default(400),
  /** 常驻提示词片段的排序位置。 */
  order: z.number().default(9500),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{dir: string, defaultSpace: string, coreLimit: number, order: number}} config
 */
export function apply(ctx, config) {
  const store = new MemoryStore({
    dir: config.dir,
    defaultSpace: config.defaultSpace,
    coreLimit: config.coreLimit,
  })

  try {
    store.ensure()
  } catch (error) {
    console.error(`[memory-dict] 无法初始化记忆目录 ${config.dir}：${error.message}`)
  }

  for (const tool of buildTools(store)) {
    ctx.tools.register(tool)
  }

  if (ctx.systemPrompt) {
    // 全局基本记忆：跨所有分区都成立的底线，排最前。
    ctx.systemPrompt.section({
      name: 'memory-dict:core-global',
      order: config.order - 20,
      text: () => {
        try {
          return store.renderGlobalCore()
        } catch (error) {
          console.error(`[memory-dict] 生成全局基本记忆失败：${error.message}`)
          return ''
        }
      },
    })

    // 默认分区的基本记忆：只在这个分区里成立的事。
    ctx.systemPrompt.section({
      name: 'memory-dict:core',
      order: config.order - 10,
      text: () => {
        try {
          return store.renderCore(config.defaultSpace)
        } catch (error) {
          console.error(`[memory-dict] 生成基本记忆失败：${error.message}`)
          return ''
        }
      },
    })

    ctx.systemPrompt.section({
      name: 'memory-dict:spaces',
      order: config.order,
      text: () => {
        try {
          return store.renderSpaceList()
        } catch (error) {
          // 提示词组装失败会毁掉整轮对话，这里必须兜住。
          console.error(`[memory-dict] 生成分区列表失败：${error.message}`)
          return ''
        }
      },
    })
  } else {
    console.warn('[memory-dict] 当前环境没有 systemPrompt 服务，常驻记忆已跳过。')
  }

  console.log(`[memory-dict] 已加载，记忆目录：${config.dir}`)
}
