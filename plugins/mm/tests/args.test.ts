import { describe, expect, test } from 'claude-code/testing'

import { isFlagForm, splitArgs } from '../hooks/args'

describe('splitArgs', () => {
  test('splits on blanks; single and double quotes hold a word together', () => {
    expect(splitArgs(`  --paths "src/api x"  --focus '并发 安全' a\\ b "" `)).toEqual(['--paths', 'src/api x', '--focus', '并发 安全', 'a b', ''])
    expect(splitArgs(`--focus "say \\"hi\\""`)).toEqual(['--focus', 'say "hi"'])
    expect(splitArgs(`'$HOME' "$HOME"`)).toEqual(['$HOME', '$HOME'])
    expect(splitArgs('')).toEqual([])
  })
})

describe('isFlagForm', () => {
  const form = (args: string) => isFlagForm(splitArgs(args))

  test('options only, values after the options that take one', () => {
    expect(form('--base main --paths "src/api"')).toBe(true)
    expect(form('--staged')).toBe(true)
    expect(form('--model codex --task /tmp/t.md')).toBe(true)
    expect(form('')).toBe(true)
  })

  test('every option mmrun review or run takes a value for holds that value', () => {
    const valued = ['--base', '--commit', '--paths', '--focus', '--notes-file', '--max', '--models', '--dir', '--grok-model', '--codex-model', '--agy-model', '--patch', '--model', '--task', '--model-name']

    for (const option of valued) {
      expect([option, form(`${option} v`)]).toEqual([option, true])
    }
  })

  test('natural language, or a word no option takes', () => {
    expect(form('提交前看看')).toBe(false)
    expect(form('--focus 并发 安全')).toBe(false)
    expect(form('--staged 看看')).toBe(false)
    expect(form('main --base')).toBe(false)
  })
})
