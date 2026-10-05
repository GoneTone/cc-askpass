import { expect, mock, test } from 'claude-code/testing'

import { SESSION_DIR, SESSION_ID, fakeServe, recorder } from './testkit'

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const ASKPASS_VARS = ['CC_ASKPASS_DIR', 'SUDO_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']

test('session.start spawns serve with the session id', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  recorder(on)
  await $.session.start(START)
  await clock.settle()
  const argv = serve.argvs[0] ?? []
  expect(argv[0]?.endsWith('/bin/askpass')).toBe(true)
  expect(argv.slice(1)).toEqual(['--serve', SESSION_ID])
})

test('does nothing without a person at the prompt (-p, SDK)', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start({ ...START, isInteractive: false })
  await clock.settle()
  expect(serve.argvs).toEqual([])
  expect(rec.envSets).toEqual([])
})

test('sets askpass env after ready', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  await clock.settle()
  expect(rec.envSets).toEqual([])
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  const askpass = serve.argvs[0]?.[0]
  expect(rec.envValue('CC_ASKPASS_DIR')).toBe(SESSION_DIR)
  expect(rec.envValue('SUDO_ASKPASS')).toBe(askpass)
  expect(rec.envValue('SSH_ASKPASS')).toBe(askpass)
  expect(rec.envValue('SSH_ASKPASS_REQUIRE')).toBe('force')
})

test('sets DISPLAY when unset', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  expect(rec.envValue('DISPLAY')).toBe(':0')
  expect(rec.envValue('CC_ASKPASS_SET_DISPLAY')).toBe('1')
})

test('keeps a real DISPLAY of :0 (WSLg)', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { DISPLAY: ':0' })
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  serve.end()
  await clock.settle()
  expect(rec.envSets.some(set => set.name === 'DISPLAY')).toBe(false)
})

test('after a reload, still owns the DISPLAY it set before', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { DISPLAY: ':0', CC_ASKPASS_SET_DISPLAY: '1' })
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  serve.end()
  await clock.settle()
  expect(rec.envSets.filter(set => set.value === undefined).map(set => set.name)).toContain('DISPLAY')
})

test('keeps an existing DISPLAY', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { DISPLAY: ':1' })
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  expect(rec.envSets.some(set => set.name === 'DISPLAY')).toBe(false)
})

test('no ready in 5 s toasts and sets nothing', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  await clock.advance(5000)
  expect(rec.toasts).toHaveLength(1)
  expect(rec.envSets).toEqual([])
})

test('serve exiting before ready toasts once', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.end()
  await clock.settle()
  await clock.advance(5000)
  expect(rec.toasts).toHaveLength(1)
  expect(rec.envSets).toEqual([])
})

test('serve exit unsets env', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  serve.end()
  await clock.settle()
  for (const name of [...ASKPASS_VARS, 'DISPLAY']) expect(rec.envValue(name)).toBe(undefined)
  expect(rec.envSets.filter(set => set.value === undefined).map(set => set.name).sort()).toEqual(
    [...ASKPASS_VARS, 'CC_ASKPASS_SET_DISPLAY', 'DISPLAY'].sort(),
  )
  expect(rec.toasts).toHaveLength(1)
})

test('serve exit keeps a DISPLAY the mod did not set', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { DISPLAY: ':1' })
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  serve.end()
  await clock.settle()
  expect(rec.envSets.some(set => set.name === 'DISPLAY')).toBe(false)
})

test('session.start twice re-sets env', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  expect(serve.argvs).toHaveLength(2)
  expect(rec.envSets.filter(set => set.name === 'CC_ASKPASS_DIR' && set.value === SESSION_DIR)).toHaveLength(2)
  expect(rec.envSets.some(set => set.value === undefined)).toBe(false)
  expect(rec.toasts).toEqual([])
})

test('session.end removes the session dir', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  expect(rec.runs.map(run => run.argv)).toContainEqual(['rm', '-rf', SESSION_DIR])
})

for (const reason of ['clear', 'resume'] as const) {
  test(`session.end for ${reason} keeps the listener and its dir`, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, {})
    const serve = fakeServe(on)
    const rec = recorder(on)
    await $.session.start(START)
    serve.emit(`ready\t${SESSION_DIR}\n`)
    await clock.settle()
    // The process goes on and no session.start follows: the env still points at this dir.
    await $.session.end({ reason } as never)
    expect(rec.runs.some(run => run.argv[0] === 'rm')).toBe(false)
  })
}

test('registers /askpass as immediate', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  fakeServe(on)
  const rec = recorder(on)
  await $.session.start(START)
  await clock.settle()
  expect(rec.commands).toContainEqual({ name: 'askpass', immediate: true })
})
