import { expect, test } from 'vitest'
import { deleteTerminalWord } from '../integrations/tanstack-site/native-terminal-word'

test('Ctrl-W removes the preceding whitespace-delimited word and trailing space', () => {
  expect(deleteTerminalWord('echo alpha beta   ', 18, 'whitespace'))
    .toEqual({ input: 'echo alpha ', cursor: 11 })
  expect(deleteTerminalWord('echo /path/file.txt', 19, 'whitespace'))
    .toEqual({ input: 'echo ', cursor: 5 })
})

test('Alt-Backspace stops at punctuation, like readline backward-kill-word', () => {
  expect(deleteTerminalWord('echo /path/file.txt', 19, 'word'))
    .toEqual({ input: 'echo /path/file.', cursor: 16 })
  expect(deleteTerminalWord('echo first second', 17, 'word'))
    .toEqual({ input: 'echo first ', cursor: 11 })
})

test('word deletion preserves the text after the cursor', () => {
  expect(deleteTerminalWord('echo alpha beta tail', 15, 'whitespace'))
    .toEqual({ input: 'echo alpha  tail', cursor: 11 })
})

test('word deletion handles empty input, whitespace and Unicode words', () => {
  expect(deleteTerminalWord('', 0, 'word')).toEqual({ input: '', cursor: 0 })
  expect(deleteTerminalWord('   ', 3, 'whitespace')).toEqual({ input: '', cursor: 0 })
  expect(deleteTerminalWord('echo café  ', 11, 'word')).toEqual({ input: 'echo ', cursor: 5 })
})
