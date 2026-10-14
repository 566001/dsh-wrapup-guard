# dsh-wrapup-guard · 收尾哨兵

> **EN** — A DeepSeek Harness plugin that turns "task finished" into a gate:
> it enforces a **check → fix → re-check** loop, auto-runs your command-class
> checks, **blocks any round that still has unfixed problems**, and only calls
> the task done after **three consecutive clean full checks** — then notifies the user.
> Built to stop the "good enough" hand-off.

一个 DeepSeek Harness 插件：**在任务收尾时强制「检查 → 修复 → 再检查」的循环，
直到连续三次全面检查都没有发现问题，才判定收尾完成并通知用户。**

它的存在意义只有一个：**拦住「差不多可以了」。**

---

## 它解决什么问题

AI 干完活常说「改好了」，但没跑测试、没看有没有引入回归、没核对文档。
这个插件把「收尾」变成一个有门槛的动作：

```
全面检查 → 发现问题 → 修复 → 再全面检查 → …
        ↑__________________________|
  直到连续 3 轮零问题 → 通知用户「收尾完成」
```

**只要有未修复的问题就必然被打回**；哪怕这轮只是修了个小 bug，也**不算干净**
（计数归零）。这样才不会被「边查边修、修完就说好了」糊弄过去。

---

## 分工

| 谁 | 负责什么 |
|---|---|
| **插件** | 轮次状态机、连续干净计数、**自动跑命令类检查**（测试 / lint / audit）、判定放行、通知用户 |
| **AI** | 代码审查、构建 / 运行验证、一致性检查，以及**真正的修复动作** |

插件是纯 JS，它没法「理解」代码审查发现的问题并动手修 —— 那是 AI 的活。
插件做的是**纪律**：计数、拦截、放行、报告。

---

## 用法

AI 在判断任务做完时调用 `wrapup_check`（也会在系统提示里被提醒这么做）：

| action | 作用 |
|---|---|
| `start` | 开始一次收尾自检，重置计数。会顺带**探测**项目里可自动运行的检查命令并告诉你。 |
| `check` | 插件自动跑命令类检查，把原始输出抓回来给你看。 |
| `report` | 汇报本轮**全面检查**的结论。必须带 `problems` 数组（空数组才表示干净）。 |
| `status` | 看当前轮次、连续干净计数、各轮摘要。 |
| `abort` | 放弃本次收尾。 |

`report` 的参数：

- `problems`：本轮发现的问题列表，每项 `{ kind, where, what, fixed }`。
  **有 `fixed !== true` 的项就会被立刻打回**；有修复动作的轮次不计入「连续干净」。
- `checks`：本轮你手动做过的检查类别（`review` / `build` / `consistency`）。
  缺项时插件会提醒你还有哪类没做。
- `summary`：本轮小结（会出现在最终报告里）。

### 自动探测哪些命令

在项目根目录按顺序找：

1. `package.json` 的 `scripts.test` / `scripts.lint` / `scripts.typecheck` / `scripts.check`
2. `tools/audit.js`、`tools/check.js`、`tools/selftest.mjs`

探测不到就返回「没有可自动运行的检查」——**这是合法结果**，不是错误，
意味着命令类检查要靠 AI 手动完成。

> **为什么 `check` 和 `selftest.mjs` 也在白名单里**：本插件自己的仓库用的就是
> `npm run check` + `tools/selftest.mjs`。旧白名单只认 `test`/`lint`/`typecheck`，
> 结果它连自己都检查不了，每次自检都报「没有可自动运行的检查」。
> 这两个名字同样是约定俗成的检查名，纳入白名单不是「猜脚本内容」。
>
> 仍然**不**做的是：扫描 `scripts` 里所有 key 全跑一遍。`check` 已经是最宽的
> 安全边界，再往外扩就可能跑到构建、发布之类有副作用的脚本。

### Windows 上怎么跑这些命令

`npm` 在 Windows 上只是 `npm.cmd` 批处理垫片，**没有可执行文件**，所以：

- 直接 `execFile('npm', …)` 会以 `ENOENT` 失败；
- `.cmd` 又因为 Node 24 的 CVE-2024-27980 补丁禁止带参数直跑（`EINVAL`）。

因此 Windows 下统一交给 `cmd.exe /d /s /c` 解析，并只给**确实需要**的
token 加引号（每个 token 都套引号反而会让 cmd 把 `""npm" "run""` 当成一个
整体命令名）。非 Windows 平台走原来的 `spawn` + 裸参数。

**超时必须杀整棵进程树**：npm → `cmd.exe` → `node` 是一条链，`child.kill()`
只放倒第一环，孙进程会继续持有 stdout 管道，`'close'` 要等它自己结束才触发
—— 超时就形同虚设（实测 2 秒超时拖到 60 秒才返回）。所以超时走
`taskkill /T /F`，并额外挂一个 5 秒兜底定时器，保证一定会收尾。

---

## 通知

达到「连续 3 轮零问题」时：

- 宿主端写一份完成记录，并通过 `/dsh-wrapup-guard/status` 暴露给浏览器端；
- 浏览器端轮询这个路由，右下角弹出**完成卡片**（含汇总：共几轮、修了几个问题、
  完整报告），12 秒后自动收成小徽章，点开可再看；
- 工具返回值里同时带完整报告，AI 会把它转述给用户。

---

## 安装

```jsonc
// profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-wrapup-guard": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-wrapup-guard"]
    }
  }
}
```

> 本地开发时依赖可写 `file:/absolute/path/to/dsh-wrapup-guard`；
> 从 npm 安装则直接写版本号。

然后在该 profile 目录用 DSH 自带的 pnpm 安装：

```bash
node <DSH>/resources/runtime/pnpm/bin/pnpm.cjs install --no-frozen-lockfile
```

> `file:` 依赖会被**复制**进 profile 的 `node_modules`，所以改了源码之后要重跑
> install 才能在 DSH 里生效。

**改完需要重启 DSH**（插件行的加载在启动时完成）。

---

## 自检

```bash
node tools/selftest.mjs          # 状态机 30 项断言（不打桩 DSH）
node tools/check-commands.mjs <项目路径>   # 验证自动探测 + 真实跑命令
```

---

## 设计取舍

- **不 import 任何 `@deepseek-ai/*`**：profile 安装的插件从自己的目录解析模块，
  harness 包在那里不可达。全部走 `ctx` 和 node 内置模块。
- **状态落盘**到 `~/.dsh/wrapup-guard/<sessionId>.json`：收尾循环会跨很多轮工具
  调用，DSH 中途重启也不该把计数丢掉 —— 否则 AI 会误以为「三轮干净」已达成。
- **每轮都必须重新做全面检查**，而不是只看刚改的地方：这正是「发现 → 解决 →
  检查 → 发现」循环的价值所在。
- 状态机对「漏报」没有任何自动化防御（AI 撒谎插件管不了），所以系统提示里
  明确写了诚实要求，且每轮会核对 AI 声明的检查类别是否齐全。

## License

MIT
