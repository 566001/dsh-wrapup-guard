/**
 * dsh-wrapup-guard — Host half（收尾哨兵）
 *
 * 「收尾自检」纪律工具。AI 判断任务做完时调用 `wrapup_check`，进入一个
 * 「检查 → 发现问题 → 修复 → 再检查」的循环，直到**连续 DRY_ROUNDS 轮
 * 全面检查都没有发现任何问题**，才判定收尾完成并通知用户。
 *
 * 分工：
 *   · 本插件负责：轮次状态机、自动跑「命令类」检查（测试/lint/audit）、
 *     判定是否放行、通知用户。
 *   · AI 负责：代码审查、构建/运行验证的判断、以及真正的修复动作。
 *
 * 刻意不 import 任何 `@deepseek-ai/*`：profile 安装的插件从自己的目录解析
 * 模块，harness 包在那里不可达。一切都走 `ctx` 和 node 内置模块。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-wrapup-guard'

/** 连续这么多轮「全面检查无问题」才算收尾完成。用户要求的是三次。 */
const DRY_ROUNDS = 3
/** 单条检查命令的超时（毫秒）。足够跑完一次测试，又不至于挂死。 */
const CMD_TIMEOUT_MS = 180_000
/** 捕获输出上限，避免一条刷屏的日志把内存吃光。 */
const MAX_OUTPUT_CHARS = 24_000
/** 结果里每类信息保留的字符数。 */
const CLIP_CHARS = 900

const TOOL_NAME = 'wrapup_check'

/** 四类检查的固定清单。命令类由插件自动跑；审查类由 AI 完成并汇报。 */
const CHECK_KINDS = [
  {
    id: 'auto',
    label: '项目自检（测试 / lint / audit）',
    mode: 'command',
    hint: '插件会自动探测并运行项目里的检查脚本，把输出抓回来。',
  },
  {
    id: 'review',
    label: '代码审查（疑似 bug / 坏味道）',
    mode: 'manual',
    hint: 'AI 阅读本轮改动过的文件，找逻辑错误、未处理的异常、边界问题。',
  },
  {
    id: 'build',
    label: '构建 / 运行验证',
    mode: 'manual',
    hint: 'AI 尝试构建或启动，确认能跑起来、没有报错。',
  },
  {
    id: 'consistency',
    label: '一致性检查（文档 / 配置 / 依赖）',
    mode: 'manual',
    hint: 'AI 核对文档与实现、配置完整性、依赖冲突。',
  },
]

/* ───────────────────────── 自动检查命令探测 ───────────────────────── */

/**
 * 从项目根探测应该跑哪些命令。
 *
 * 只做「读文件 + 看存在性」，绝不猜：package.json 里有 script 才跑，有对应
 * 的检查脚本文件才跑。探测不到任何命令时返回空数组 —— 那是合法结果，说明
 * 这个项目的命令类检查要靠 AI 手动完成，不是错误。
 *
 * 注意「只认白名单」的取舍：本插件自己用的就是 `npm run check` +
 * `tools/selftest.mjs`，而旧白名单只认 test/lint/typecheck，导致它连自己的
 * 仓库都检查不了（恒报「没有可自动运行的检查」）。所以 `check` 与
 * `tools/selftest.mjs` 也纳入白名单 —— 它们同样是约定俗成的检查名，
 * 不是靠猜脚本内容。
 */
const NPM_CHECK_SCRIPTS = ['test', 'lint', 'typecheck', 'check']
const TOOL_CHECK_FILES = ['tools/audit.js', 'tools/check.js', 'tools/selftest.mjs']

