/**
 * Pure rules for the vertical session-tab rail (`display.tui_session_tabs`).
 *
 * Modeled on OpenCode's TUI session tabs (anomalyco/opencode #39396, #39428, #40072). Tabs are
 * slots the user fills: whatever session the view switches to (the session picker, `/resume`,
 * `/new`) takes over the current tab; "+ new tab" opens a tab with a new live session in it;
 * closing a tab only takes it off the rail (the session keeps running and stays in the picker).
 * Each tab shows a status that tells "needs you" apart from "working" and "finished while you
 * were away".
 *
 * Hermes reports a live session's status as `idle | starting | waiting | working`; `waiting` means
 * an approval, clarify, sudo, secret or vault prompt holds the turn (the same state the terminal
 * title marks with `⚠`). A child agent's prompt surfaces on its parent session, so the parent's
 * status already covers its family (OpenCode aggregates the family explicitly).
 */
import type { SessionActiveItem } from '@hermes/shared/gateway-types'

/** A tab's session: an id, `null` while the picker is open to fill a new tab, or `PENDING` once a
 *  pick that has no id yet (a brand-new session) is on its way. */
export const PENDING = '\u0000pending'

export interface TabSlot {
  key: number
  model?: string
  sessionId: null | string
  title?: string
}

export interface TabsState {
  active: number
  nextKey: number
  /** The tab to go back to when the picker opened for a new tab closes without a pick. */
  returnTo: null | number
  slots: TabSlot[]
}

export const initialTabs = (): TabsState => ({
  active: 0,
  nextKey: 1,
  returnTo: null,
  slots: [{ key: 0, sessionId: null }]
})

const clampActive = (state: TabsState, active: number): TabsState => ({
  ...state,
  active: Math.max(0, Math.min(active, state.slots.length - 1))
})

const isOpen = (sessionId: null | string): sessionId is string => sessionId !== null && sessionId !== PENDING

const findSlot = (slots: readonly TabSlot[], ids: readonly (null | string | undefined)[]) =>
  slots.findIndex(slot => isOpen(slot.sessionId) && ids.includes(slot.sessionId))

const dropSlot = (state: TabsState, index: number): TabsState =>
  clampActive(
    { ...state, slots: state.slots.filter((_, i) => i !== index) },
    state.active > index ? state.active - 1 : state.active
  )

/**
 * The view now shows session `sid` (`storedSid` is its stored id when that differs). A tab that
 * already holds it gets focus, and an unfilled tab left over from "+ new tab" closes. Otherwise
 * the session takes over the current tab.
 */
export function bindSession(state: TabsState, sid: null | string, storedSid?: null | string): TabsState {
  if (!sid) {
    return state
  }

  const current = state.slots[state.active]
  const existing = findSlot(state.slots, [sid, storedSid])

  if (existing === state.active) {
    return current?.sessionId === sid && state.returnTo === null
      ? state
      : {
          ...state,
          returnTo: null,
          slots: state.slots.map((slot, i) => (i === existing ? { ...slot, sessionId: sid } : slot))
        }
  }

  if (existing !== -1) {
    const moved = { ...clampActive(state, existing), returnTo: null }

    return current && !isOpen(current.sessionId) ? dropSlot(moved, state.active) : moved
  }

  return {
    ...state,
    returnTo: null,
    slots: state.slots.map((slot, i) => (i === state.active ? { key: slot.key, sessionId: sid } : slot))
  }
}

/** A pick whose session id isn't known yet (a new session): hold the current tab for it. */
export const markPending = (state: TabsState): TabsState => ({
  ...state,
  slots: state.slots.map((slot, i) => (i === state.active ? { key: slot.key, sessionId: PENDING } : slot))
})

/** An empty tab after the last one, focused: "+ new tab" fills it with a new session. */
export function openTab(state: TabsState): TabsState {
  const slots = [...state.slots, { key: state.nextKey, sessionId: null }]

  return { active: slots.length - 1, nextKey: state.nextKey + 1, returnTo: state.active, slots }
}

/** The new session meant for tab `key` never arrived. A tab still waiting for it goes away, and
 *  focus goes back to where "+ new tab" was clicked when that tab was current. */
export function abandonTab(state: TabsState, key: number): TabsState {
  const index = state.slots.findIndex(slot => slot.key === key)

  if (index === -1 || state.slots[index]!.sessionId !== PENDING || state.slots.length < 2) {
    return state
  }

  if (index !== state.active) {
    return dropSlot(state, index)
  }

  const back = state.returnTo ?? index - 1
  const dropped = dropSlot(state, index)

  return { ...clampActive(dropped, back > index ? back - 1 : back), returnTo: null }
}

