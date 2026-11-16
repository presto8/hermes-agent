import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import type { SessionActiveItem } from '@hermes/shared/gateway-types'
import chalk from 'chalk'
import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $overlayState, patchOverlayState } from '../app/overlayStore.js'
import { closeSessionTabAt, newSessionTab, selectSessionTab, wrapPickerForTabs } from '../app/sessionTabsActions.js'
import {
  bindSession,
  breatheLevel,
  buildSessionTabs,
  closeTab,
  cycleSessionTab,
  initialTabs,
  markPending,
  nextAttentionTab,
  nextUnread,
  openTab,
  PENDING,
  pickerClosed,
  sessionTabGlyph,
  sessionTabKeyAction,
  sessionTabsRailWidth,
  sessionTabWindow,
  type TabsState
} from '../app/sessionTabsModel.js'
import {
  $sessionTabRows,
  $sessionTabs,
  $sessionTabUnread,
  applySessionTabsRoster,
  noteSessionPickerClosed,
  noteSessionShown,
  refreshSessionTabs,
  resetSessionTabs
} from '../app/sessionTabsStore.js'
import { patchUiState } from '../app/uiStore.js'
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

const labels = { closed: 'closed', opening: 'opening…', picking: 'pick a session…', untitled: 'untitled' }
const ids = (state: TabsState) => state.slots.map(slot => slot.sessionId)
const noKey = { ctrl: false, downArrow: false, meta: false, shift: false, upArrow: false }

/** Tabs holding `sids`, the `active`th current. */
const tabsOf = (sids: string[], active = 0): TabsState => {
  let state = bindSession(initialTabs(), sids[0]!)

  for (const sid of sids.slice(1)) {
    state = bindSession(openTab(state), sid)
  }

  return { ...state, active }
}

describe('tab slots', () => {
  it('fills the first tab with the first session shown, and the picker replaces it in place', () => {
    const first = bindSession(initialTabs(), 's1')
    expect(ids(first)).toEqual(['s1'])

    const replaced = bindSession(first, 's2')
    expect(ids(replaced)).toEqual(['s2'])
    expect(replaced.active).toBe(0)
  })

  it('opens a new tab empty and fills it from the picker', () => {
    const opened = openTab(tabsOf(['s1']))
    expect(ids(opened)).toEqual(['s1', null])
    expect(opened.active).toBe(1)

    const filled = bindSession(opened, 's2')
    expect(ids(filled)).toEqual(['s1', 's2'])
    expect(filled.active).toBe(1)
  })

  it('drops a new tab when the picker closes without a pick, back to where it came from', () => {
    const opened = openTab(tabsOf(['s1', 's2'], 0))
    const back = pickerClosed(opened)

    expect(ids(back)).toEqual(['s1', 's2'])
    expect(back.active).toBe(0)
    expect(pickerClosed(tabsOf(['s1']))).toEqual(tabsOf(['s1']))
  })

  it('keeps a tab held for a new session through the picker closing', () => {
    const pending = markPending(openTab(tabsOf(['s1'])))
    const closed = pickerClosed(pending)

    expect(ids(closed)).toEqual(['s1', PENDING])
    expect(ids(bindSession(closed, 's9'))).toEqual(['s1', 's9'])
  })

  it('focuses a tab that already holds the picked session instead of duplicating it', () => {
    const state = openTab(tabsOf(['s1', 's2'], 0))
    const picked = bindSession(state, 's1')

    expect(ids(picked)).toEqual(['s1', 's2'])
    expect(picked.active).toBe(0)

    // Same when the view reports the session by its stored id.
    expect(bindSession(tabsOf(['stored-1', 's2'], 1), 'live-1', 'stored-1').active).toBe(0)
  })

  it('closes a tab and hands back the neighbour to show; never closes the last one', () => {
    const { focus, state } = closeTab(tabsOf(['s1', 's2', 's3'], 1), 1)
    expect(ids(state)).toEqual(['s1', 's3'])
    expect(focus).toBe(1)

    const other = closeTab(tabsOf(['s1', 's2', 's3'], 2), 0)
    expect(other.focus).toBeNull()
    expect(other.state.active).toBe(1)

    expect(closeTab(tabsOf(['s1']), 0).state.slots).toHaveLength(1)
  })

  it('builds rows with status from the live roster, and remembers closed sessions', () => {
    let state = tabsOf(['s1', 's2', 's3', 's4', 's5', 'gone'], 0)
    state = { ...state, slots: state.slots.map(s => (s.sessionId === 'gone' ? { ...s, title: 'old task' } : s)) }

    const tabs = buildSessionTabs(
      state,
      [row('s1', 'idle'), row('s2', 'working'), row('s3', 'waiting'), row('s4', 'starting'), row('s5', 'idle')],
      new Set(['s5']),
      labels
    )

    expect(tabs.map(tab => [tab.number, tab.kind])).toEqual([
      [1, 'idle'],
      [2, 'running'],
      [3, 'attention'],
      [4, 'starting'],
      [5, 'unread'],
      [6, 'closed']
    ])
    expect(tabs[0]!.model).toBe('claude-opus')
    expect(tabs[5]!.title).toBe('old task')
    expect(tabs[5]!.model).toBe('closed')
  })

  it('labels an unfilled tab and a tab waiting for its new session', () => {
    const tabs = buildSessionTabs(markPending(openTab(openTab(tabsOf(['s1'])))), [row('s1', 'idle')], new Set(), labels)

    expect(tabs.map(tab => [tab.kind, tab.title])).toEqual([
      ['idle', 'task s1'],
      ['empty', 'pick a session…'],
      ['empty', 'opening…']
    ])
  })
})

