import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import type { SessionActiveItem } from '@hermes/shared/gateway-types'
import chalk from 'chalk'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  breatheLevel,
  buildSessionTabs,
  cycleSessionTab,
  nextAttentionTab,
  nextUnread,
  sessionTabGlyph,
  sessionTabKeyAction,
  sessionTabsRailWidth,
  sessionTabWindow
} from '../app/sessionTabsModel.js'
import {
  $sessionTabRows,
  $sessionTabUnread,
  applySessionTabsRoster,
  markSessionTabRead,
  refreshSessionTabs,
  resetSessionTabs
} from '../app/sessionTabsStore.js'
import { SessionTabsRail } from '../components/sessionTabsRail.js'
import { DEFAULT_THEME } from '../theme.js'

const row = (
  id: string,
  status: SessionActiveItem['status'],
  extra: Partial<SessionActiveItem> = {}
): SessionActiveItem => ({
  id,
  model: 'anthropic/claude-opus',
  started_at: Number(id.replace(/\D/g, '')) || 0,
  status,
  title: `task ${id}`,
  ...extra
})

const noKey = { ctrl: false, downArrow: false, meta: false, shift: false, upArrow: false }

describe('session tab model', () => {
  it('maps live status to the tab kind; waiting wins as attention', () => {
    const tabs = buildSessionTabs(
      [row('s1', 'idle'), row('s2', 'working'), row('s3', 'waiting'), row('s4', 'starting'), row('s5', 'idle')],
      's1',
      new Set(['s5']),
      'untitled'
    )

    expect(tabs.map(tab => [tab.number, tab.kind, tab.selected])).toEqual([
      [1, 'idle', true],
      [2, 'running', false],
      [3, 'attention', false],
      [4, 'starting', false],
      [5, 'unread', false]
    ])
    expect(tabs[0]!.model).toBe('claude-opus')
  })

  it('orders tabs oldest first so numbers stay put', () => {
    const tabs = buildSessionTabs([row('s9', 'idle'), row('s2', 'idle'), row('s5', 'idle')], null, new Set(), 'x')

    expect(tabs.map(tab => tab.id)).toEqual(['s2', 's5', 's9'])
  })

  it('falls back to the preview, then the untitled label', () => {
    const tabs = buildSessionTabs(
      [row('s1', 'idle', { preview: 'first prompt', title: '' }), row('s2', 'idle', { title: '  ' })],
      null,
      new Set(),
      'untitled'
    )

    expect(tabs.map(tab => tab.title)).toEqual(['first prompt', 'untitled'])
  })

  it('marks a session unread when it goes idle off screen, never the one on screen', () => {
    const before = new Map([
      ['s1', 'working'],
      ['s2', 'waiting'],
      ['s3', 'idle']
    ])

    const unread = nextUnread(before, [row('s1', 'idle'), row('s2', 'idle'), row('s3', 'idle')], 's2', new Set())

    expect([...unread]).toEqual(['s1'])
  })

  it('keeps unread until the session is shown or leaves the roster', () => {
    const first = new Set(['s1', 's2'])

    expect(nextUnread(new Map(), [row('s1', 'idle'), row('s2', 'idle')], null, first)).toBe(first)
    expect([...nextUnread(new Map(), [row('s1', 'idle'), row('s2', 'idle')], 's1', first)]).toEqual(['s2'])
    expect([...nextUnread(new Map(), [row('s2', 'idle')], null, first)]).toEqual(['s2'])
  })

  it('cycles with wrap and finds the next tab that wants you, waiting before unread', () => {
    const tabs = buildSessionTabs(
      [row('s1', 'idle'), row('s2', 'idle'), row('s3', 'waiting'), row('s4', 'idle')],
      's2',
      new Set(['s1']),
      'x'
    )

    expect(cycleSessionTab(tabs, 1)).toBe('s3')
    expect(cycleSessionTab(tabs, -1)).toBe('s1')
    expect(nextAttentionTab(tabs, 1)).toBe('s3')
    expect(nextAttentionTab(tabs, -1)).toBe('s3')

    const none = buildSessionTabs([row('s1', 'idle'), row('s2', 'idle')], 's1', new Set(), 'x')
    expect(nextAttentionTab(none, 1)).toBeNull()
    expect(cycleSessionTab(none.slice(0, 1), 1)).toBeNull()
  })

  it('reads Alt+arrows and Alt+digits, and nothing without Alt', () => {
    expect(sessionTabKeyAction('', { ...noKey, downArrow: true, meta: true })).toEqual({ dir: 1, kind: 'cycle' })
    expect(sessionTabKeyAction('', { ...noKey, meta: true, shift: true, upArrow: true })).toEqual({
      dir: -1,
      kind: 'attention'
    })
    expect(sessionTabKeyAction('3', { ...noKey, meta: true })).toEqual({ kind: 'select', number: 3 })
    expect(sessionTabKeyAction('3', noKey)).toBeNull()
    expect(sessionTabKeyAction('', { ...noKey, downArrow: true })).toBeNull()
    expect(sessionTabKeyAction('0', { ...noKey, meta: true })).toBeNull()
  })

  it('sizes the rail 20-30 columns and hides it on narrow terminals', () => {
    expect(sessionTabsRailWidth(60)).toBe(0)
    expect(sessionTabsRailWidth(80)).toBe(20)
    expect(sessionTabsRailWidth(120)).toBe(26)
    expect(sessionTabsRailWidth(300)).toBe(30)
  })

  it('windows the tabs around the selected one and counts hidden waiting tabs', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`s${i + 1}`, i === 0 || i === 11 ? 'waiting' : 'idle'))
    const pick = (sid: string) => buildSessionTabs(rows, sid, new Set(), 'x')

    expect(sessionTabWindow(pick('s1'), 100)).toMatchObject({ after: 0, before: 0, end: 12, start: 0 })

    // 14 rows: markers take 2, so 4 tabs of 3 rows fit.
    const top = sessionTabWindow(pick('s2'), 14)
    expect(top).toMatchObject({ after: 8, afterWaiting: 1, before: 0, end: 4, start: 0 })

    const bottom = sessionTabWindow(pick('s10'), 14, top.start)
    expect(bottom).toMatchObject({ before: 6, beforeWaiting: 1, end: 10, start: 6 })

    // Moving within the window keeps it still.
    expect(sessionTabWindow(pick('s8'), 14, bottom.start).start).toBe(6)
  })

  it('draws a glyph per state and a bounded breathing level', () => {
    expect(['attention', 'starting', 'unread', 'idle'].map(kind => sessionTabGlyph(kind as never, 0))).toEqual([
      '?',
      '…',
      '•',
      ' '
    ])
    expect(sessionTabGlyph('running', 1)).not.toBe(sessionTabGlyph('running', 0))

    for (let frame = 0; frame < 60; frame++) {
      expect(breatheLevel(frame)).toBeGreaterThanOrEqual(0)
      expect(breatheLevel(frame)).toBeLessThanOrEqual(1)
    }
  })
})

