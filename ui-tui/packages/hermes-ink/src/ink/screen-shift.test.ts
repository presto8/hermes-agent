import { describe, expect, it } from 'vitest'

import {
  CellWidth,
  charInCellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  setCellAt,
  shiftRows,
  StylePool
} from './screen.js'

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

const paint = (screen: Screen, y: number, text: string) => {
  for (let x = 0; x < text.length; x++) {
    setCellAt(screen, x, y, { char: text[x]!, hyperlink: undefined, styleId: stylePool.none, width: CellWidth.Narrow })
  }
}

const rows = (screen: Screen) =>
  Array.from({ length: screen.height }, (_, y) =>
    Array.from({ length: screen.width }, (_, x) => charInCellAt(screen, x, y) || ' ').join('')
  )

const make = () => {
  const screen = createScreen(6, 4, stylePool, charPool, hyperlinkPool)

  ;['AAabcd', 'BBefgh', 'CCijkl', 'DDmnop'].forEach((text, y) => paint(screen, y, text))

  return screen
}

describe('shiftRows', () => {
  it('moves whole rows by default', () => {
    const screen = make()
    shiftRows(screen, 0, 3, 1)
    expect(rows(screen)).toEqual(['BBefgh', 'CCijkl', 'DDmnop', '      '])
  })

  // A scroll box beside a side panel (the TUI's session-tab rail): only its columns move.
  it('keeps cells outside the column band where they are, scrolling up and down', () => {
    const up = make()
    shiftRows(up, 0, 3, 1, 2, 4)
    expect(rows(up)).toEqual(['AAefgh', 'BBijkl', 'CCmnop', 'DD    '])

    const down = make()
    shiftRows(down, 1, 3, -2, 2, 4)
    expect(rows(down)).toEqual(['AAabcd', 'BB    ', 'CC    ', 'DDefgh'])

    const all = make()
    shiftRows(all, 0, 3, 9, 2, 4)
    expect(rows(all)).toEqual(['AA    ', 'BB    ', 'CC    ', 'DD    '])
  })
})
