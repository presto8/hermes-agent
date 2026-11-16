import { Box, NoSelect, stringWidth, Text, useStdout } from '@hermes/ink'
import { mix } from '@hermes/shared/color'
import { useStore } from '@nanostores/react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'

import {
  breatheLevel,
  buildSessionTabs,
  glowAt,
  type SessionTab,
  sessionTabGlyph,
  sessionTabWindow
} from '../app/sessionTabsModel.js'
import { $sessionTabRows, $sessionTabs, $sessionTabUnread } from '../app/sessionTabsStore.js'
import { useT } from '../i18n/useT.js'
import type { Theme } from '../theme.js'

import { useShimmerPhase } from './loaders.js'

/**
 * Vertical session tabs (`display.tui_session_tabs`), after OpenCode's vertical tab rail
 * (anomalyco/opencode #40072): numbered two-row tabs, the title over a muted detail line, and a
 * status treatment per tab:
 *
 *   attention  `?` in the warning color, number and edge breathing: a prompt waits for you
 *   running    spinner in the accent color
 *   starting   `…`
 *   unread     `•` plus a still accent glow behind the number (#39428): finished while away
 *   empty      `…`: a new session on its way, or an empty tab waiting for the picker
 *   closed     the session ended; selecting the tab resumes it
 *   idle       nothing
 *
 * Only the tabs the user opened appear. Click a tab to switch to it, its `×` to take it off the
 * rail, and "+ new tab" to start a new session in another tab (the picker's Ctrl+N).
 */

// Keep animating forever while something is busy: the shared clock costs one interval for every
// subscriber, and a rail with no busy tab doesn't subscribe at all.
const FOREVER = Number.MAX_SAFE_INTEGER

const clip = (text: string, width: number) => {
  if (width <= 0) {
    return ''
  }

  if (stringWidth(text) <= width) {
    return text
  }

  let out = ''

  for (const ch of text) {
    if (stringWidth(out + ch) > width - 1) {
      break
    }

    out += ch
  }

  return out + '…'
}

/** `text` clipped to `width` cells and padded out to exactly `width`, so the tab fill is solid. */
const fit = (text: string, width: number) => {
  const clipped = clip(text, width)

  return clipped + ' '.repeat(Math.max(0, width - stringWidth(clipped)))
}

