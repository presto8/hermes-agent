/**
 * Pure rules for the vertical session-tab rail (`display.tui_session_tabs`).
 *
 * Modeled on OpenCode's TUI session tabs (anomalyco/opencode #39396, #39428, #40072): one tab per
 * live session, a status that tells "needs you" apart from "working" and "finished while you were
 * away", and navigation that jumps straight to the tab that is waiting.
 *
 * Hermes reports a live session's status as `idle | starting | waiting | working`; `waiting` means
 * an approval, clarify, sudo, secret or vault prompt holds the turn (the same state the terminal
 * title marks with `⚠`). A child agent's prompt surfaces on its parent session, so the parent's
 * status already covers its family (OpenCode aggregates the family explicitly).
 */
import type { SessionActiveItem } from '@hermes/shared/gateway-types'

export type SessionTabKind = 'attention' | 'idle' | 'running' | 'starting' | 'unread'

export interface SessionTab {
  id: string
  kind: SessionTabKind
  model: string
  number: number
  selected: boolean
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

export function sessionTabKind(row: SessionActiveItem, unread: boolean): SessionTabKind {
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

/** Tabs in a stable order: oldest first, so a new session opens at the bottom and numbers don't
 *  shuffle while you work (OpenCode appends new tabs too). */
export function buildSessionTabs(
  rows: readonly SessionActiveItem[],
  current: null | string,
  unread: ReadonlySet<string>,
  untitled: string
): SessionTab[] {
  return [...rows]
    .map((row, index) => ({ index, row }))
    .sort((a, b) => (a.row.started_at ?? 0) - (b.row.started_at ?? 0) || a.index - b.index)
    .map(({ row }, index) => ({
      id: row.id,
      kind: sessionTabKind(row, unread.has(row.id) && row.id !== current && !row.current),
      model: (row.model ?? '').replace(/^.*\//, ''),
      number: index + 1,
      selected: row.id === current || !!row.current,
      title: (row.title || row.preview || '').trim() || untitled
    }))
}

/** The tab `dir` steps from the selected one, wrapping (Alt+↑/↓). */
export function cycleSessionTab(tabs: readonly SessionTab[], dir: -1 | 1): null | string {
  if (tabs.length < 2) {
    return null
  }

  const at = tabs.findIndex(tab => tab.selected)
  const from = at === -1 ? (dir === 1 ? -1 : 0) : at

  return tabs[(from + dir + tabs.length) % tabs.length]!.id
}

/** The next tab that wants you, waiting ones first, then unread (Alt+Shift+↑/↓; OpenCode's
 *  `session.tab.next_unread`, which also lands on attention tabs). */
export function nextAttentionTab(tabs: readonly SessionTab[], dir: -1 | 1): null | string {
  const at = Math.max(
    0,
    tabs.findIndex(tab => tab.selected)
  )

  const n = tabs.length

  for (const kind of ['attention', 'unread'] as const) {
    for (let step = 1; step < n; step++) {
      const tab = tabs[(((at + dir * step) % n) + n) % n]!

      if (tab.kind === kind && !tab.selected) {
        return tab.id
      }
    }
  }

  return null
}

export const SESSION_TAB_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Status glyph beside the number (OpenCode's `indicators: status`): `?` waiting on you, a spinner
 *  while working, `…` starting, `•` finished unseen, nothing when idle. */
export function sessionTabGlyph(kind: SessionTabKind, frame: number): string {
  switch (kind) {
    case 'attention':
      return '?'

    case 'running':
      return SESSION_TAB_SPINNER[frame % SESSION_TAB_SPINNER.length]!

    case 'starting':
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
 *  Option is Alt on macOS when the terminal sends it as Meta (Ghostty: `macos-option-as-alt`). */
export type SessionTabKeyAction = { kind: 'attention' | 'cycle'; dir: -1 | 1 } | { kind: 'select'; number: number }

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
