import assert from 'node:assert/strict'

// Wheel over the visible screen. Xterm 5's viewport sits underneath it,
// and direct scrollTop writes can race the terminal's buffer updates.
export function nativeTerminalScreen(terminal,page){
  const screen=terminal.locator('.xterm-screen')
  return {
    read:()=>terminal.locator('.xterm-rows').textContent(),
    async scroll(direction){
      assert.ok(direction===-1||direction===1)
      await screen.hover()
      const box=await screen.boundingBox()
      assert.ok(box&&box.height>0,'Terminal screen is not visible')
      await page.mouse.wheel(0,direction*Math.max(24,Math.floor(box.height/2)))
      await screen.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))
    },
  }
}