function detectCommands(cwd) {
  const out = []
  const pkgPath = join(cwd, 'package.json')

  if (existsSync(pkgPath)) {
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch {
      pkg = null
    }
    const scripts = pkg !== null && pkg !== undefined && typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? pkg.scripts
      : {}
    // 只认这些约定俗成的脚本名，顺序即优先级。
    for (const key of NPM_CHECK_SCRIPTS) {
      if (typeof scripts[key] === 'string' && scripts[key].trim() !== '') {
        out.push({ id: 'npm:' + key, cmd: 'npm', args: ['run', key], source: 'package.json scripts.' + key })
      }
    }
  }

  // 项目自带的静态检查脚本（这个工作区的项目就是这么组织的）。
  for (const rel of TOOL_CHECK_FILES) {
    if (existsSync(join(cwd, rel))) {
      out.push({ id: 'node:' + rel, cmd: 'node', args: [rel], source: rel })
    }
  }

  return out
}

/* ───────────────────────── 跑一条命令 ───────────────────────── */

/**
 * Windows 上 `npm` 只是 `npm.cmd` 批处理垫片，**没有可执行文件**。
 * 直接 `execFile('npm', …)` 会以 `ENOENT` 失败，而 `.cmd` 又因为 Node 24
 * 的 CVE-2024-27980 补丁禁止带参数直跑（`EINVAL`）。
 * 所以 Windows 必须交给 `cmd.exe` 来解析，参数里带空格或 `&`、`|` 等元字符的
 * token 要用引号包住，避免被 shell 当成语法。
 */
function buildSpawnSpec(spec) {
  if (process.platform !== 'win32') {
    return { cmd: spec.cmd, args: spec.args, shell: false }
  }
  // 只在**确实需要**时加引号：给每个 token 都套引号会让 cmd 把
  // `""npm" "run""` 当成一个整体命令名，反而报「不是内部或外部命令」。
  const quote = (s) => {
    const text = String(s)
    return /[\s&|<>^()"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  const line = [spec.cmd, ...spec.args].map(quote).join(' ')
  return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', line], shell: false }
}

/**
 * 杀掉一整棵进程树。
 *
 * Windows 上没有进程组可以一次性收拾：npm → cmd.exe → node 是一条链，
 * `child.kill()` 只放倒第一环。必须用 `taskkill /T /F` 连子孙一起带走，
 * 否则孙进程会继续持有 stdout 管道，'close' 迟迟不触发。
 */
function killTree(child) {
  if (child === undefined || child === null || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch { /* 尽力而为 */ }
    return
  }
  try { child.kill('SIGKILL') } catch { /* 进程可能已经退出 */ }
}

function runCommand(spec, cwd) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let child

    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const launch = buildSpawnSpec(spec)

    try {
      child = spawn(
        launch.cmd,
        launch.args,
        {
          cwd,
          windowsHide: true,
          // 不继承 shell 的编码假设：这两个项目输出都是 UTF-8。
          env: { ...process.env, NO_COLOR: '1' },
        },
      )
    } catch (err) {
      finish({
        id: spec.id,
        command: spec.cmd + ' ' + spec.args.join(' '),
        source: spec.source,
        ok: false,
        exitCode: null,
        timedOut: false,
        ms: Date.now() - started,
        output: '无法启动命令：' + String((err && err.message) || err),
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    // 结果构造器必须在**任何**定时器之前定义：超时兜底路径会调用它，
    // 而定时器最早在下一轮宏任务才触发 —— 虽然实际上不会撞上 TDZ，
    // 但把定义提到使用点之前，才是这段代码能自证正确的前提。
    const buildResult = ({ code, timedOut: to, errorText }) => {
      const tail = (text) => (text.length <= MAX_OUTPUT_CHARS ? text : '…(截断)\n' + text.slice(-MAX_OUTPUT_CHARS))
      if (errorText !== undefined) {
        return {
          id: spec.id,
          command: spec.cmd + ' ' + spec.args.join(' '),
          source: spec.source,
          ok: false,
          exitCode: typeof code === 'number' ? code : null,
          timedOut: false,
          ms: Date.now() - started,
          output: errorText,
        }
      }
      const body = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')
      return {
        id: spec.id,
        command: spec.cmd + ' ' + spec.args.join(' '),
        source: spec.source,
        ok: !to && code === 0,
        exitCode: typeof code === 'number' ? code : null,
        timedOut: to,
        ms: Date.now() - started,
        output: to
          ? '命令超时（超过 ' + Math.round(CMD_TIMEOUT_MS / 1000) + ' 秒）被杀掉。\n' + tail(body)
          : tail(body),
      }
    }

    // Windows 上我们跑的是 cmd.exe，npm 又是它的子进程：只 kill cmd.exe 会留下
    // 孙进程继续持有 stdout 管道，'close' 得等孙进程自己结束才触发 —— 超时就形同
    // 虚设（实测 2 秒超时拖到 60 秒才返回）。所以超时要连整棵进程树一起杀。
    let killTimer = null
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      // 兜底：树杀之后管道若仍被别处持有，最多再等 5 秒就强制收尾。
      killTimer = setTimeout(() => {
        finish(buildResult({ code: null, timedOut: true }))
      }, 5_000)
    }, CMD_TIMEOUT_MS)

    child.stdout?.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8') })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      const text = '执行出错：' + String((err && err.message) || err)
      finish(buildResult({ code: null, timedOut: false, errorText: text }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      finish(buildResult({ code, timedOut }))
    })
  })
}

