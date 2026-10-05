import { expect, mock, test } from 'claude-code/testing'

import { SESSION_DIR, fakeServe, recorder } from './testkit'

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const SURFACES = ['terminal', 'desktop'] as const
const PANE_PROPS = {
  title: 'askpass',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const
const REPLY_SCRIPT = '[ -p "$1" ] || exit 1; exec 3<>"$1"; cat >&3'
const SUDO_PROMPT = '[sudo] password for alice: '
const SUDO_PARENT = 'root     sudo            sudo apt update'
const PASSWORD = '  p@ss \\w$rd é '


/** A session with a ready listener, canned `ps` output and helpers that are alive until told otherwise. */
async function world($: any, on: any) {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const ps = new Map<string, string>()
  const alive = new Set<number>()
  const rec = recorder(on, argv => {
    if (argv[0] === 'ps') {
      const out = ps.get(`${argv[2] === 'ppid=,args=' ? 'helper' : 'parent'}:${argv[argv.length - 1]}`)
      return out === undefined ? { exitCode: 1 } : { stdout: `${out}\n` }
    }
    if (argv[0] === 'kill') return { exitCode: alive.has(Number(argv[2])) ? 0 : 1 }
    return undefined
  })
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  const askpass = serve.argvs[0]?.[0] ?? ''

  return {
    clock,
    rec,
    alive,
    /** A helper `helperPid`, child of `parentPid`, asks with `prompt`. */
    async request(helperPid: number, parentPid: number, prompt: string, parentPs: string, helperArgs = `/bin/sh ${askpass} ${prompt}`) {
      ps.set(`helper:${helperPid}`, `${parentPid} ${helperArgs}`)
      ps.set(`parent:${parentPid}`, parentPs)
      alive.add(helperPid)
      serve.emit(`${helperPid}\t${prompt}\n`)
      await clock.settle()
    },
    replies() {
      return rec.runs.filter(run => run.argv[0] === 'sh')
    },
    mount(surface: (typeof SURFACES)[number]) {
      return $.ui.mount({ plugin: 'cc-askpass', surface, component: 'Pane', props: PANE_PROPS, requestId: 'askpass' })
    },
  }
}

/** Types `text` into a masked field one character at a time, as the field reports it. */
async function typeMasked(ui: any, key: string, text: string) {
  for (let i = 0; i < text.length; i++) {
    await ui.input({ key, text: '•'.repeat(i) + text[i], kind: 'change' })
  }
}

for (const surface of SURFACES) {
  test(`sudo request opens titled pane (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    expect(w.rec.opens.at(-1)).toEqual({ id: 'askpass', title: 'sudo password', focus: true, closeOnEscape: true })
    const ui = await w.mount(surface)
    expect(await ui.find({ text: /sudo apt update/ })).toBeDefined()
    expect(await ui.find({ text: /\[sudo\] password for alice/ })).toBeDefined()
  })

  test(`reply stdin is password plus newline (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, 'password-4242', PASSWORD)
    await ui.input({ key: 'password-4242', text: '•'.repeat(PASSWORD.length) })
    await w.clock.settle()
    expect(w.replies()).toEqual([
      { argv: ['sh', '-c', REPLY_SCRIPT, '_', `${SESSION_DIR}/reply.4242`], stdin: `${PASSWORD}\n` },
    ])
  })

  test(`masks sudo input (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, 'password-4242', 'abcx')
    expect((await ui.find({ key: 'password-4242' }))?.props.value).toBe('••••')
  })

  test(`toggle shows plain text (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, 'password-4242', 'abc')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'password-4242' }))?.props.value).toBe('abc')
  })

  test(`git username is not masked (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(5000, 4900, "Username for 'https://github.com': ", 'alice git git push')
    expect(w.rec.opens.at(-1)?.title).toBe('Password requested by git (pid 4900)')
    const ui = await w.mount(surface)
    await ui.input({ key: 'password-5000', text: 'alice', kind: 'change' })
    expect((await ui.find({ key: 'password-5000' }))?.props.value).toBe('alice')
  })

  test(`retry shows sorry hint (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    let ui = await w.mount(surface)
    await ui.input({ key: 'password-4242', text: '•' })
    await w.clock.settle()
    await ui.unmount()
    await w.request(4243, 4100, SUDO_PROMPT, SUDO_PARENT)
    ui = await w.mount(surface)
    expect(await ui.find({ text: /Sorry, try again/ })).toBeDefined()
  })
}

