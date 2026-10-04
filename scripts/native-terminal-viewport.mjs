import assert from 'node:assert/strict'
import { diagnosticWithin } from './native-browser-diagnostic.mjs'

// Failure reporting may observe a removed terminal. Never replace the original
// workflow error with a second locator timeout while collecting its output.
export async function nativeTerminalFailureSnapshot(terminal, page) {
  return diagnosticWithin(async () => {
    if (!await terminal.count()) return { present: false, terminal: null }
    if (await terminal.locator('.xterm-scrollable-element').count()) {
      const result = await renderedTerminalScan(nativeTerminalViewport(terminal, page), () => false)
      return { present: true, terminal: result.screens.join('\n[scroll]\n').slice(-16000) }
    }
    const viewport = terminal.locator('.xterm-viewport')
    if (!await viewport.count())
      return { present: true, terminal: await terminal.locator('.xterm-rows').textContent({ timeout: 1000 }) }
    const height = await viewport.evaluate(element => element.scrollHeight, undefined, { timeout: 1000 })
    const screens = []
    for (let top = 0; top <= height; top += 24) {
      await viewport.evaluate((element, value) => { element.scrollTop = value }, top, { timeout: 1000 })
      const text = await terminal.locator('.xterm-rows').textContent({ timeout: 1000 })
      if (screens.at(-1) !== text) screens.push(text)
    }
    return { present: true, terminal: screens.join('\n[scroll]\n').slice(-16000) }
  })
}

// Xterm 6 has a virtual scrollbar. Use actual wheel input and visible rows.
export async function renderedTerminalEdge(view, direction, { requireMovement = false, maxSteps = 1024 } = {}) {
  assert.ok(direction === -1 || direction === 1)
  assert.ok(Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 1024)
  const initial = await view.read()
  let previous = initial, unchanged = 0, moved = false
  for (let step = 1; step <= maxSteps; step++) {
    await view.scroll(direction)
    const screen = await view.read()
    moved ||= screen !== initial
    unchanged = screen === previous ? unchanged + 1 : 0
    if (unchanged >= 2) {
      assert.ok(!requireMovement || moved, 'Terminal never moved into scrollback')
      return { screen, moved, steps: step }
    }
    previous = screen
  }
  throw Error('Terminal never reached a stable scrollback edge')
}

export async function renderedTerminalScan(view, matches, maxSteps = 1024) {
  assert.equal(typeof matches, 'function')
  assert.ok(Number.isSafeInteger(maxSteps) && maxSteps > 0 && maxSteps <= 1024)
  const top = await renderedTerminalEdge(view, -1, { maxSteps })
  const screens = [top.screen]
  if (matches(top.screen)) return { found: true, screens }
  let previous = top.screen, unchanged = 0
  for (let step = 0; step < maxSteps; step++) {
    await view.scroll(1)
    const screen = await view.read()
    if (screen !== previous) screens.push(screen)
    if (matches(screen)) return { found: true, screens }
    unchanged = screen === previous ? unchanged + 1 : 0
    if (unchanged >= 2) return { found: false, screens }
    previous = screen
  }
  throw Error('Terminal scan exceeded the bounded scrollback range')
}

export function nativeTerminalViewport(terminal, page) {
  const viewport = terminal.locator('.xterm-scrollable-element')
  return {
    read: () => terminal.locator('.xterm-rows').textContent(),
    async scroll(direction) {
      await viewport.hover()
      const box = await viewport.boundingBox()
      assert.ok(box && box.height > 0, 'Terminal viewport is not visible')
      await page.mouse.wheel(0, direction * Math.max(24, Math.floor(box.height / 2)))
      await viewport.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    },
  }
}
