/**
 * Browser half of the session-delete bundle.
 *
 * Adds one session context-menu action. The action opens a confirmation
 * dialog; confirming asks the Host to archive (hide) the session and queue its
 * files for deletion on the next DSH start.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'dsh-session-delete'
    const ROUTE = '/api/session-delete/request'

    const dicts = {
      zh: {
        'menu.delete': '删除会话…',
        'dialog.title': '删除这个会话？',
        'dialog.session': '会话：{title}',
        'dialog.untitled': '未命名会话',
        'dialog.body':
          'DSH 正在运行，无法立即删除该会话的存储文件。确认后，这个会话会先从左侧主列表隐藏，并加入删除队列。',
        'dialog.warning': '重新启动 DSH 后才会真正删除：届时会清理会话记录、缓存和相关文件。如果该会话正在生成回复或执行任务，会先停止它。',
        'dialog.archived':
          '重启之前，它仍会出现在“已归档”中；如果删除的是当前会话，界面会切回新会话。',
        'dialog.confirm': '隐藏并稍后删除',
        'dialog.working': '正在处理…',
        'dialog.cancel': '取消',
        'dialog.error': '安排删除失败：{message}',
        'toast.queued': '已隐藏；下次启动 DSH 时将彻底删除',
        'toast.gone': '会话已不存在；清理已排队',
        'toast.failure': '删除安排失败',
      },
      en: {
        'menu.delete': 'Delete session…',
        'dialog.title': 'Delete this session?',
        'dialog.session': 'Session: {title}',
        'dialog.untitled': 'Untitled session',
        'dialog.body':
          'DSH is running, so this session’s stored files cannot be deleted right now. After you confirm, the session is hidden from the main sidebar list and added to the deletion queue.',
        'dialog.warning':
          'The actual deletion happens the next time DSH starts: session records, cache entries, and related files are removed then. If the session is generating a reply or running a task, that work is stopped first.',
        'dialog.archived':
          'Until then it remains under “Archived”. If this is the current session, the view switches to a new session.',
        'dialog.confirm': 'Hide and delete later',
        'dialog.working': 'Working…',
        'dialog.cancel': 'Cancel',
        'dialog.error': 'Could not queue the deletion: {message}',
        'toast.queued': 'Hidden; it will be permanently deleted the next time DSH starts',
        'toast.gone': 'The session is already gone; cleanup is queued',
        'toast.failure': 'Could not queue the deletion',
      },
    }

    const CSS = `
.dsd-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgb(0 0 0 / 38%);
}
.dsd-dialog {
  width: min(460px, 100%);
  box-sizing: border-box;
  padding: 22px 22px 18px;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f2329);
  box-shadow: 0 18px 48px rgb(0 0 0 / 22%);
  outline: none;
}
.dsd-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.dsd-icon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--dsw-alias-state-error-primary, #d92d20);
  background: var(--dsw-alias-bg-l2, rgb(0 0 0 / 5%));
}
.dsd-heading {
  min-width: 0;
  flex: 1;
  padding-top: 5px;
}
.dsd-title {
  margin: 0;
  font-size: 15px;
  line-height: 1.4;
  font-weight: 600;
  letter-spacing: 0.005em;
}
.dsd-session {
  margin-top: 3px;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, #5c6370);
  font-size: 12px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsd-body {
  margin: 16px 0 0;
  color: var(--dsw-alias-label-secondary, #5c6370);
  font-size: 13px;
  line-height: 1.65;
}
.dsd-warning {
  display: flex;
  gap: 8px;
  margin: 14px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
  border-radius: 9px;
  background: var(--dsw-alias-bg-l2, rgb(0 0 0 / 4%));
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 12.5px;
  line-height: 1.6;
}
.dsd-warning-dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary, #d92d20);
}
.dsd-note {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-tertiary, #8a9099);
  font-size: 12px;
  line-height: 1.6;
}
.dsd-error {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-l2, rgb(0 0 0 / 4%));
  color: var(--dsw-alias-label-error, #d92d20);
  font-size: 12.5px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.dsd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
.dsd-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.dsd-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 5%));
}
.dsd-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #247bbf);
  outline-offset: 1px;
}
.dsd-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsd-btn-danger {
  border-color: transparent;
  background: var(--dsw-alias-state-error-primary, #d92d20);
  color: var(--dsw-alias-label-on-color, #fff);
}
.dsd-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-state-error-primary, #d92d20);
  filter: brightness(1.06);
}
@media (max-width: 480px) {
  .dsd-overlay { padding: 14px; }
  .dsd-dialog { padding: 18px 16px 15px; }
  .dsd-actions { flex-direction: column-reverse; }
  .dsd-btn { width: 100%; }
}
`

    let pending = null
    const listeners = new Set()

    function emit() {
      for (const listener of listeners) listener(pending)
    }

    function open(sessionId, displayTitle) {
      pending = { sessionId, displayTitle: displayTitle || '' }
      emit()
    }

    function close() {
      pending = null
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function makeDialog(ctx, t) {
      return function SessionDeleteDialog() {
        const [request, setRequest] = useState(pending)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState('')
        const dialogRef = useRef(null)
        const cancelRef = useRef(null)
        const returnFocusRef = useRef(null)
        const busyRef = useRef(false)

        useEffect(() => subscribe(setRequest), [])

        useEffect(() => {
          busyRef.current = busy
        }, [busy])

        useEffect(() => {
          if (request === null) return undefined
          setBusy(false)
          setError('')
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null

          const previousOverflow = document.body.style.overflow
          document.body.style.overflow = 'hidden'
          const timer = window.setTimeout(() => cancelRef.current?.focus(), 0)

          const onKeyDown = event => {
            if (event.key === 'Escape' && !busyRef.current) {
              event.preventDefault()
              close()
              return
            }
            if (event.key !== 'Tab') return
            const dialog = dialogRef.current
            if (dialog === null) return
            const focusable = Array.from(
              dialog.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            )
            if (focusable.length === 0) return
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }

          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            window.clearTimeout(timer)
            document.removeEventListener('keydown', onKeyDown, true)
            document.body.style.overflow = previousOverflow
            returnFocusRef.current?.focus?.()
          }
        }, [request])

        const onConfirm = useCallback(async () => {
          if (request === null || busy) return
          busyRef.current = true
          setBusy(true)
          setError('')
          try {
            const response = await fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId: request.sessionId,
                title: request.displayTitle,
              }),
            })
            const result = await response.json().catch(() => null)
            if (!response.ok) {
              throw new Error(result?.message || `HTTP ${response.status}`)
            }
            close()
            ctx.contextMenus.notify(
              result?.hidden === false ? t('toast.gone') : t('toast.queued'),
              true,
            )
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
            setError(t('dialog.error', { message }))
            ctx.contextMenus.notify(t('toast.failure'), false)
          } finally {
            busyRef.current = false
            setBusy(false)
          }
        }, [request, busy, ctx, t])

        if (request === null) return null

        const title = request.displayTitle || t('dialog.untitled')
        return h(
          'div',
          {
            className: 'dsd-overlay',
            onMouseDown: event => {
              if (event.target === event.currentTarget && !busy) close()
            },
          },
          h(
            'div',
            {
              ref: dialogRef,
              className: 'dsd-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'dsd-title',
              'aria-describedby': 'dsd-body',
              tabIndex: -1,
            },
            h(
              'div',
              { className: 'dsd-head' },
              h(
                'div',
                { className: 'dsd-icon', 'aria-hidden': 'true' },
                h(
                  'svg',
                  {
                    width: 19,
                    height: 19,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                  },
                  h('path', {
                    d: 'M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
                    stroke: 'currentColor',
                    strokeWidth: 1.7,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }),
                ),
              ),
              h(
                'div',
                { className: 'dsd-heading' },
                h('h2', { className: 'dsd-title', id: 'dsd-title' }, t('dialog.title')),
                h('div', { className: 'dsd-session', title }, t('dialog.session', { title })),
              ),
            ),
            h('p', { className: 'dsd-body', id: 'dsd-body' }, t('dialog.body')),
            h(
              'div',
              { className: 'dsd-warning' },
              h('span', { className: 'dsd-warning-dot', 'aria-hidden': 'true' }),
              h('span', null, t('dialog.warning')),
            ),
            h('p', { className: 'dsd-note' }, t('dialog.archived')),
            error !== '' ? h('div', { className: 'dsd-error', role: 'alert' }, error) : null,
            h(
              'div',
              { className: 'dsd-actions' },
              h(
                'button',
                {
                  ref: cancelRef,
                  type: 'button',
                  className: 'dsd-btn',
                  disabled: busy,
                  onClick: close,
                },
                t('dialog.cancel'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-btn dsd-btn-danger',
                  disabled: busy,
                  onClick: onConfirm,
                },
                busy ? t('dialog.working') : t('dialog.confirm'),
              ),
            ),
          ),
        )
      }
    }

    return {
      name: 'dsh-session-delete',
      inject: ['slots', 'locale', 'contextMenus'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-session-delete: locale')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshPlugin = 'dsh-session-delete'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-session-delete: styles')

        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'session.delete',
              target: 'session',
              order: 700,
              observe: () => [ctx.locale],
              resolve: target => [
                {
                  id: 'session.delete',
                  label: t('menu.delete'),
                  danger: true,
                  separatorBefore: true,
                  run: () => open(target.sessionId, target.displayTitle),
                },
              ],
            }),
          'dsh-session-delete: session menu',
        )

        const Dialog = makeDialog(ctx, t)
        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-delete-dialog', order: 1200 },
            Dialog,
          )
        })
      },
    }
  },
})