for (const surface of ['mobile'] as const) {
  test(`surface without an input points elsewhere (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await $.ui.mount({ plugin: 'cc-askpass', surface, component: 'Pane', props: PANE_PROPS, requestId: 'askpass' })
    expect(await ui.find({ text: /Answer this prompt in the terminal or the desktop app/ })).toBeDefined()
  })
}

test('forged request is rejected', async ($, on) => {
  const w = await world($, on)
  await w.request(6666, 6000, SUDO_PROMPT, SUDO_PARENT, '/bin/sh /tmp/evil.sh x')
  expect(w.rec.opens).toEqual([])
  expect(w.replies()).toEqual([])
  expect(w.rec.toasts.filter(text => text.includes('Rejected forged askpass request'))).toHaveLength(1)
})

test('cancel replies empty line', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  await ui.press({ key: 'cancel' })
  await w.clock.settle()
  expect(w.replies().map(reply => reply.stdin)).toEqual(['\n'])
  expect(w.rec.closes).toContain('askpass')
})

test('queue serves in order', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  await w.request(5000, 4900, 'Enter passphrase for key: ', 'alice ssh ssh -T git@github.com')
  expect(w.rec.opens).toHaveLength(1)
  const ui = await w.mount('terminal')
  await ui.input({ key: 'password-4242', text: 'x' })
  await w.clock.settle()
  expect(w.rec.opens.at(-1)?.title).toBe('Password requested by ssh (pid 4900)')
})

test('skips a queued request whose helper is gone', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  await w.request(5000, 4900, 'Enter passphrase for key: ', 'alice ssh ssh -T git@github.com')
  w.alive.delete(5000)
  const ui = await w.mount('terminal')
  await ui.input({ key: 'password-4242', text: 'x' })
  await w.clock.settle()
  expect(w.rec.opens).toHaveLength(1)
})

test('closes pane when helper dies', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  w.alive.delete(4242)
  await w.clock.advance(2000)
  expect(w.rec.closes).toContain('askpass')
  expect(w.replies()).toEqual([])
})

test('narrow terminal falls back to /askpass', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  expect(w.rec.statuses.at(-1)).toBe('sudo is waiting for a password — type /askpass')
  expect(w.rec.toasts).toHaveLength(1)
  w.rec.setPlaced(true)
  const opensBefore = w.rec.opens.length
  await $.command.run({ command: 'askpass', args: '' } as never)
  expect(w.rec.opens.length).toBe(opensBefore + 1)
  expect(w.rec.statuses).toEqual(['sudo is waiting for a password — type /askpass', undefined])
})

test('/askpass with nothing pending', async ($, on) => {
  const w = await world($, on)
  await $.command.run({ command: 'askpass', args: '' } as never)
  expect(w.rec.toasts).toContain('No pending password request')
})

test('password never leaks', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  await typeMasked(ui, 'password-4242', PASSWORD)
  await ui.input({ key: 'password-4242', text: '•'.repeat(PASSWORD.length) })
  await w.clock.settle()
  const shown = [...w.rec.toasts, ...w.rec.statuses, ...w.rec.logs].join('\n')
  expect(shown.includes(PASSWORD.trim())).toBe(false)
  expect(w.rec.runs.some(run => run.argv.some(arg => arg.includes(PASSWORD.trim())))).toBe(false)
})