/** The picker closed. A new tab it was opened for that got no pick goes away again. */
export function pickerClosed(state: TabsState): TabsState {
  if (state.slots[state.active]?.sessionId !== null || state.slots.length < 2) {
    return state.returnTo === null ? state : { ...state, returnTo: null }
  }

  const back = state.returnTo ?? state.active - 1
  const dropped = dropSlot(state, state.active)

  return { ...clampActive(dropped, back > state.active ? back - 1 : back), returnTo: null }
}

/** Close tab `index` (never the last one). `focus` is the tab the view should switch to when the
 *  closed tab was the current one. */
export function closeTab(state: TabsState, index: number): { focus: null | number; state: TabsState } {
  if (state.slots.length < 2 || !state.slots[index]) {
    return { focus: null, state }
  }

  const wasActive = index === state.active
  const dropped = dropSlot(state, index)

  const next = {
    ...clampActive(dropped, wasActive ? Math.min(index, dropped.slots.length - 1) : dropped.active),
    returnTo: null
  }

  return { focus: wasActive ? next.active : null, state: next }
}

export const rowFor = (rows: readonly SessionActiveItem[], sessionId: null | string) =>
  isOpen(sessionId) ? rows.find(row => row.id === sessionId || row.session_key === sessionId) : undefined

/** Remember each tab session's title and model while it's live, for after it closes. */
export function rememberRows(state: TabsState, rows: readonly SessionActiveItem[]): TabsState {
  let changed = false

  const slots = state.slots.map(slot => {
    const row = rowFor(rows, slot.sessionId)
    const title = row?.title?.trim() || slot.title
    const model = row?.model || slot.model

    if (!row || (title === slot.title && model === slot.model)) {
      return slot
    }

    changed = true

    return { ...slot, model, title }
  })

  return changed ? { ...state, slots } : state
}

export type SessionTabKind = 'attention' | 'closed' | 'empty' | 'idle' | 'running' | 'starting' | 'unread'

export interface SessionTab {
  index: number
  kind: SessionTabKind
  model: string
  number: number
  selected: boolean
  sessionId: null | string
  title: string
}

/** Rail width for a terminal `cols` wide: OpenCode's responsive 20-30 column rail. 0 hides it on
 *  terminals too narrow to keep a usable transcript beside it. */
export const SESSION_TABS_MIN_COLS = 72
export const SESSION_TABS_MIN_WIDTH = 20
export const SESSION_TABS_MAX_WIDTH = 30

export const sessionTabsRailWidth = (cols: number): number =>
  cols < SESSION_TABS_MIN_COLS
    ? 0
    : Math.max(SESSION_TABS_MIN_WIDTH, Math.min(SESSION_TABS_MAX_WIDTH, Math.floor(cols * 0.22)))

const BUSY = new Set(['starting', 'waiting', 'working'])

/**
 * The unread set after one poll. A session that was busy on the last poll, is idle now and is not
 * the one on screen finished while you were away: mark it. The session on screen is always read.
 * Sessions that left the roster drop out. Returns the same Set when nothing changed, so callers
 * can skip a store write.
 */
export function nextUnread(
  previous: ReadonlyMap<string, string>,
  rows: readonly SessionActiveItem[],
  current: null | string,
  unread: ReadonlySet<string>
): ReadonlySet<string> {
  const next = new Set<string>()

  for (const row of rows) {
    if (row.id === current || row.current) {
      continue
    }

    const was = previous.get(row.id)

    if (unread.has(row.id) || (was !== undefined && BUSY.has(was) && row.status === 'idle')) {
      next.add(row.id)
    }
  }

  return next.size === unread.size && [...next].every(id => unread.has(id)) ? unread : next
}

export function sessionTabKind(row: SessionActiveItem | undefined, unread: boolean): SessionTabKind {
  if (!row) {
    return 'closed'
  }

  if (row.status === 'waiting') {
    return 'attention'
  }

  if (row.status === 'working') {
    return 'running'
  }

  if (row.status === 'starting') {
    return 'starting'
  }

  return unread ? 'unread' : 'idle'
}

export interface TabLabels {
  closed: string
  opening: string
  picking: string
  untitled: string
}