describe('tab navigation', () => {
  const rows = [row('s1', 'idle'), row('s2', 'idle'), row('s3', 'waiting'), row('s4', 'idle')]

  it('cycles with wrap and finds the next tab that wants you, waiting before unread', () => {
    const tabs = buildSessionTabs(tabsOf(['s1', 's2', 's3', 's4'], 1), rows, new Set(['s1']), labels)

    expect(cycleSessionTab(tabs, 1)).toBe(2)
    expect(cycleSessionTab(tabs, -1)).toBe(0)
    expect(nextAttentionTab(tabs, 1)).toBe(2)
    expect(nextAttentionTab(tabs, -1)).toBe(2)

    const quiet = buildSessionTabs(tabsOf(['s1', 's2']), [row('s1', 'idle'), row('s2', 'idle')], new Set(), labels)
    expect(nextAttentionTab(quiet, 1)).toBeNull()
    expect(cycleSessionTab(quiet.slice(0, 1), 1)).toBeNull()
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
    const sids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`)
    const live = sids.map((sid, i) => row(sid, i === 0 || i === 11 ? 'waiting' : 'idle'))
    const pick = (active: number) => buildSessionTabs(tabsOf(sids, active), live, new Set(), labels)

    expect(sessionTabWindow(pick(0), 100)).toMatchObject({ after: 0, before: 0, end: 12, start: 0 })

    // 14 rows: markers take 2, so 4 tabs of 3 rows fit.
    const top = sessionTabWindow(pick(1), 14)
    expect(top).toMatchObject({ after: 8, afterWaiting: 1, before: 0, end: 4, start: 0 })

    const bottom = sessionTabWindow(pick(9), 14, top.start)
    expect(bottom).toMatchObject({ before: 6, beforeWaiting: 1, end: 10, start: 6 })
    expect(sessionTabWindow(pick(7), 14, bottom.start).start).toBe(6)
  })

  it('draws a glyph per state and a bounded breathing level', () => {
    expect(
      ['attention', 'starting', 'empty', 'unread', 'idle', 'closed'].map(k => sessionTabGlyph(k as never, 0))
    ).toEqual(['?', '…', '…', '•', ' ', ' '])
    expect(sessionTabGlyph('running', 1)).not.toBe(sessionTabGlyph('running', 0))

    for (let frame = 0; frame < 60; frame++) {
      expect(breatheLevel(frame)).toBeGreaterThanOrEqual(0)
      expect(breatheLevel(frame)).toBeLessThanOrEqual(1)
    }
  })

  it('marks a session unread when it goes idle off screen, never the one on screen', () => {
    const before = new Map([
      ['s1', 'working'],
      ['s2', 'waiting'],
      ['s3', 'idle']
    ])

    expect([...nextUnread(before, [row('s1', 'idle'), row('s2', 'idle'), row('s3', 'idle')], 's2', new Set())]).toEqual(
      ['s1']
    )
  })
})

describe('tab store and actions', () => {
  const actions = { activateLiveSession: vi.fn(), resumeById: vi.fn() }

  beforeEach(() => {
    resetSessionTabs()
    patchOverlayState({ sessions: false })
    patchUiState({ sid: null, storedSid: null })
    actions.activateLiveSession.mockReset()
    actions.resumeById.mockReset()
  })

  it('"+ new tab" opens the picker; a pick fills the tab; cancelling drops it', () => {
    noteSessionShown('s1')
    newSessionTab()
    expect($overlayState.get().sessions).toBe(true)
    expect(ids($sessionTabs.get())).toEqual(['s1', null])

    const picker = wrapPickerForTabs({
      onActiveSessionSelect: actions.activateLiveSession,
      onNewLiveSession: vi.fn(),
      onNewPromptSession: vi.fn(),
      onResumeSelect: actions.resumeById
    })

    picker.onActiveSessionSelect('s2')
    expect(actions.activateLiveSession).toHaveBeenCalledWith('s2')
    expect(ids($sessionTabs.get())).toEqual(['s1', 's2'])

    newSessionTab()
    noteSessionPickerClosed()
    expect(ids($sessionTabs.get())).toEqual(['s1', 's2'])
  })

  it('selecting a tab activates a live session, resumes a closed one, re-opens the picker for an empty one', () => {
    noteSessionShown('s1')
    newSessionTab()
    noteSessionShown('s2')
    patchUiState({ sid: 's2' })
    applySessionTabsRoster([row('s2', 'idle')], 's2')

    selectSessionTab(0, actions)
    expect(actions.resumeById).toHaveBeenCalledWith('s1')

    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'idle')], 's2')
    selectSessionTab(0, actions)
    expect(actions.activateLiveSession).toHaveBeenCalledWith('s1')

    newSessionTab()
    patchOverlayState({ sessions: false })
    selectSessionTab(2, actions)
    expect($overlayState.get().sessions).toBe(true)
  })

  it('closing the current tab shows its neighbour', () => {
    noteSessionShown('s1')
    newSessionTab()
    noteSessionShown('s2')
    patchUiState({ sid: 's2' })
    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'idle')], 's2')

    closeSessionTabAt(1, actions)
    expect(ids($sessionTabs.get())).toEqual(['s1'])
    expect(actions.activateLiveSession).toHaveBeenCalledWith('s1')
  })

  it('writes the rows only on change and tracks unread across polls', () => {
    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'working')], 's1')
    const rows = $sessionTabRows.get()

    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'working')], 's1')
    expect($sessionTabRows.get()).toBe(rows)

    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'idle')], 's1')
    expect([...$sessionTabUnread.get()]).toEqual(['s2'])

    noteSessionShown('s2')
    expect($sessionTabUnread.get().size).toBe(0)
  })

  it('asks session.active_list on the shared gateway for the waiting state, falling back to the roster', async () => {
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

    const broken = { isCanonical: true, request: async () => Promise.reject(new Error('nope')) }
    await refreshSessionTabs(broken as never, [{ id: 's1', running: true } as never], null)
    expect($sessionTabRows.get()[0]!.status).toBe('working')
  })
})

describe('tab rail', () => {
  const colorLevel = chalk.level

  beforeEach(() => {
    chalk.level = 3
    resetSessionTabs()
  })
  afterEach(() => {
    chalk.level = colorLevel
  })

  it('shows only the opened tabs, with the waiting marker in the warning color', () => {
    noteSessionShown('s1')
    newSessionTab()
    noteSessionShown('s2')
    applySessionTabsRoster([row('s1', 'idle'), row('s2', 'waiting'), row('s3', 'working'), row('s4', 'idle')], 's1')

    const stdout = Object.assign(new PassThrough(), { columns: 26, rows: 24 })
    const frames: string[] = []
    stdout.on('data', chunk => frames.push(chunk.toString()))

    const view = renderSync(
      <SessionTabsRail onClose={() => {}} onNew={() => {}} onSelect={() => {}} t={DEFAULT_THEME} width={26} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new PassThrough() as NodeJS.ReadStream }
    )

    view.unmount()
    view.cleanup()

    const raw = frames.join('')
    const text = stripAnsi(raw)

    expect(text).toContain('Tabs')
    expect(text).toContain('1 waiting')
    expect(text).toContain('task s1')
    expect(text).toMatch(/2\?/)
    expect(text).not.toContain('task s3')
    expect(text).not.toContain('task s4')
    expect(text).toContain('×')
    expect(text).toContain('+ new tab')

    const [r, g, b] = DEFAULT_THEME.color.warn.match(/[0-9a-f]{2}/gi)!.map(h => parseInt(h, 16))
    expect(raw).toContain(`38;2;${r};${g};${b}m`)
  })
})