async function runAllCommands(cwd) {
  const specs = detectCommands(cwd)
  const results = []
  for (const spec of specs) {
    results.push(await runCommand(spec, cwd))
  }
  return { specs, results }
}

/* ───────────────────────── 状态持久化 ───────────────────────── */

/**
 * 每个会话一份收尾状态，落在 ~/.dsh/wrapup-guard/<sessionId>.json。
 *
 * 持久化的意义：收尾循环可能跨很多轮工具调用，中途 DSH 重启也不该把计数丢掉，
 * 否则 AI 会以为「三次干净」已经达成。
 */
function stateDir() {
  const base = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'wrapup-guard')
    : join(homedir(), '.dsh', 'wrapup-guard')
  return base
}

function statePath(sessionId) {
  const safe = String(sessionId || 'anonymous').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(stateDir(), safe + '.json')
}

function emptyState() {
  return {
    version: 1,
    active: false,
    round: 0,
    dryStreak: 0,
    dryRequired: DRY_ROUNDS,
    startedAt: null,
    updatedAt: null,
    history: [],
    completedAt: null,
    notified: false,
  }
}

function loadState(sessionId) {
  try {
    const raw = readFileSync(statePath(sessionId), 'utf8')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return emptyState()
    const base = emptyState()
    return { ...base, ...data, history: Array.isArray(data.history) ? data.history : [] }
  } catch {
    return emptyState()
  }
}

function saveState(sessionId, state) {
  const file = statePath(sessionId)
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 落盘失败不该让工具调用失败：状态在内存里也已经更新了 */
  }
}

/* ───────────────────────── 辅助 ───────────────────────── */

function clip(text, limit = CLIP_CHARS) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (s.length <= limit) return s
  return s.slice(0, limit) + '…'
}

function cwdOf(exec) {
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  const header = agent === undefined || agent === null ? undefined : agent.session.header
  return header !== undefined && header !== null && typeof header.cwd === 'string' && header.cwd !== ''
    ? header.cwd
    : process.cwd()
}

function sessionIdOf(exec) {
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  const header = agent === undefined || agent === null ? undefined : agent.session.header
  const id = header !== undefined && header !== null ? header.id : undefined
  return typeof id === 'string' && id !== '' ? id : 'anonymous'
}

