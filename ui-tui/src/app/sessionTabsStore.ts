import type { SessionActiveItem, SessionActiveListResponse } from '@hermes/shared/gateway-types'
import { atom } from 'nanostores'

import type { GatewayClient } from '../gatewayClient.js'
import { asRpcResult } from '../lib/rpc.js'

import {
  abandonTab,
  bindSession,
  closeTab,
  initialTabs,
  markPending,
  nextUnread,
  openTab,
  pickerClosed,
  rememberRows,
  type TabsState
} from './sessionTabsModel.js'

/** The tabs the user opened and which one is current. */
export const $sessionTabs = atom<TabsState>(initialTabs())
/** Live-session rows behind the tabs' status, refreshed by the 1.5 s live-session poll. */
export const $sessionTabRows = atom<readonly SessionActiveItem[]>([])
/** Sessions that finished a turn while another one was on screen. */
export const $sessionTabUnread = atom<ReadonlySet<string>>(new Set())

let lastStatus = new Map<string, string>()

const setTabs = (next: TabsState) => {
  if (next !== $sessionTabs.get()) {
    $sessionTabs.set(next)
  }
}

type RosterRow = Omit<SessionActiveItem, 'status'> & { running?: boolean; status?: SessionActiveItem['status'] }

/** A roster row in active_list shape: the shared owner's live `session.list` says only `running`. */
export const asActiveItem = (row: RosterRow): SessionActiveItem => ({
  ...row,
  status: row.status ?? (row.running ? 'working' : 'idle')
})

const sameRows = (a: readonly SessionActiveItem[], b: readonly SessionActiveItem[]) =>
  a.length === b.length &&
  a.every((row, i) => {
    const other = b[i]!

    return (
      row.id === other.id &&
      row.status === other.status &&
      row.title === other.title &&
      row.model === other.model &&
      !!row.current === !!other.current
    )
  })

/** Feed one poll into the rail. Writes the stores only on a change: an idle rail must not
 *  re-render the TUI every 1.5 s. */
export function applySessionTabsRoster(rows: readonly RosterRow[], current: null | string) {
  const items = rows.map(asActiveItem)
  const unread = nextUnread(lastStatus, items, current, $sessionTabUnread.get())
  lastStatus = new Map(items.map(row => [row.id, row.status]))

  if (unread !== $sessionTabUnread.get()) {
    $sessionTabUnread.set(unread)
  }

  if (!sameRows(items, $sessionTabRows.get())) {
    $sessionTabRows.set(items)
  }

  setTabs(rememberRows($sessionTabs.get(), items))
}

/** One poll for the rail. The shared gateway's live `session.list` (the roster the poll already
 *  holds) says only running or not, so there the rail reads `session.active_list`, which reports
 *  `waiting` while an approval or clarify holds a turn. The sidecar's roster already is that list. */
export async function refreshSessionTabs(
  gw: Pick<GatewayClient, 'isCanonical' | 'request'>,
  roster: readonly RosterRow[],
  current: null | string,
  fresh: () => boolean = () => true
) {
  if (!gw.isCanonical) {
    return applySessionTabsRoster(roster, current)
  }

  try {
    const raw = await gw.request<SessionActiveListResponse>('session.active_list', { current_session_id: current })
    const rows = asRpcResult<SessionActiveListResponse>(raw)?.sessions

    if (fresh()) {
      applySessionTabsRoster(rows ?? roster, current)
    }
  } catch {
    if (fresh()) {
      applySessionTabsRoster(roster, current)
    }
  }
}

/** The view switched to `sid`: it fills or focuses a tab, and reading it clears its unread mark. */
export function noteSessionShown(sid: null | string, storedSid?: null | string) {
  setTabs(bindSession($sessionTabs.get(), sid, storedSid))

  const unread = $sessionTabUnread.get()

  if (sid && unread.has(sid)) {
    const next = new Set(unread)
    next.delete(sid)
    $sessionTabUnread.set(next)
  }
}

/** A new session was picked for the current tab; its id arrives with the switch. */
export const noteSessionPending = () => setTabs(markPending($sessionTabs.get()))

/** Open an empty tab after the last one and focus it. Returns its key. */
export function openSessionTab(): number {
  const next = openTab($sessionTabs.get())
  setTabs(next)

  return next.slots[next.active]!.key
}

/** A new session meant for tab `key` didn't start: drop the tab if it is still waiting. */
export const abandonSessionTab = (key: number) => setTabs(abandonTab($sessionTabs.get(), key))

export const noteSessionPickerClosed = () => setTabs(pickerClosed($sessionTabs.get()))

/** Focus tab `index` without switching sessions (the caller switches). */
export function focusSessionTab(index: number) {
  const state = $sessionTabs.get()

  if (index !== state.active && state.slots[index]) {
    setTabs({ ...state, active: index, returnTo: null })
  }
}

/** Take tab `index` off the rail. Returns the tab to switch to, or null when the view stays. */
export function closeSessionTab(index: number): null | number {
  const { focus, state } = closeTab($sessionTabs.get(), index)
  setTabs(state)

  return focus
}

export function resetSessionTabs() {
  lastStatus = new Map()
  $sessionTabs.set(initialTabs())
  $sessionTabRows.set([])
  $sessionTabUnread.set(new Set())
}
