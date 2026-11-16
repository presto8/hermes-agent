import type { SessionActiveItem, SessionActiveListResponse } from '@hermes/shared/gateway-types'
import { atom } from 'nanostores'

import type { GatewayClient } from '../gatewayClient.js'
import { asRpcResult } from '../lib/rpc.js'

import { nextUnread } from './sessionTabsModel.js'

/** Live-session rows behind the tab rail, refreshed by the 1.5 s live-session poll. */
export const $sessionTabRows = atom<readonly SessionActiveItem[]>([])
/** Sessions that finished a turn while another one was on screen. */
export const $sessionTabUnread = atom<ReadonlySet<string>>(new Set())

let lastStatus = new Map<string, string>()

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

/** Opening a tab reads it. */
export function markSessionTabRead(id: string) {
  const unread = $sessionTabUnread.get()

  if (unread.has(id)) {
    const next = new Set(unread)
    next.delete(id)
    $sessionTabUnread.set(next)
  }
}

export function resetSessionTabs() {
  lastStatus = new Map()
  $sessionTabRows.set([])
  $sessionTabUnread.set(new Set())
}