/* ───────────────────────── 工具参数 / 输出 ───────────────────────── */

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'check', 'report', 'status', 'abort'],
      description:
        'start=开始一轮收尾自检（重置计数）；' +
        'check=让插件自动跑命令类检查（测试/lint/audit）并把原始输出抓回来，你据此判断；' +
        'report=汇报本轮**全面检查**的结论（插件据此推进或拦回）；' +
        'status=查看当前轮次与连续干净计数；' +
        'abort=放弃本次收尾。',
    },
    problems: {
      type: 'array',
      description:
        'report 时必填：本轮全面检查发现的问题列表。每一项写清「哪里、什么问题」。' +
        '注意：命令检查失败了就要如实写进来；代码审查/构建/一致性发现的问题也要写。' +
        '这一项为空数组才表示本轮完全干净。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: ['auto', 'review', 'build', 'consistency'],
            description: '这个问题来自哪一类检查。',
          },
          where: { type: 'string', description: '位置：文件 / 区域 / 命令。' },
          what: { type: 'string', description: '具体是什么问题。' },
          fixed: { type: 'boolean', description: '本轮是否已经修复。未修复则插件会拦住你。' },
        },
        required: ['what'],
      },
    },
    summary: {
      type: 'string',
      description:
        'report 时的本轮小结：你这轮具体跑了什么检查、怎么修的。这句话会出现在最终报告里，写给用户看。',
    },
    checks: {
      type: 'array',
      description:
        'report 时可选：本轮你**手动完成**的检查项（代码审查 / 构建验证 / 一致性）。' +
        '写上代表你确实做了这一类检查；缺项会让插件提醒你还有哪类没做。',
      items: { type: 'string', enum: ['review', 'build', 'consistency'] },
    },
    note: { type: 'string', description: 'status / abort 时的备注。' },
  },
  required: ['action'],
}

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    active: { type: 'boolean' },
    round: { type: 'number' },
    dryStreak: { type: 'number' },
    dryRequired: { type: 'number' },
    verdict: {
      type: 'string',
      enum: ['continue', 'fixed-point', 'done', 'idle'],
      description:
        'continue=继续循环；fixed-point=已达到连续无问题，收尾完成；done=已完成；idle=尚未开始。',
    },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'number' },
          timedOut: { type: 'boolean' },
          ms: { type: 'number' },
          output: { type: 'string' },
        },
      },
    },
    missingKinds: {
      type: 'array',
      items: { type: 'string' },
      description: '本轮还缺少的检查类别（AI 应补齐后再 report）。',
    },
  },
}

/* ───────────────────────── 插件本体 ───────────────────────── */

