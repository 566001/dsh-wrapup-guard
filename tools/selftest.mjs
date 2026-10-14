/**
 * 离线自检：把 dsh-wrapup-guard 的状态机跑一遍，不依赖 DSH 运行时。
 *
 * 用一个假的 ctx 收下 tools.register 的定义，然后按真实调用顺序驱动它：
 *   start → check → report(有问题) → report(修好但有修复) → report(干净)×3
 * 断言：
 *   · 有未修复问题时被打回，且连续干净计数归零；
 *   · 有修复动作的轮次不算干净；
 *   · 连续 3 轮干净才放行（verdict === 'fixed-point'）；
 *   · 放行时确实发了通知。
 *
 * 用法：node tools/selftest.mjs
 */

import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✓ ' + label) }
  else { fail++; console.log('  ✗ ' + label + (detail ? '  → ' + detail : '')) }
}

/* ---- 假的 ctx：只实现插件真正用到的那几个服务 ---- */

let toolDef = null
let promptSection = null
let routeRegistered = null
const emitted = []

function makeCtx() {
  const inject = (deps, cb) => {
    const sub = {
      get(service) {
        if (service === 'tools') return { register: (def) => { toolDef = def; return () => {} } }
        if (service === 'systemPrompt') {
          return { section: (s) => { promptSection = s; return () => {} } }
        }
        return undefined
      },
      effect: (fn) => { try { fn() } catch { /* ignore */ } },
      webServer: {
        register: (r) => { routeRegistered = r; return () => {} },
      },
      emit: (name, payload) => { emitted.push({ name, payload }) },
    }
    if (deps.includes('webServer')) {
      // webServer 走 hostCtx.webServer 而不是 get()
      sub.webServer = sub.get('webServer') ?? sub.webServer
    }
    cb(sub)
  }
  return { inject, effect: (fn) => { try { fn() } catch { /* ignore */ } }, emit: (n, p) => emitted.push({ name: n, payload: p }) }
}

/* ---- 假 exec 上下文：cwd 指向本插件目录（没有 package.json scripts） ---- */

function makeExec(cwd) {
  return { agent: { session: { header: { cwd, id: 'selftest-session' } } } }
}

const ctx = makeCtx()
apply(ctx)

console.log('\n=== dsh-wrapup-guard 自检 ===\n')

console.log('① 注册')
ok('wrapup_check 工具已注册', toolDef !== null && toolDef.name === 'wrapup_check')
ok('系统提示段已注册', promptSection !== null && promptSection.name === 'wrapup-guard')
ok('浏览器端状态路由已注册', routeRegistered !== null && routeRegistered.path === '/dsh-wrapup-guard/status')
ok('工具参数含 action', !!toolDef?.parameters?.properties?.action)

const def = toolDef
const exec = makeExec(process.cwd())
const call = (args) => def.execute(args, exec)

console.log('\n② 状态机')

let r = await call({ action: 'status' })
ok('未开始时 status 返回 idle', r.verdict === 'idle', r.verdict)

r = await call({ action: 'start' })
ok('start 后 active=true', r.active === true)
ok('start 后 round=0', r.round === 0)
ok('start 后 dryStreak=0', r.dryStreak === 0)
ok('放行门槛是 3 轮', r.dryRequired === 3, String(r.dryRequired))

// 第 1 轮：发现一个没修的问题 → 应被打回
r = await call({
  action: 'report',
  problems: [{ kind: 'review', where: 'lib/index.js', what: '漏处理了空数组', fixed: false }],
  checks: ['review', 'build', 'consistency'],
  summary: '第一轮检查',
})
ok('有未修复问题 → 打回（verdict=continue）', r.verdict === 'continue', r.verdict)
ok('打回后连续干净归零', r.dryStreak === 0, String(r.dryStreak))
ok('打回消息里点出了那个问题', r.message.includes('漏处理了空数组'))

// 第 2 轮：修好了，但这一轮有修复动作 → 不算干净
r = await call({
  action: 'report',
  problems: [{ kind: 'review', where: 'lib/index.js', what: '漏处理了空数组', fixed: true }],
  checks: ['review', 'build', 'consistency'],
  summary: '修好了空数组分支',
})
ok('有修复动作的轮次不算干净', r.dryStreak === 0, String(r.dryStreak))
ok('此时仍未放行', r.verdict === 'continue', r.verdict)

// 连续 3 轮干净
r = await call({ action: 'report', problems: [], checks: ['review', 'build', 'consistency'], summary: '第3轮干净' })
ok('第 1 轮干净 → dryStreak=1', r.dryStreak === 1, String(r.dryStreak))
ok('第 1 轮干净不放行', r.verdict === 'continue', r.verdict)

r = await call({ action: 'report', problems: [], checks: ['review', 'build', 'consistency'], summary: '第4轮干净' })
ok('第 2 轮干净 → dryStreak=2', r.dryStreak === 2, String(r.dryStreak))
ok('第 2 轮干净仍不放行', r.verdict === 'continue', r.verdict)

r = await call({ action: 'report', problems: [], checks: ['review', 'build', 'consistency'], summary: '第5轮干净' })
ok('第 3 轮干净 → 放行', r.verdict === 'fixed-point', r.verdict)
ok('放行后 active=false', r.active === false)
ok('放行报告含“通过”', r.message.includes('收尾自检通过'))
ok('放行报告含修复记录', r.message.includes('修好了空数组分支'))

console.log('\n③ 通知')
ok('发了一次完成通知', emitted.length === 1, '实际 ' + emitted.length)
ok('通知事件名正确', emitted[0]?.name === 'wrapup-guard/completed', emitted[0]?.name)
ok('通知里带轮次数', typeof emitted[0]?.payload?.rounds === 'number')
ok('通知里带报告正文', typeof emitted[0]?.payload?.report === 'string' && emitted[0].payload.report.length > 20)

console.log('\n④ 漏报检查的提醒')
// 新一轮，只声明一类检查
r = await call({ action: 'start' })
r = await call({ action: 'report', problems: [], checks: ['review'], summary: '只做了审查' })
ok('缺检查类别时给出提醒', Array.isArray(r.missingKinds) && r.missingKinds.length === 2, JSON.stringify(r.missingKinds))
ok('缺类别仍然计入干净轮（但会提醒）', r.dryStreak === 1, String(r.dryStreak))

console.log('\n⑤ 参数校验')
r = await call({ action: 'report' })
ok('report 不带 problems → 提示必填', r.verdict === 'continue' && r.message.includes('problems'))

r = await call({ action: 'abort' })
ok('abort 后 active=false', r.active === false)

console.log('\n' + (fail === 0 ? `✓ 全部 ${pass} 项通过` : `✗ ${fail} 项未通过（共 ${pass + fail} 项）`))
process.exit(fail === 0 ? 0 : 1)
