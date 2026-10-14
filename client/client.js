// dsh-wrapup-guard — client half（收尾哨兵 · 浏览器端）
//
// 宿主端在收尾自检达到「连续 N 轮零问题」时会写一份完成记录；这一半负责把它
// 变成一个用户看得见的通知：右下角弹一张卡片（含汇总），几秒后自动收成小徽章，
// 点开可以再看完整报告。
//
// 为什么用「轮询宿主路由」而不是事件总线：客户端 bundle 拿不到宿主的 emit
// 通道（那需要额外声明注入 + 版本耦合），而一条自己的 JSON 路由是最稳的——
// 宿主重启、页面刷新都能自愈，不需要重连握手。

window.__ModuleLoader__.load({
  id: 'dsh-wrapup-guard',
  factory: (require) => {
    const ROUTE = '/dsh-wrapup-guard/status'
    const POLL_MS = 4000

    const CSS = `
      .dslw-stack{position:fixed;right:18px;bottom:18px;z-index:2147483600;display:flex;flex-direction:column;gap:10px;max-width:min(92vw,420px);pointer-events:none}
      .dslw-card{pointer-events:auto;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.28);overflow:hidden;font-size:13px;line-height:1.55;animation:dslw-in .28s ease-out}
      @keyframes dslw-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
      .dslw-head{display:flex;align-items:center;gap:8px;padding:11px 13px;font-weight:600;background:linear-gradient(180deg,color-mix(in srgb,CanvasText 6%,Canvas),Canvas)}
      .dslw-dot{width:9px;height:9px;border-radius:50%;background:#2ecc71;flex:0 0 auto;box-shadow:0 0 0 3px color-mix(in srgb,#2ecc71 25%,transparent)}
      .dslw-head b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dslw-x{flex:0 0 auto;border:none;background:none;color:inherit;opacity:.55;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}
      .dslw-x:hover{opacity:1}
      .dslw-body{padding:0 13px 12px}
      .dslw-meta{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 8px}
      .dslw-pill{font-size:11px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,CanvasText 8%,Canvas);border:1px solid color-mix(in srgb,CanvasText 14%,transparent)}
      .dslw-report{white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;max-height:230px;overflow:auto;padding:9px 10px;border-radius:9px;background:color-mix(in srgb,CanvasText 5%,Canvas);border:1px solid color-mix(in srgb,CanvasText 12%,transparent)}
      .dslw-toggle{margin-top:8px;font-size:11.5px;opacity:.72;cursor:pointer;user-select:none}
      .dslw-toggle:hover{opacity:1}
      .dslw-mini{pointer-events:auto;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:999px;box-shadow:0 8px 22px rgba(0,0,0,.24);padding:7px 14px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:7px;animation:dslw-in .28s ease-out}
      .dslw-mini:hover{border-color:color-mix(in srgb,CanvasText 34%,transparent)}
    `

    let stack = null
    let lastSeen = null
    let pollTimer = null
    let minimized = null

    function ensureStack() {
      if (stack !== null && document.body.contains(stack)) return stack
      stack = document.createElement('div')
      stack.className = 'dslw-stack'
      document.body.appendChild(stack)
      return stack
    }

    function summaryLine(record) {
      const parts = []
      if (typeof record.rounds === 'number') parts.push('共 ' + record.rounds + ' 轮')
      if (typeof record.fixedTotal === 'number' && record.fixedTotal > 0) parts.push('修复 ' + record.fixedTotal + ' 个问题')
      if (typeof record.problemsTotal === 'number') parts.push('累计发现 ' + record.problemsTotal + ' 个')
      return parts
    }

    function showCard(record) {
      const host = ensureStack()
      if (minimized !== null) { minimized.remove(); minimized = null }

      const card = document.createElement('div')
      card.className = 'dslw-card'
      card.setAttribute('role', 'status')

      const head = document.createElement('div')
      head.className = 'dslw-head'
      const dot = document.createElement('span')
      dot.className = 'dslw-dot'
      const title = document.createElement('b')
      title.textContent = '收尾自检通过'
      const close = document.createElement('button')
      close.className = 'dslw-x'
      close.type = 'button'
      close.setAttribute('aria-label', '关闭')
      close.textContent = '×'
      close.addEventListener('click', () => card.remove())
      head.append(dot, title, close)

      const body = document.createElement('div')
      body.className = 'dslw-body'

      const meta = document.createElement('div')
      meta.className = 'dslw-meta'
      for (const text of summaryLine(record)) {
        const pill = document.createElement('span')
        pill.className = 'dslw-pill'
        pill.textContent = text
        meta.appendChild(pill)
      }
      const timePill = document.createElement('span')
      timePill.className = 'dslw-pill'
      timePill.textContent = new Date(record.finishedAt || Date.now()).toLocaleTimeString()
      meta.appendChild(timePill)

      const report = document.createElement('div')
      report.className = 'dslw-report'
      report.textContent = typeof record.report === 'string' && record.report !== '' ? record.report : '（无报告内容）'

      body.append(meta, report)
      card.append(head, body)
      host.appendChild(card)

      // 12 秒后自动收成一个小徽章，点开可再看一次报告（不丢掉结果）。
      const auto = setTimeout(() => minimize(card, record, host), 12000)
      card.addEventListener('mouseenter', () => clearTimeout(auto))
      return card
    }

    function minimize(card, record, host) {
      if (!document.body.contains(card)) return
      card.remove()
      if (minimized !== null) return
      const mini = document.createElement('button')
      mini.className = 'dslw-mini'
      mini.type = 'button'
      const dot = document.createElement('span')
      dot.className = 'dslw-dot'
      const label = document.createElement('span')
      label.textContent = '收尾自检通过'
      mini.append(dot, label)
      mini.addEventListener('click', () => {
        mini.remove()
        minimized = null
        const again = showCard(record)
        // 手动打开的不再自动收起。
        setTimeout(() => { if (document.body.contains(again)) return }, 0)
      })
      host.appendChild(mini)
      minimized = mini
    }

    async function poll() {
      try {
        const res = await fetch(ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        const record = data !== null && typeof data === 'object' ? data.latest : null
        if (record === null || record === undefined) return
        const key = String(record.finishedAt || '') + '|' + String(record.sessionId || '')
        if (key === lastSeen) return
        lastSeen = key
        showCard(record)
      } catch {
        /* 宿主还没就绪或页面正在卸载：下一轮再试 */
      }
    }

    const module = { exports: {} }
    const exports = module.exports

    exports.apply = function apply(ctx) {
      ctx.effect(
        () => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-wrapup-guard')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        },
        'dsh-wrapup-guard: styles',
      )

      ctx.effect(() => {
        // 首轮延迟一点：页面刚加载时宿主路由可能还没挂上。
        const boot = setTimeout(poll, 1500)
        pollTimer = setInterval(poll, POLL_MS)
        return () => {
          clearTimeout(boot)
          clearInterval(pollTimer)
          pollTimer = null
          if (stack !== null) { stack.remove(); stack = null }
          if (minimized !== null) { minimized.remove(); minimized = null }
        }
      }, 'dsh-wrapup-guard: completion poller')
    }

    return module.exports
  },
})