export function apply(ctx) {
  /** 最近一次完成的收尾记录，供浏览器端轮询展示。 */
  let latest = null

  const notify = (sessionId, payload) => {
    try {
      ctx.emit('wrapup-guard/completed', { sessionId, ...payload })
    } catch {
      /* 没有监听者（例如非 Web 前端）时静默即可；工具返回值里也有完整报告 */
    }
  }

  /* ---------- 浏览器端轮询用的只读路由 ---------- */
  //
  // 一次收尾完成就写一次 `latest`；客户端 `fetch` 它并弹出通知。这样刷新页面
  // 也能看到最近一次结果，不需要持久订阅。
  ctx.inject(['webServer'], (hostCtx) => {
    const server = hostCtx.webServer
    if (server === undefined || server === null || typeof server.register !== 'function') return
    hostCtx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: '/dsh-wrapup-guard/status',
          handler: (request, response) => {
            if (request !== undefined && request !== null && request.method !== 'GET' &&
                request.method !== undefined && request.method !== null) {
              try { response.writeHead(405, { allow: 'GET' }); response.end() } catch { /* ignore */ }
              return
            }
            const body = JSON.stringify({ latest })
            try {
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              response.end(body)
            } catch {
              /* 路由失败不该影响工具本身 */
            }
          },
        }),
      'dsh-wrapup-guard: status route',
    )
  })

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined || tools === null) return

    const definition = {
      name: TOOL_NAME,
      description: [
        '收尾自检哨兵：任务做得差不多时调用它，进入「全面检查 → 发现问题 → 修复 → 再全面检查」的循环，',
        '直到连续 ' + DRY_ROUNDS + ' 轮全面检查都没有发现任何问题，才判定收尾完成并通知用户。',
        '',
        '用法（严格按顺序）：',
        '1. action="start" —— 开始收尾，重置计数。',
        '2. action="check" —— 插件自动跑项目里的测试 / lint / audit，把原始输出返回给你。',
        '3. 你自己再完成另外三类：代码审查、构建/运行验证、一致性检查。',
        '4. action="report" —— 如实汇报本轮发现的问题（problems），并声明你做了哪几类检查（checks）。',
        '   只要还有未修复的问题，插件会打回；有修复动作的轮次不计入「连续干净」，计数归零。',
        '5. 重复 2~4。**只有连续 ' + DRY_ROUNDS + ' 轮 problems 为空数组**才放行，届时会通知用户。',
        '',
        '诚实是硬要求：不要把没跑的命令说成跑了，不要把没修的问题标成已修。',
        '这个工具的全部价值，就是拦住「差不多可以了」。',
      ].join('\n'),
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },

      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        const action = typeof input.action === 'string' ? input.action : 'status'
        const cwd = cwdOf(exec)
        const sessionId = sessionIdOf(exec)
        const state = loadState(sessionId)

        const snapshot = (verdict, message, extra = {}) => {
          state.updatedAt = new Date().toISOString()
          saveState(sessionId, state)
          return {
            message,
            active: state.active,
            round: state.round,
            dryStreak: state.dryStreak,
            dryRequired: DRY_ROUNDS,
            verdict,
            ...extra,
          }
        }

        /* ---------- start ---------- */
        if (action === 'start') {
          state.active = true
          state.round = 0
          state.dryStreak = 0
          state.startedAt = new Date().toISOString()
          state.completedAt = null
          state.notified = false
          state.history = []
          const specs = detectCommands(cwd)
          const cmdList = specs.length > 0
            ? '\n探测到的命令类检查：' + specs.map((s) => '\n  · ' + s.cmd + ' ' + s.args.join(' ') + '（来自 ' + s.source + '）').join('')
            : '\n没有探测到可自动运行的检查命令（没有 package.json scripts，也没有 tools/audit.js）——命令类检查请你自己跑。'
          return snapshot(
            'continue',
            '收尾自检已开始。规则：连续 ' + DRY_ROUNDS + ' 轮全面检查都零问题才放行。' + cmdList +
              '\n\n下一步：调用 action="check" 跑命令类检查，然后自己完成代码审查、构建验证、一致性检查，最后用 action="report" 汇报。',
          )
        }

        /* ---------- abort ---------- */
        if (action === 'abort') {
          const note = typeof input.note === 'string' ? input.note : ''
          state.active = false
          return snapshot('idle', '已放弃本次收尾自检。' + (note !== '' ? '备注：' + note : ''))
        }

        /* ---------- status ---------- */
        if (action === 'status') {
          if (!state.active) {
            return snapshot('idle', '当前没有进行中的收尾自检。用 action="start" 开始一次。')
          }
          return snapshot(
            'continue',
            '收尾自检进行中：第 ' + state.round + ' 轮刚结束，连续零问题 ' + state.dryStreak + ' / ' + DRY_ROUNDS + '。' +
              '\n各轮摘要：\n' +
              (state.history.length === 0
                ? '（还没有汇报过）'
                : state.history
                    .map((h) => '  第 ' + h.round + ' 轮：' + h.problemCount + ' 个问题' + (h.fixedCount > 0 ? '（修复 ' + h.fixedCount + '）' : '') + (h.summary !== '' ? ' —— ' + clip(h.summary, 160) : ''))
                    .join('\n')),
          )
        }

        /* ---------- check：自动跑命令 ---------- */
        if (action === 'check') {
          if (!state.active) {
            return snapshot('idle', '收尾自检还没开始。请先 action="start"。')
          }
          const { specs, results } = await runAllCommands(cwd)
          if (specs.length === 0) {
            return snapshot(
              'continue',
              '没有可自动运行的命令类检查（未发现 package.json 的 test/lint/typecheck，也没有 tools/audit.js、tools/check.js）。' +
                '\n请你自己手动完成这一类检查，再和其它三类一起 report。',
            )
          }
          const failed = results.filter((r) => !r.ok)
          const lines = results.map((r) => {
            const head = (r.ok ? '✓' : r.timedOut ? '⏱ 超时' : '✗ 失败') + '  ' + r.command + '  (' + r.ms + 'ms' + (r.exitCode !== null ? ', exit ' + r.exitCode : '') + ')'
            const body = r.ok ? clip(r.output, 400) : clip(r.output, 3000)
            return head + '\n' + (body === '' ? '（无输出）' : body.replace(/\n/g, '\n  '))
          })
          const tail = failed.length === 0
            ? '\n\n命令类检查全部通过。请继续完成代码审查 / 构建验证 / 一致性检查，然后 action="report"。'
            : '\n\n有 ' + failed.length + ' 条命令失败——这些都算「本轮发现的问题」，修好之前不要 report 成干净。'
          return snapshot(
            'continue',
            '自动检查结果（' + results.length + ' 条）：\n' + lines.join('\n\n') + tail,
            { commands: results },
          )
        }

        /* ---------- report：汇报本轮结论 ---------- */
        if (action === 'report') {
          if (!state.active) {
            return snapshot('idle', '收尾自检还没开始。请先 action="start"。')
          }

          const problems = Array.isArray(input.problems) ? input.problems : null
          if (problems === null) {
            return snapshot(
              'continue',
              'report 必须带上 problems 数组（本轮全面检查发现的问题；完全干净就传空数组 []）。' +
                '空数组才是唯一的「干净」信号——缺参数不等于干净。',
            )
          }

          const declared = Array.isArray(input.checks) ? input.checks : []
          const declaredSet = new Set(declared.filter((k) => typeof k === 'string'))
          // 「命令类」只要跑过 check 就算做了；这里只校验三类人工检查有没有声明。
          const missingKinds = ['review', 'build', 'consistency'].filter((k) => !declaredSet.has(k))

          const unfixed = problems.filter((p) => {
            if (p === null || typeof p !== 'object') return true
            return p.fixed !== true
          })

          state.round += 1
          const entry = {
            round: state.round,
            problemCount: problems.length,
            fixedCount: problems.filter((p) => p !== null && typeof p === 'object' && p.fixed === true).length,
            unfixedCount: unfixed.length,
            summary: typeof input.summary === 'string' ? input.summary : '',
            declaredChecks: [...declaredSet],
            at: new Date().toISOString(),
          }

          // —— 拦住：有问题没修 ——
          if (unfixed.length > 0) {
            state.dryStreak = 0
            entry.outcome = 'blocked-unfixed'
            state.history.push(entry)
            const detail = unfixed
              .map((p, i) => {
                const item = p !== null && typeof p === 'object' ? p : {}
                const where = typeof item.where === 'string' && item.where !== '' ? item.where + '：' : ''
                const what = typeof item.what === 'string' ? item.what : '（未描述）'
                return '  ' + (i + 1) + '. ' + where + what
              })
              .join('\n')
            return snapshot(
              'continue',
              '打回：第 ' + state.round + ' 轮还有 ' + unfixed.length + ' 个问题没有修复，不能算干净（连续计数已归零）。' +
                '\n未修复的问题：\n' + detail +
                '\n\n请逐个修掉，然后**重新做一次全面检查**再 report。',
              { missingKinds },
            )
          }

          // —— 拦住：不干净（有已修问题）——
          if (problems.length > 0) {
            state.dryStreak = 0
            entry.outcome = 'blocked-dirty'
            state.history.push(entry)
            return snapshot(
              'continue',
              '第 ' + state.round + ' 轮修复了 ' + entry.fixedCount + ' 个问题，所以这一轮不算干净（连续计数归零）。' +
                '\n继续：再做一次**全面检查**（check + 三类人工检查），确认没有新问题、旧问题也没复发，然后 report。',
              { missingKinds },
            )
          }

          // —— 干净的一轮 ——
          state.dryStreak += 1
          entry.outcome = 'clean'
          entry.missingKinds = missingKinds
          state.history.push(entry)

          if (state.dryStreak >= DRY_ROUNDS) {
            state.active = false
            state.completedAt = new Date().toISOString()
            const fixedTotal = state.history.reduce((n, h) => n + (h.fixedCount || 0), 0)
            const problemsTotal = state.history.reduce((n, h) => n + (h.problemCount || 0), 0)
            const okLines = state.history
              .filter((h) => h.outcome === 'clean')
              .map((h) => '  · 第 ' + h.round + ' 轮：零问题')
              .join('\n')
            const fixLines = state.history
              .filter((h) => (h.fixedCount || 0) > 0)
              .map((h) => '  · 第 ' + h.round + ' 轮：修了 ' + h.fixedCount + ' 个 —— ' + clip(h.summary, 200))
              .join('\n')
            const report =
              '✅ 收尾自检通过：连续 ' + DRY_ROUNDS + ' 轮全面检查零问题。\n' +
              '（共 ' + state.round + ' 轮，累计发现 ' + problemsTotal + ' 个问题、修复 ' + fixedTotal + ' 个）' +
              (fixLines !== '' ? '\n\n修复记录：\n' + fixLines : '') +
              (okLines !== '' ? '\n\n放行的三轮：\n' + okLines : '')

            if (!state.notified) {
              state.notified = true
              const record = {
                sessionId,
                cwd,
                rounds: state.round,
                problemsTotal,
                fixedTotal,
                report,
                finishedAt: state.completedAt,
              }
              latest = record
              notify(sessionId, record)
            }

            return snapshot('fixed-point', report + '\n\n可以把上面的报告转述给用户，任务收尾完成。', {
              missingKinds: [],
            })
          }

          const remaining = DRY_ROUNDS - state.dryStreak
          const warn =
            missingKinds.length > 0
              ? '\n\n注意：你声明的手动检查里缺少 ' + missingKinds.map((k) => CHECK_KINDS.find((c) => c.id === k).label).join('、') +
                '。空 problems 只有在**四类检查都做了**的前提下才算数——下次请补齐（或明确说明为什么这一类不适用）。'
              : ''
          return snapshot(
            'continue',
            '第 ' + state.round + ' 轮零问题，连续干净 ' + state.dryStreak + ' / ' + DRY_ROUNDS + '（还差 ' + remaining + ' 轮）。' +
              warn +
              '\n\n下一轮：再完整跑一遍全部四类检查（不要只看刚才改的地方），确认没有新的问题，然后 report。' +
              (warn !== '' ? '' : ''),
            { missingKinds },
          )
        }

        return snapshot('idle', '未知的 action：' + action + '。可用：start / check / report / status / abort。')
      },
    }

    ctx.effect(() => tools.register(definition), 'dsh-wrapup-guard: wrapup_check tool')
  })

  /* ---------- 给模型的一段系统提示（让它知道该在什么时候用） ---------- */
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.get('systemPrompt')
    if (prompt === undefined || prompt === null) return
    const text = [
      '## 收尾自检（wrapup_check）',
      '当你认为一件开发任务已经做完、准备交付时，**先调用 `' + TOOL_NAME + '` 跑收尾自检**，不要直接说「搞定了」。',
      '流程：`action="start"` → `action="check"`（插件自动跑测试/lint/audit）→ 自己完成代码审查、构建验证、一致性检查 ' +
        '→ `action="report"` 如实汇报（有未修复的问题会被打回；有修复动作的轮次不计入「连续干净」）。',
      '规则：**连续 ' + DRY_ROUNDS + ' 轮全面检查零问题**才算收尾完成，届时会通知用户。',
      '不要在没跑的情况下宣称检查通过；不要为了尽快通过而漏报问题。',
    ].join('\n')
    promptCtx.effect(
      () => prompt.section({ name: 'wrapup-guard', order: 155, text }),
      'dsh-wrapup-guard: prompt section',
    )
  })
}
