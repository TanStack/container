import assert from 'node:assert/strict'

export function assertEditedPreview(snapshot, example) {
  assert.equal(typeof snapshot.text, 'string', 'Preview text was not captured')
  assert.ok(snapshot.text.includes(example.after), `${example.id}: edited text is missing`)
  assert.ok(!snapshot.text.includes(example.before), `${example.id}: old preview text is still present`)
  if (example.id === 'start-counter') {
    assert.ok(Array.isArray(snapshot.counters), 'Counter buttons were not captured')
    assert.equal(snapshot.counters.length, 1, 'Counter preview must have exactly one counter button')
    assert.match(snapshot.counters[0], /^Terminal add 1 to \d+\?$/, 'Counter button did not contain the edit')
  }
}

export async function checkEditedPreview(frame, example) {
  const snapshot = await frame.locator('body').evaluate(body => ({
    text: body.innerText,
    counters: Array.from(body.querySelectorAll('button'))
      .map(button => button.textContent)
      .filter(text => /^(Add 1 to|Terminal add 1 to) \d+\?$/.test(text)),
  }))
  assertEditedPreview(snapshot, example)
  return snapshot
}
