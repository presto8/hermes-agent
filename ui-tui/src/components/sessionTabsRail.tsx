import { Box, NoSelect, stringWidth, Text } from '@hermes/ink'
import { mix } from '@hermes/shared/color'
import { useStore } from '@nanostores/react'
import { memo, useMemo } from 'react'

import { breatheLevel, buildSessionTabs, glowAt, type SessionTab, sessionTabGlyph } from '../app/sessionTabsModel.js'
import { $sessionTabRows, $sessionTabUnread } from '../app/sessionTabsStore.js'
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
 *   idle       nothing
 *
 * Click a tab to switch to it; the `+` row opens a new session.
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
  frame,
  numberWidth,
  onActivate,
  t,
  tab,
  width
}: {
  frame: number
  numberWidth: number
  onActivate: () => void
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

  const titleColor = tab.selected ? t.color.text : attention ? mix(t.color.muted, t.color.warn, 0.5) : t.color.muted
  const detailColor = mix(t.color.muted, background, 0.35)
  const glyph = sessionTabGlyph(tab.kind, frame)
  const label = String(tab.number).padStart(numberWidth)
  // edge (1) + number + glyph (1) + space (1), then the title.
  const textWidth = Math.max(1, width - numberWidth - 3)
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
      onClick={(event: { stopImmediatePropagation?: () => void }) => {
        event.stopImmediatePropagation?.()
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
        </Box>
      ))}
    </Box>
  )
}

function useRailFrame(animate: boolean) {
  const phase = useShimmerPhase(animate ? FOREVER : 0)

  return animate ? phase : 0
}

export const SessionTabsRail = memo(function SessionTabsRail({
  currentSessionId,
  onNew,
  onSelect,
  t,
  width
}: {
  currentSessionId: null | string
  onNew: () => void
  onSelect: (id: string) => void
  t: Theme
  width: number
}) {
  const rows = useStore($sessionTabRows)
  const unread = useStore($sessionTabUnread)
  const copy = useT().session.tabs

  const tabs = useMemo(
    () => buildSessionTabs(rows, currentSessionId, unread, copy.untitled),
    [rows, currentSessionId, unread, copy.untitled]
  )

  const animate = tabs.some(tab => tab.kind === 'attention' || tab.kind === 'running')
  const frame = useRailFrame(animate)
  const numberWidth = Math.max(1, String(tabs.length).length)
  const waiting = tabs.filter(tab => tab.kind === 'attention').length
  const surface = t.color.completionBg

  return (
    <NoSelect flexDirection="column" flexShrink={0} width={width}>
      <Box backgroundColor={surface} flexDirection="column" flexGrow={1} width={width}>
        <Box paddingX={1} width={width}>
          <Text backgroundColor={surface} bold color={t.color.label}>
            {copy.title}
          </Text>
          <Text backgroundColor={surface} color={waiting ? t.color.warn : t.color.muted}>
            {' '}
            {waiting ? copy.waiting(waiting) : copy.live(tabs.length)}
          </Text>
        </Box>
        <Box height={1} />
        {tabs.map(tab => (
          <Box flexDirection="column" key={tab.id}>
            <TabRow
              frame={frame}
              numberWidth={numberWidth}
              onActivate={() => onSelect(tab.id)}
              t={t}
              tab={tab}
              width={width}
            />
            <Box height={1} />
          </Box>
        ))}
        <Box
          onClick={(event: { stopImmediatePropagation?: () => void }) => {
            event.stopImmediatePropagation?.()
            onNew()
          }}
          paddingX={1}
        >
          <Text backgroundColor={surface} color={t.color.muted}>
            {copy.newSession}
          </Text>
        </Box>
      </Box>
    </NoSelect>
  )
})
