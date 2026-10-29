import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { renderSync } from '@hermes/ink'
import React, { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { TextInput } from '../components/textInput.js'
import type * as PlatformModule from '../lib/platform.js'

// Ctrl+D as delete-char is the macOS readline fallback (Cmd is the action
// modifier there), so pin the platform helpers to their macOS shape on every
// CI lane.
vi.mock('../lib/platform.js', async importOriginal => {
  const mod = await importOriginal<typeof PlatformModule>()

  return {
    ...mod,
    isActionMod: (key: { meta: boolean; super?: boolean }) => key.meta || key.super === true,
    isMac: true,
    isMacActionFallback: (key: { ctrl: boolean; meta: boolean; super?: boolean }, ch: string, target: string) =>
      key.ctrl && !key.meta && key.super !== true && ch.toLowerCase() === target
  }
})

class FakeInput extends EventEmitter {
  chunks: string[] = []
  isRaw = false
  isTTY = true
  readableLength = 0

  read() {
    const next = this.chunks.shift() ?? null
    this.readableLength = this.chunks.length

    return next
  }

  ref = vi.fn()

  send(...chunks: string[]) {
    this.chunks.push(...chunks)
    this.readableLength = this.chunks.length
    this.emit('readable')
  }

  setEncoding = vi.fn()

  setRawMode = vi.fn((enabled: boolean) => {
    this.isRaw = enabled
  })

  unref = vi.fn()
}

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

async function typeThen(keys: string[]) {
  const stdin = new FakeInput()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  Object.assign(stdout, { columns: 80, isTTY: false, rows: 24 })
  Object.assign(stderr, { columns: 80, isTTY: false, rows: 24 })

  const changes: string[] = []

  function Harness() {
    const [value, setValue] = useState('')

    return (
      <TextInput
        columns={80}
        onChange={next => {
          changes.push(next)
          setValue(next)
        }}
        onSubmit={() => {}}
        value={value}
      />
    )
  }

  const instance = renderSync(React.createElement(Harness), {
    patchConsole: false,
    stderr: stderr as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream
  })

  await settle()

  for (const ch of 'abc') {
    stdin.send(ch)
    await settle()
  }

  for (const key of keys) {
    stdin.send(key)
    await settle()
  }

  instance.unmount()
  instance.cleanup()

  return changes
}

const LEFT = '\u001b[D'
const CTRL_D = '\u0004'

describe('TextInput Ctrl+D on macOS', () => {
  it('deletes the character under the cursor', async () => {
    const changes = await typeThen([LEFT, LEFT, CTRL_D])

    expect(changes.at(-1)).toBe('ac')
  })

  it('is a no-op at the end of the draft', async () => {
    const changes = await typeThen([CTRL_D])

    expect(changes.at(-1)).toBe('abc')
  })
})