describe('session tab store', () => {
  beforeEach(resetSessionTabs)

  it('writes only on change and tracks unread across polls', () => {
    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'working')], 's1')
    const rows = $sessionTabRows.get()

    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'working')], 's1')
    expect($sessionTabRows.get()).toBe(rows)

    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'idle')], 's1')
    expect([...$sessionTabUnread.get()]).toEqual(['s2'])

    markSessionTabRead('s2')
    expect($sessionTabUnread.get().size).toBe(0)
  })

  it('reads a running-only roster row as working', () => {
    applySessionTabsRoster([{ id: 's1', running: true } as never], null)

    expect($sessionTabRows.get()[0]!.status).toBe('working')
  })

  it('asks session.active_list on the shared gateway for the waiting state', async () => {
    const calls: string[] = []

    const gw = {
      isCanonical: true,
      request: async (method: string) => {
        calls.push(method)

        return { sessions: [row('s1', 'waiting')] }
      }
    }

    await refreshSessionTabs(gw as never, [{ id: 's1', running: true } as never], null)

    expect(calls).toEqual(['session.active_list'])
    expect($sessionTabRows.get()[0]!.status).toBe('waiting')
  })

  it('falls back to the roster when session.active_list fails', async () => {
    const gw = {
      isCanonical: true,
      request: async () => {
        throw new Error('nope')
      }
    }

    await refreshSessionTabs(gw as never, [{ id: 's1', running: true } as never], null)

    expect($sessionTabRows.get()[0]!.status).toBe('working')
  })
})

describe('session tab rail', () => {
  const colorLevel = chalk.level

  beforeEach(() => {
    chalk.level = 3
    resetSessionTabs()
  })
  afterEach(() => {
    chalk.level = colorLevel
  })

  it('renders numbered tabs with the waiting marker in the warning color', () => {
    $sessionTabRows.set([row('s1', 'idle'), row('s2', 'waiting'), row('s3', 'working')])

    const stdout = Object.assign(new PassThrough(), { columns: 26, rows: 20 })
    const frames: string[] = []
    stdout.on('data', chunk => frames.push(chunk.toString()))

    const view = renderSync(
      <SessionTabsRail currentSessionId="s1" onNew={() => {}} onSelect={() => {}} t={DEFAULT_THEME} width={26} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new PassThrough() as NodeJS.ReadStream }
    )

    view.unmount()
    view.cleanup()

    const raw = frames.join('')
    const text = stripAnsi(raw)

    expect(text).toContain('Sessions')
    expect(text).toContain('1 waiting')
    expect(text).toContain('task s1')
    expect(text).toMatch(/2\?/)
    expect(text).toContain('+ new session')

    const [r, g, b] = DEFAULT_THEME.color.warn.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
    expect(raw).toContain(`38;2;${r};${g};${b}m`)
  })
})
