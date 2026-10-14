/**
 * 自动检查命令的单独自检：验证 detectCommands + runCommand 真的能跑起来。
 * 用法：node tools/check-commands.mjs [项目路径]
 */
import { apply } from '../lib/index.js'

const cwd = process.argv[2] || process.cwd()

let toolDef = null
// ctx.effect(fn, label) 的真实语义是「立即执行 fn，把返回值当 disposer 登记」，
// mock 必须照做，否则工具注册那一步（它是包在 effect 里的）永远不会发生。
const fakeEffect = (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} }
const ctx = {
  inject: (deps, cb) => {
    cb({
      get: (s) => (s === 'tools' ? { register: (d) => { toolDef = d; return () => {} } } : undefined),
      effect: fakeEffect,
      webServer: { register: () => () => {} },
    })
  },
  effect: fakeEffect,
  emit: () => {},
  webServer: { register: () => () => {} },
}
apply(ctx)

const exec = { agent: { session: { header: { cwd, id: 'cmd-test' } } } }
const call = (args) => toolDef.execute(args, exec)

console.log('测试目录：' + cwd + '\n')

await call({ action: 'start' })
const r = await call({ action: 'check' })

console.log(r.message.slice(0, 2500))
console.log('\n--- 结构 ---')
console.log('commands 条数: ' + (r.commands?.length ?? 0))
if (r.commands) {
  for (const c of r.commands) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.command}  exit=${c.exitCode} ${c.ms}ms`)
  }
}