function TabRow({
  closable,
  frame,
  numberWidth,
  onActivate,
  onClose,
  t,
  tab,
  width
}: {
  closable: boolean
  frame: number
  numberWidth: number
  onActivate: () => void
  onClose: () => void
  t: Theme
  tab: SessionTab
  width: number
}) {
  const surface = t.color.completionBg

  const background = tab.selected ? t.color.completionCurrentBg : surface
  const attention = tab.kind === 'attention'
  const breathe = attention ? breatheLevel(frame) : 0
  const feedback = attention ? t.color.warn : tab.kind === 'unread' ? t.color.accent : undefined

  const numberColor = attention
    ? mix(t.color.warn, t.color.text, 0.35 * breathe)
    : tab.kind === 'running'
      ? t.color.accent
      : tab.kind === 'unread'
        ? t.color.accent
        : tab.selected
          ? t.color.text
          : t.color.muted

  const edge = attention
    ? mix(background, t.color.warn, 0.45 + 0.55 * breathe)
    : tab.selected
      ? t.color.accent
      : background

  const dim = tab.kind === 'closed' || tab.kind === 'empty'

  const titleColor = tab.selected
    ? dim
      ? t.color.muted
      : t.color.text
    : attention
      ? mix(t.color.muted, t.color.warn, 0.5)
      : dim
        ? mix(t.color.muted, background, 0.35)
        : t.color.muted

  const detailColor = mix(t.color.muted, background, 0.35)
  const glyph = sessionTabGlyph(tab.kind, frame)
  const label = String(tab.number).padStart(numberWidth)
  // edge (1) + number + glyph (1) + space (1), then the title, then ` ×` (2) when closable.
  const textWidth = Math.max(1, width - numberWidth - 3 - (closable ? 2 : 0))
  const glow = tab.kind === 'unread' && !tab.selected

  const lead = (row: 0 | 1) =>
    [...(row === 0 ? `${label}${glyph}` : ' '.repeat(numberWidth + 1))].map((ch, i) => (
      <Text
        backgroundColor={glow ? mix(background, t.color.accent, 0.16 * glowAt(i)) : background}
        color={row === 0 ? (i < numberWidth ? numberColor : (feedback ?? numberColor)) : undefined}
        key={i}
      >
        {ch}
      </Text>
    ))

  return (
    <Box
      flexDirection="column"
      onClick={(event: { localCol?: number; localRow?: number; stopImmediatePropagation?: () => void }) => {
        event.stopImmediatePropagation?.()

        if (closable && event.localRow === 0 && (event.localCol ?? 0) >= width - 2) {
          return onClose()
        }

        onActivate()
      }}
      width={width}
    >
      {([0, 1] as const).map(row => (
        <Box flexDirection="row" key={row}>
          <Text backgroundColor={background} color={edge}>
            ▎
          </Text>
          {lead(row)}
          <Text backgroundColor={background}> </Text>
          <Text
            backgroundColor={background}
            bold={row === 0 && tab.selected}
            color={row === 0 ? titleColor : detailColor}
          >
            {fit(row === 0 ? tab.title : tab.model, textWidth)}
          </Text>
          {closable && (
            <Text backgroundColor={background} color={row === 0 ? detailColor : background}>
              {row === 0 ? ' ×' : '  '}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}

// Rows the rail can't use: its header and the "+ new tab" row, plus the composer and status
// bar below the transcript row it sits in.
const RAIL_RESERVED_ROWS = 9

function useTerminalRows() {
  const { stdout } = useStdout()
  const [rows, setRows] = useState(stdout?.rows ?? 24)

  useEffect(() => {
    if (!stdout) {
      return
    }

    const onResize = () => setRows(stdout.rows ?? 24)
    stdout.on('resize', onResize)

    return () => {
      stdout.off('resize', onResize)
    }
  }, [stdout])

  return rows
}

function useRailFrame(animate: boolean) {
  const phase = useShimmerPhase(animate ? FOREVER : 0)

  return animate ? phase : 0
}

export const SessionTabsRail = memo(function SessionTabsRail({
  onClose,
  onNew,
  onSelect,
  t,
  width
}: {
  onClose: (index: number) => void
  onNew: () => void
  onSelect: (index: number) => void
  t: Theme
  width: number
}) {
  const state = useStore($sessionTabs)
  const rows = useStore($sessionTabRows)
  const unread = useStore($sessionTabUnread)
  const copy = useT().session.tabs

  const tabs = useMemo(
    () =>
      buildSessionTabs(state, rows, unread, {
        closed: copy.closed,
        opening: copy.opening,
        picking: copy.picking,
        untitled: copy.untitled
      }),
    [state, rows, unread, copy]
  )

  const animate = tabs.some(tab => tab.kind === 'attention' || tab.kind === 'running')
  const frame = useRailFrame(animate)
  const numberWidth = Math.max(1, String(tabs.length).length)
  const waiting = tabs.filter(tab => tab.kind === 'attention').length
  const surface = t.color.completionBg
  const startRef = useRef(0)
  const view = sessionTabWindow(tabs, Math.max(3, useTerminalRows() - RAIL_RESERVED_ROWS), startRef.current)
  startRef.current = view.start

  const marker = (dir: 'down' | 'up', count: number, waitingCount: number) =>
    count > 0 ? (
      <Box paddingX={1} width={width}>
        <Text backgroundColor={surface} color={t.color.muted}>
          {dir === 'up' ? copy.moreAbove(count) : copy.moreBelow(count)}
        </Text>
        {waitingCount > 0 && (
          <Text backgroundColor={surface} color={t.color.warn}>
            {' · '}
            {copy.waiting(waitingCount)}
          </Text>
        )}
      </Box>
    ) : null

  return (
    <NoSelect flexDirection="column" flexShrink={0} width={width}>
      <Box backgroundColor={surface} flexDirection="column" flexGrow={1} width={width}>
        <Box paddingX={1} width={width}>
          <Text backgroundColor={surface} bold color={t.color.label}>
            {copy.title}
          </Text>
          <Text backgroundColor={surface} color={waiting ? t.color.warn : t.color.muted}>
            {' '}
            {waiting ? copy.waiting(waiting) : copy.count(tabs.length)}
          </Text>
        </Box>
        <Box height={1} />
        {marker('up', view.before, view.beforeWaiting)}
        {tabs.slice(view.start, view.end).map(tab => (
          <Box flexDirection="column" key={state.slots[tab.index]!.key}>
            <TabRow
              closable={tabs.length > 1}
              frame={frame}
              numberWidth={numberWidth}
              onActivate={() => onSelect(tab.index)}
              onClose={() => onClose(tab.index)}
              t={t}
              tab={tab}
              width={width}
            />
            <Box height={1} />
          </Box>
        ))}
        {marker('down', view.after, view.afterWaiting)}
        <Box
          onClick={(event: { stopImmediatePropagation?: () => void }) => {
            event.stopImmediatePropagation?.()
            onNew()
          }}
          paddingX={1}
        >
          <Text backgroundColor={surface} color={t.color.muted}>
            {copy.newTab}
          </Text>
        </Box>
      </Box>
    </NoSelect>
  )
})