/** The rail's rows: one per tab, in the order the user opened them. */
export function buildSessionTabs(
  state: TabsState,
  rows: readonly SessionActiveItem[],
  unread: ReadonlySet<string>,
  labels: TabLabels
): SessionTab[] {
  return state.slots.map((slot, index) => {
    const selected = index === state.active
    const base = { index, number: index + 1, selected, sessionId: slot.sessionId }

    if (!isOpen(slot.sessionId)) {
      return {
        ...base,
        kind: 'empty' as const,
        model: '',
        title: slot.sessionId === null ? labels.picking : labels.opening
      }
    }

    const row = rowFor(rows, slot.sessionId)
    const model = (row?.model || slot.model || '').replace(/^.*\//, '')

    return {
      ...base,
      kind: sessionTabKind(row, !selected && !!row && unread.has(row.id)),
      model: row ? model : [labels.closed, model].filter(Boolean).join(' · '),
      title: (row?.title || row?.preview || slot.title || '').trim() || labels.untitled
    }
  })
}

/** The tab `dir` steps from the selected one, wrapping (Alt+↑/↓). */
export function cycleSessionTab(tabs: readonly SessionTab[], dir: -1 | 1): null | number {
  if (tabs.length < 2) {
    return null
  }

  const at = Math.max(
    0,
    tabs.findIndex(tab => tab.selected)
  )

  return (at + dir + tabs.length) % tabs.length
}

/** The next tab that wants you, waiting ones first, then unread (Alt+Shift+↑/↓; OpenCode's
 *  `session.tab.next_unread`, which also lands on attention tabs). */
export function nextAttentionTab(tabs: readonly SessionTab[], dir: -1 | 1): null | number {
  const at = Math.max(
    0,
    tabs.findIndex(tab => tab.selected)
  )

  const n = tabs.length

  for (const kind of ['attention', 'unread'] as const) {
    for (let step = 1; step < n; step++) {
      const index = (((at + dir * step) % n) + n) % n

      if (tabs[index]!.kind === kind) {
        return index
      }
    }
  }

  return null
}

export const SESSION_TAB_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Status glyph beside the number (OpenCode's `indicators: status`): `?` waiting on you, a spinner
 *  while working, `…` starting or being filled, `•` finished unseen, nothing when idle or closed. */
export function sessionTabGlyph(kind: SessionTabKind, frame: number): string {
  switch (kind) {
    case 'attention':
      return '?'

    case 'running':
      return SESSION_TAB_SPINNER[frame % SESSION_TAB_SPINNER.length]!

    case 'starting':

    case 'empty':
      return '…'

    case 'unread':
      return '•'

    default:
      return ' '
  }
}

/** Breathing level 0..1 for attention tabs: a slow sine (~2.4 s period at a 90 ms tick),
 *  quantized to 8 steps so an idle-but-waiting rail repaints a few times a second, not every tick. */
export const breatheLevel = (frame: number): number =>
  Math.round(((1 - Math.cos((frame / 27) * 2 * Math.PI)) / 2) * 8) / 8

/** Unread glow falloff behind the number: full at the left edge, gone by `reach` cells
 *  (OpenCode #39428: "peaks around the number and fades horizontally"). */
export const glowAt = (cell: number, reach = 6): number => Math.max(0, 1 - cell / reach)

/** Tab navigation keys (OpenCode's defaults where a terminal can deliver them):
 *  Alt+↑/↓ previous/next tab, Alt+Shift+↑/↓ previous/next tab that wants you, Alt+1..9 tab N.
 *  Option is Alt on macOS only when the terminal sends it as Meta (Ghostty: `macos-option-as-alt`). */
export type SessionTabKeyAction = { dir: -1 | 1; kind: 'attention' | 'cycle' } | { kind: 'select'; number: number }

export function sessionTabKeyAction(
  ch: string,
  key: { ctrl: boolean; downArrow: boolean; meta: boolean; shift: boolean; upArrow: boolean }
): null | SessionTabKeyAction {
  if (!key.meta || key.ctrl) {
    return null
  }

  if (key.upArrow || key.downArrow) {
    return { dir: key.upArrow ? -1 : 1, kind: key.shift ? 'attention' : 'cycle' }
  }

  return /^[1-9]$/.test(ch) && !key.shift ? { kind: 'select', number: Number(ch) } : null
}

/** Rows one tab takes: title, detail, gap. */
export const SESSION_TAB_ROWS = 3

export interface SessionTabWindow {
  after: number
  afterWaiting: number
  before: number
  beforeWaiting: number
  end: number
  start: number
}

/**
 * The slice of tabs that fits `rows` rows, kept around the selected tab (OpenCode's rail scrolls
 * with active-tab tracking). The window moves only when the selected tab would leave it, so it
 * doesn't jump on every switch. Overflow markers take a row each and say how many hidden tabs
 * are waiting on you.
 */
export function sessionTabWindow(tabs: readonly SessionTab[], rows: number, previousStart = 0): SessionTabWindow {
  const fit = (room: number) => Math.max(1, Math.floor(room / SESSION_TAB_ROWS))

  const selected = Math.max(
    0,
    tabs.findIndex(tab => tab.selected)
  )

  let count = Math.min(tabs.length, fit(rows))

  if (count < tabs.length) {
    count = Math.min(tabs.length, fit(rows - 2))
  }

  let start = Math.min(Math.max(0, previousStart), Math.max(0, tabs.length - count))

  if (selected < start) {
    start = selected
  } else if (selected >= start + count) {
    start = selected - count + 1
  }

  const waiting = (from: number, to: number) => tabs.slice(from, to).filter(tab => tab.kind === 'attention').length

  return {
    after: tabs.length - start - count,
    afterWaiting: waiting(start + count, tabs.length),
    before: start,
    beforeWaiting: waiting(0, start),
    end: start + count,
    start
  }
}
