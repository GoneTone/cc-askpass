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
const REPLY_SCRIPT = '[ -p "$1" ] || exit 1; exec 3<>"$1"; [ -p /dev/fd/3 ] || { rm -f "$1"; exit 1; }; cat >&3'
const SUDO_PROMPT = '[sudo] password for alice: '
const SUDO_PARENT = 'root     sudo            sudo apt update'
const UNVERIFIED_WARNING =
  "This request did not come through cc-askpass's helper. Answer only if you know which program is asking."
const PASSWORD = '  p@ss \\w$rd é '


/** A session with a ready listener, canned `ps` output and helpers that are alive until told otherwise. */
async function world($: any, on: any) {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  const ps = new Map<string, string>()
  const exes = new Map<string, string>()
  const alive = new Set<number>()
  // Stands in for the Bash tool itself, beneath the plugin's tool.call hook: the shell runs
  // the command as the plugin passed it on.
  let ranCommand = ''
  on('tool.call', (_$: unknown, e: { command: string }) => {
    ranCommand = e.command
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  let isPsMissing = false
  let psTable = ''
  const rec = recorder(on, argv => {
    if (argv[0] === 'ps' && isPsMissing) throw new Error('ps: command not found')
    if (argv[0] === 'ps' && argv.includes('-e')) return { stdout: psTable }
    if (argv[0] === 'ps') {
      const out = ps.get(`${argv.includes('ppid=,args=') ? 'helper' : 'parent'}:${argv[argv.length - 1]}`)
      return out === undefined ? { exitCode: 1 } : { stdout: `${out}\n` }
    }
    // The shell's own kill: /bin/kill may be missing.
    if (argv[0] === 'sh' && argv[2] === 'kill -0 "$1"') return { exitCode: alive.has(Number(argv[4])) ? 0 : 1 }
    if (argv[0] === 'sh' && argv[1]?.endsWith('/bin/exe-of')) {
      const out = exes.get(argv[argv.length - 1] ?? '')
      return out === undefined ? { exitCode: 1 } : { stdout: `${out}\n` }
    }
    return undefined
  })
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  const askpass = serve.argvs[0]?.[0] ?? ''
  const shim = askpass.replace(/askpass$/, 'shim/ssh')

  return {
    clock,
    rec,
    alive,
    breakPs() {
      isPsMissing = true
    },
    /** Claude runs `command` with the Bash tool; sudo `sudoPid` runs inside that shell. */
    async bashCall(command: string, sudoPid: number) {
      await $.tool.call({ tool: 'Bash', command } as never)
      const quoted = ranCommand.replaceAll(`'`, `'"'"'`)
      psTable = [`${sudoPid} 950 sudo`, `950 900 /bin/bash -c source /x && eval '${quoted}' < /dev/null`, '900 1 claude'].join('\n')
    },
    /**
     * Helper `id` asks through the relay (pid 4100) of the ssh wrapper (pid 3900),
     * which runs `<shim> <wrapperArgs>`; the relay's args are `<sh> <relayArgs>`.
     */
    async relayRequest(
      id: number,
      line: { prompt: string; via?: string; reported?: string },
      options: { relayArgs?: string; wrapperArgs?: string } = {},
    ) {
      const relayArgs = `/bin/sh ${options.relayArgs ?? `${shim} --relay server`}`
      ps.set(`helper:${id}`, `4100 /bin/sh ${askpass} ${line.prompt}`)
      ps.set('parent:4100', `alice ssh ${relayArgs}`)
      // The relay is a script: its executable is the shell.
      exes.set('4100', '0 /usr/bin/dash')
      alive.add(id)
      alive.add(4100)
      // The Bash tool's shell from `bashCall`, or one that ran something else.
      const shell = psTable.split('\n').filter(row => row.startsWith('950 '))
      const rows = [...(shell.length > 0 ? shell : ['950 900 /bin/bash -c x']), '900 1 claude']
      psTable = [`4100 3900 ${relayArgs}`, `3900 950 /bin/sh ${shim} ${options.wrapperArgs ?? 'server sudo apt update'}`, ...rows].join('\n')
      serve.emit(`${id}\t${line.prompt}\t${line.via ?? ''}\t${line.reported ?? ''}\n`)
      await clock.settle()
    },
    /**
     * Sets up helper `id`, child of `parentPid`, asking with `prompt`; `exe` is the
     * parent's `<owner uid> <executable>` (a root-owned /usr/bin/<comm> by default; null: unknown).
     */
    stage(id: number, parentPid: number, prompt: string, parentPs: string, options: { helperArgs?: string; exe?: string | null } = {}) {
      ps.set(`helper:${id}`, `${parentPid} ${options.helperArgs ?? `/bin/sh ${askpass} ${prompt}`}`)
      ps.set(`parent:${parentPid}`, parentPs)
      if (options.exe !== null) exes.set(String(parentPid), options.exe ?? `0 /usr/bin/${parentPs.split(/\s+/)[1]}`)
      alive.add(id)
      return `${id}\t${prompt}\n`
    },
    /** A helper asks (see `stage`) and the mod has handled the request. */
    async request(id: number, parentPid: number, prompt: string, parentPs: string, options: { helperArgs?: string; exe?: string | null } = {}) {
      serve.emit(this.stage(id, parentPid, prompt, parentPs, options))
      await clock.settle()
    },
    emit(text: string) {
      serve.emit(text)
    },
    replies() {
      return rec.runs.filter(run => run.argv[0] === 'sh' && run.argv[2] === REPLY_SCRIPT)
    },
    mount(surface: (typeof SURFACES)[number]) {
      return $.ui.mount({ plugin: 'cc-askpass', surface, component: 'Pane', props: PANE_PROPS, requestId: 'askpass' })
    },
  }
}

type Drawn = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

function findBox(node: unknown, match: (box: Drawn) => boolean): Drawn | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const drawn = node as Drawn
  if (drawn.type === 'Box' && match(drawn)) return drawn
  for (const child of drawn.children ?? []) {
    const found = findBox(child, match)
    if (found !== undefined) return found
  }
  return undefined
}

function hasChild(box: Drawn, type: string, key?: string): boolean {
  return (box.children ?? []).some(child => {
    const drawn = child as Drawn
    return drawn?.type === type && (key === undefined || drawn.props?.key === key || drawn.key === key)
  })
}

/** The password Input's key: per request and per module load, so read it off the drawing. */
async function passwordKey(ui: any): Promise<string> {
  return (await ui.find({ type: 'Input' }))?.key ?? ''
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
    // rows: warning 2 + heading 1 + Asked by 1 + `$` 1 + prompt 1 + field 1 + Cancel 1 + 2 blank lines.
    expect(w.rec.opens.at(-1)).toEqual({
      id: 'askpass',
      title: 'sudo password',
      focus: true,
      closeOnEscape: true,
      rows: 10,
      columns: 60,
    })
    const ui = await w.mount(surface)
    expect(await ui.find({ text: /sudo needs your password/ })).toBeDefined()
    expect(await ui.find({ text: /sudo apt update/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\[sudo\] password for alice$/ })).toBeDefined()
    expect((await ui.find({ type: 'Input' }))?.props.label).toBeUndefined()
    // The field and its Show button share a row; Cancel sits on its own below.
    const row = findBox(await ui.drawn(), box => box.props?.flexDirection === 'row' && hasChild(box, 'Input'))
    expect(row !== undefined && hasChild(row, 'Button', 'toggle') && !hasChild(row, 'Button', 'cancel')).toBe(true)
    expect(await ui.find({ text: /\$ sudo apt update/ })).toBeDefined()
  })

  test(`reply stdin is password plus newline (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, await passwordKey(ui), PASSWORD)
    await ui.input({ key: await passwordKey(ui), text: '•'.repeat(PASSWORD.length) })
    await w.clock.settle()
    expect(w.replies()).toEqual([
      { argv: ['sh', '-c', REPLY_SCRIPT, '_', `${SESSION_DIR}/reply.4242`], stdin: `${PASSWORD}\n` },
    ])
  })

  test(`warns when the pane does not hold the keyboard (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const unfocused = await $.ui.mount({
      plugin: 'cc-askpass',
      surface,
      component: 'Pane',
      props: { ...PANE_PROPS, isFocused: false },
      requestId: 'askpass',
    })
    expect(await unfocused.find({ text: /your keys are going to the prompt below/ })).toBeDefined()
    await unfocused.unmount()
    const focused = await w.mount(surface)
    expect(await focused.find({ text: /your keys are going to the prompt below/ })).toBeUndefined()
  })

  test(`password Input key is per request and per module load (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    // After a reload the same request comes back; an Input keeps old text under an old key.
    expect(await passwordKey(await w.mount(surface))).toMatch(/^password-4242-\w+$/)
  })

  test(`masks sudo input (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, await passwordKey(ui), 'abcx')
    expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('••••')
  })

  test(`toggle shows plain text (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    const ui = await w.mount(surface)
    await typeMasked(ui, await passwordKey(ui), 'abc')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('abc')
  })

  test(`git username is not masked (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(5000, 4900, "Username for 'https://github.com': ", 'alice git-remote-http git-remote-https origin https://github.com/a/b')
    expect(w.rec.opens.at(-1)?.title).toBe('Password requested by git-remote-http (pid 4900)')
    const ui = await w.mount(surface)
    await ui.input({ key: await passwordKey(ui), text: 'alice', kind: 'change' })
    expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('alice')
  })

  test(`retry shows sorry hint (${surface})`, async ($, on) => {
    const w = await world($, on)
    await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
    let ui = await w.mount(surface)
    await ui.input({ key: await passwordKey(ui), text: '•' })
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

test('shows the command Claude ran when it is not the sudo command itself', async ($, on) => {
  const w = await world($, on)
  await w.bashCall(`sudo -k && sudo apt update`, 4100)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  expect((await ui.find({ text: /Claude ran:/ }))?.text).toContain('sudo -k && sudo apt update')
})

test('skips the Claude line when Claude ran the sudo command directly', async ($, on) => {
  const w = await world($, on)
  await w.bashCall('sudo apt update', 4100)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  expect(await ui.find({ text: /Claude ran:/ })).toBeUndefined()
})

test('skips the Claude line when no Bash call matches', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  expect(await ui.find({ text: /Claude ran:/ })).toBeUndefined()
})

test('a short pane still shows every section', async ($, on) => {
  const w = await world($, on)
  await w.bashCall('sudo -k && sudo true', 4100)
  await w.request(4242, 4100, SUDO_PROMPT, 'root sudo sudo true')
  // Six body rows, as on a 28-row terminal: nothing is hidden to fit.
  const ui = await $.ui.mount({
    plugin: 'cc-askpass',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, isFocused: false, bodyColumns: 96, scroll: { offset: 0, bodyRows: 6 } },
    requestId: 'askpass',
  })
  expect(await ui.find({ text: /your keys are going to the prompt below/ })).toBeDefined()
  expect(await ui.find({ text: /sudo needs your password/ })).toBeDefined()
  expect(await ui.find({ text: /Claude ran: sudo -k && sudo true/ })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
})

test('a tall pane shows everything', async ($, on) => {
  const w = await world($, on)
  await w.bashCall('sudo -k && sudo true', 4100)
  await w.request(4242, 4100, SUDO_PROMPT, 'root sudo sudo true')
  const ui = await $.ui.mount({
    plugin: 'cc-askpass',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, isFocused: false, bodyColumns: 96, scroll: { offset: 0, bodyRows: 30 } },
    requestId: 'askpass',
  })
  expect(await ui.find({ text: /sudo needs your password/ })).toBeDefined()
  expect(await ui.find({ text: /Claude ran: sudo -k && sudo true/ })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
})

test('clips a long sudo command to three rows', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, `root sudo sudo cp ${'x'.repeat(400)} /opt`)
  const ui = await w.mount('terminal')
  const line = (await ui.find({ type: 'Text', text: /^\$ sudo cp/ }))?.text ?? ''
  expect(line.endsWith('…')).toBe(true)
  expect(line.length).toBeLessThanOrEqual(180)
})

test('asks for the rows its content needs', async ($, on) => {
  const w = await world($, on)
  await w.bashCall('sudo -k && ./install.sh', 4100)
  await w.request(4242, 4100, SUDO_PROMPT, `root sudo sudo cp ${'x'.repeat(400)} /opt`)
  // 10 for a plain request, plus the Claude line (1) and two more rows of the clipped `$` line.
  expect(w.rec.opens.at(-1)?.rows).toBe(13)
})

test('asks ps for whole command lines', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const psCalls = w.rec.runs.filter(run => run.argv[0] === 'ps')
  expect(psCalls.length).toBeGreaterThan(0)
  for (const call of psCalls) expect(call.argv).toContain('-ww')
})

test('a pane already open redraws when a request arrives', async ($, on) => {
  const w = await world($, on)
  // After a reload the pane survives; the resent request must reach its drawing.
  const ui = await w.mount('terminal')
  expect(await ui.find({ text: /No pending password request/ })).toBeDefined()
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  expect(await ui.find({ text: /sudo needs your password/ })).toBeDefined()
})

test('a request not from our helper shows as unverified', async ($, on) => {
  const w = await world($, on)
  await w.request(6666, 6000, SUDO_PROMPT, SUDO_PARENT, { helperArgs: '/bin/sh /tmp/evil.sh x' })
  expect(w.rec.opens).toHaveLength(1)
  const ui = await w.mount('terminal')
  expect((await ui.find({ type: 'Text', text: /^Asked by:/ }))?.text).toBe('Asked by: unknown program (unverified)')
  expect(await ui.find({ type: 'Text', text: UNVERIFIED_WARNING })).toBeDefined()
  expect(w.rec.toasts.filter(text => text.includes('Rejected'))).toEqual([])
  await ui.input({ key: await passwordKey(ui), text: 'x' })
  await w.clock.settle()
  expect(w.replies().map(reply => reply.argv.at(-1))).toEqual([`${SESSION_DIR}/reply.6666`])
})

test('a failing ps check toasts and answers empty', async ($, on) => {
  const w = await world($, on)
  w.breakPs()
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  expect(w.rec.opens).toEqual([])
  expect(w.rec.toasts.filter(text => text.includes('could not check an askpass request'))).toHaveLength(1)
  expect(w.replies().map(reply => reply.stdin)).toEqual(['\n'])
})

test('a failing pane open keeps the request for /askpass', async ($, on) => {
  const w = await world($, on)
  w.rec.breakOpen()
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  // The checks passed: the helper must not be answered, and the toast must not blame them.
  expect(w.replies()).toEqual([])
  expect(w.rec.toasts.filter(text => text.includes('could not check'))).toEqual([])
  expect(await (await w.mount('terminal')).find({ text: /sudo needs your password/ })).toBeDefined()
})

test('askpass run from a shell shows the shell', async ($, on) => {
  const w = await world($, on)
  await w.request(7000, 6900, SUDO_PROMPT, 'alice bash bash -c x', { exe: '1000 /usr/bin/bash' })
  expect(w.rec.opens).toHaveLength(1)
  expect((await (await w.mount('terminal')).find({ text: /^Asked by:/ }))?.text).toBe('Asked by: /usr/bin/bash')
})

test('a user-owned client shows its path', async ($, on) => {
  const w = await world($, on)
  await w.request(7000, 6900, 'Enter passphrase for key: ', 'alice ssh ssh -T host', { exe: '1000 /tmp/ssh' })
  expect(w.rec.opens).toHaveLength(1)
  expect((await (await w.mount('terminal')).find({ text: /^Asked by:/ }))?.text).toBe('Asked by: /tmp/ssh')
})

test('sudo shows its executable', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  expect((await ui.find({ text: /^Asked by:/ }))?.text).toBe('Asked by: /usr/bin/sudo')
  expect(await ui.find({ text: UNVERIFIED_WARNING })).toBeUndefined()
  await ui.press({ key: 'cancel' })
  await w.clock.settle()
  await ui.unmount()
  await w.request(4243, 4101, SUDO_PROMPT, SUDO_PARENT, { exe: null })
  expect((await (await w.mount('terminal')).find({ text: /^Asked by:/ }))?.text).toBe('Asked by: sudo (root)')
})

test('two requests in one chunk open one pane at a time', async ($, on) => {
  const w = await world($, on)
  w.emit(
    w.stage(4242, 4100, SUDO_PROMPT, SUDO_PARENT) +
      w.stage(5000, 4900, 'Enter passphrase for key: ', 'alice ssh ssh -T git@github.com'),
  )
  await w.clock.settle()
  expect(w.rec.opens).toHaveLength(1)
  const ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'x' })
  await w.clock.settle()
  expect(w.rec.opens.map(open => open.title)).toEqual(['sudo password', 'Password requested by ssh (pid 4900)'])
})

test('enter then cancel sends one reply', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await w.mount('terminal')
  await Promise.allSettled([ui.input({ key: await passwordKey(ui), text: 'x' }), ui.press({ key: 'cancel' })])
  await w.clock.settle()
  // Whichever lands first answers; the other must not send a second reply.
  expect(w.replies()).toHaveLength(1)
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
  await ui.input({ key: await passwordKey(ui), text: 'x' })
  await w.clock.settle()
  expect(w.rec.opens.at(-1)?.title).toBe('Password requested by ssh (pid 4900)')
})

test('skips a queued request whose helper is gone', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  await w.request(5000, 4900, 'Enter passphrase for key: ', 'alice ssh ssh -T git@github.com')
  w.alive.delete(5000)
  const ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'x' })
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

const WAITING = 'sudo is waiting for a password — click the button below or type /askpass'
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
} as const

// The terminal's main screen (fullscreen off) reports no clicks.
const MAIN_SCREEN = { columns: 100, rows: 40, isFullscreen: false }

function mountBand($: any, hasSurvey = false, viewport?: typeof MAIN_SCREEN) {
  return $.ui.mount({
    plugin: 'cc-askpass',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, hasSurvey },
    ...(viewport === undefined ? {} : { viewport }),
  })
}

test('narrow terminal shows a band button instead of the pane', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const band = await mountBand($)
  expect((await band.find({ type: 'Text', text: /sudo is waiting for a password/ }))?.text).toContain(WAITING)
  const button = await band.find({ key: 'open-askpass' })
  expect(button?.props.label).toBe('Open password prompt')
  // ctrl+x tab hands the band the keys; the ring must start on the button for Enter to press it.
  expect(button?.props.autoFocus).toBe(true)
  // The hint gets a line of its own so it does not wrap around the button.
  const row = findBox(await band.drawn(), box => hasChild(box, 'Button', 'open-askpass'))
  expect(row !== undefined && hasChild(row, 'Text')).toBe(false)
  expect(w.rec.toasts).toEqual([])
})

test('band hint on the main screen points at keys, not clicks', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const text = (await (await mountBand($, false, MAIN_SCREEN)).find({ type: 'Text', text: /waiting for a password/ }))?.text ?? ''
  expect(text).toContain('sudo is waiting for a password — press ctrl+x tab then Enter, or type /askpass')
  expect(text).not.toContain('click')
})

test('focus warning on the main screen points at keys, not clicks', async ($, on) => {
  const w = await world($, on)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const ui = await $.ui.mount({
    plugin: 'cc-askpass',
    surface: 'terminal',
    component: 'Pane',
    props: { ...PANE_PROPS, isFocused: false },
    requestId: 'askpass',
    viewport: MAIN_SCREEN,
  })
  const text = (await ui.find({ text: /your keys are going to the prompt below/ }))?.text ?? ''
  expect(text).toContain('Press ctrl+x tab before typing')
  expect(text).not.toContain('Click')
})

test('band button opens the pane and goes away', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  const band = await mountBand($)
  w.rec.setPlaced(true)
  const opensBefore = w.rec.opens.length
  // The press lasts until the pane is open: an open after it would count as unasked.
  const pressing = band.press({ key: 'open-askpass' })
  await w.clock.settle()
  // The band lets go of the keyboard first: a pane opened while it holds the keys gets none.
  expect(await band.find({ key: 'open-askpass' })).toBeUndefined()
  expect(w.rec.opens.length).toBe(opensBefore)
  await w.clock.advance(150)
  await pressing
  expect(w.rec.opens.length).toBe(opensBefore + 1)
})

test('/askpass still opens the pane from a narrow terminal', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  w.rec.setPlaced(true)
  const opensBefore = w.rec.opens.length
  await $.command.run({ command: 'askpass', args: '' } as never)
  expect(w.rec.opens.length).toBe(opensBefore + 1)
  expect(await (await mountBand($)).find({ key: 'open-askpass' })).toBeUndefined()
})

test('band hint goes away when the request ends', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  w.alive.delete(4242)
  await w.clock.advance(2000)
  expect(await (await mountBand($)).find({ key: 'open-askpass' })).toBeUndefined()
})

test('band yields to a survey', async ($, on) => {
  const w = await world($, on)
  w.rec.setPlaced(false)
  await w.request(4242, 4100, SUDO_PROMPT, SUDO_PARENT)
  expect(await (await mountBand($, true)).find({ key: 'open-askpass' })).toBeUndefined()
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
  await typeMasked(ui, await passwordKey(ui), PASSWORD)
  await ui.input({ key: await passwordKey(ui), text: '•'.repeat(PASSWORD.length) })
  await w.clock.settle()
  const shown = [...w.rec.toasts, ...w.rec.logs].join('\n')
  expect(shown.includes(PASSWORD.trim())).toBe(false)
  expect(w.rec.runs.some(run => run.argv.some(arg => arg.includes(PASSWORD.trim())))).toBe(false)
})

const REMOTE_WARNING =
  'A remote prompt can be raised by any program running as you. Answer only if you expected this command to need a password on this host.'
const BOB_PROMPT = '[sudo] password for bob: '

test('accepts a request relayed by the ssh wrapper', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo apt update' })
  expect(w.rec.opens).toHaveLength(1)
  const ui = await w.mount('terminal')
  expect((await ui.find({ text: /^Asked by:/ }))?.text).toBe('Asked by: cc-askpass ssh wrapper → server')
  expect((await ui.find({ type: 'Text', text: /needs/ }))?.text).toBe('sudo on server needs your password')
  expect(await ui.find({ type: 'Text', text: /^remote$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^\$ / }))?.text).toBe('$ sudo apt update (reported by server)')
  expect(await ui.find({ type: 'Text', text: /^\[sudo\] password for bob$/ })).toBeDefined()
  // No Bash call matched: the line still shows, so the person sees nothing vouches for it.
  expect((await ui.find({ type: 'Text', text: /^Claude ran:/ }))?.text).toBe('Claude ran: (unknown)')
  expect(await ui.find({ type: 'Text', text: REMOTE_WARNING })).toBeDefined()
  expect((await ui.find({ key: await passwordKey(ui) })) !== undefined).toBe(true)
  await typeMasked(ui, await passwordKey(ui), 'ab')
  expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('••')
})

test('labels a second hop', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'db01 via server', reported: '/usr/bin/sudo -A true' })
  const ui = await w.mount('terminal')
  expect((await ui.find({ type: 'Text', text: /needs/ }))?.text).toBe('sudo on db01 via server needs your password')
})

test('names an unreported program on the host', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: 'Password: ' })
  const ui = await w.mount('terminal')
  expect((await ui.find({ type: 'Text', text: /needs/ }))?.text).toBe('a program on server needs a password')
  expect((await ui.find({ type: 'Text', text: /^\$ / }))?.text).toBe('$ (not reported by server)')
})

test('remote text loses its control characters', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: 'Pass\u001b[2Jword: ', via: 'db\u009b01', reported: 'sudo \u001b]0;x\u0007true' })
  const ui = await w.mount('terminal')
  // JSON writes C0 controls as \u00XX and leaves C1 controls as they are.
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.includes('\\u00')).toBe(false)
  expect(/[\u007f-\u009f]/.test(drawn)).toBe(false)
  // A via with anything but host names in it is not shown at all.
  expect((await ui.find({ type: 'Text', text: /needs/ }))?.text).toBe('sudo on server needs your password')
})

test('a remote username prompt is shown in clear, unless sudo reported it', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: "Username for 'https://x': ", reported: 'git pull' })
  let ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'bob', kind: 'change' })
  expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('bob')
  await ui.press({ key: 'cancel' })
  await w.clock.settle()
  await ui.unmount()
  await w.relayRequest(4243, { prompt: "Username for 'https://x': ", reported: 'sudo -u bob git pull' })
  ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'b', kind: 'change' })
  expect((await ui.find({ key: await passwordKey(ui) }))?.props.value).toBe('•')
})

test('a relay script outside the plugin shows as a program', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server' }, { relayArgs: '/tmp/x/bin/shim/ssh --relay server' })
  expect(w.rec.opens).toHaveLength(1)
  const ui = await w.mount('terminal')
  expect((await ui.find({ text: /^Asked by:/ }))?.text).toBe('Asked by: /usr/bin/dash')
  expect(await ui.find({ type: 'Text', text: /^remote$/ })).toBeUndefined()
})

for (const wrapperArgs of ['other sudo apt update', '-p 22 evil server', '--relay server']) {
  test(`a relay is labelled by its own host argument (${wrapperArgs})`, async ($, on) => {
    const w = await world($, on)
    await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server' }, { wrapperArgs })
    expect(w.rec.opens).toHaveLength(1)
    expect((await (await w.mount('terminal')).find({ text: /^Asked by:/ }))?.text).toBe('Asked by: cc-askpass ssh wrapper → server')
  })
}

test('Claude ran matching uses the command as Claude wrote it', async ($, on) => {
  const w = await world($, on)
  await w.bashCall('ssh server sudo apt update', 0)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo apt update' })
  const ui = await w.mount('terminal')
  expect((await ui.find({ type: 'Text', text: /^Claude ran:/ }))?.text).toBe('Claude ran: ssh server sudo apt update')
})

test('closes a relayed request when its relay is gone', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo true' })
  w.alive.delete(4100)
  await w.clock.advance(2000)
  expect(w.rec.closes).toContain('askpass')
  expect(w.replies()).toEqual([])
})

test('a remote retry shows the sorry hint', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo true' })
  let ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: '•' })
  await w.clock.settle()
  await ui.unmount()
  await w.relayRequest(4243, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo true' })
  ui = await w.mount('terminal')
  expect(await ui.find({ text: /Sorry, try again/ })).toBeDefined()
})

test('password never leaks from a relayed request', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo apt update' })
  const ui = await w.mount('terminal')
  await typeMasked(ui, await passwordKey(ui), PASSWORD)
  await ui.input({ key: await passwordKey(ui), text: '•'.repeat(PASSWORD.length) })
  await w.clock.settle()
  expect(w.replies()).toEqual([
    { argv: ['sh', '-c', REPLY_SCRIPT, '_', `${SESSION_DIR}/reply.4242`], stdin: `${PASSWORD}\n` },
  ])
  const shown = [...w.rec.toasts, ...w.rec.logs, ...w.rec.opens.map(open => open.title ?? '')].join('\n')
  expect(shown.includes(PASSWORD.trim())).toBe(false)
  expect(w.rec.runs.some(run => run.argv.some(arg => arg.includes(PASSWORD.trim())))).toBe(false)
})

test('rejects relayed requests with remoteHosts off', { options: { remoteHosts: false } }, async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'server', reported: 'sudo true' })
  expect(w.rec.opens).toEqual([])
  expect(w.replies().map(reply => reply.stdin)).toEqual(['\n'])
  expect(w.rec.toasts).toEqual([])
  expect(w.rec.logs).toContain('cc-askpass: rejected a remote request: remoteHosts is off')
})

test('a remote username then password is no retry', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: "Username for 'https://x': ", via: 'server', reported: 'git pull' })
  let ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'bob' })
  await w.clock.settle()
  await ui.unmount()
  await w.relayRequest(4243, { prompt: "Password for 'https://bob@x': ", via: 'server', reported: 'git pull' })
  ui = await w.mount('terminal')
  expect(await ui.find({ text: /Password for/ })).toBeDefined()
  expect(await ui.find({ text: /Sorry, try again/ })).toBeUndefined()
})

test('a via that is not a host chain is left out', async ($, on) => {
  const w = await world($, on)
  await w.relayRequest(4242, { prompt: BOB_PROMPT, via: 'this computer', reported: 'sudo true' })
  const ui = await w.mount('terminal')
  expect((await ui.find({ type: 'Text', text: /needs/ }))?.text).toBe('sudo on server needs your password')
})

/** Answers the open relayed request, then relays `next` from the same relay. */
async function answerThenRelay(w: any, $: any, first: { prompt: string; reported: string }, next: { prompt: string; reported: string }) {
  await w.relayRequest(4242, { ...first, via: 'server' })
  let ui = await w.mount('terminal')
  await ui.input({ key: await passwordKey(ui), text: 'x' })
  await w.clock.settle()
  await ui.unmount()
  await w.relayRequest(4243, { ...next, via: 'server' })
  ui = await w.mount('terminal')
  return ui.find({ text: /Sorry, try again/ })
}

test('only a remote sudo is taken to retry', async ($, on) => {
  const w = await world($, on)
  const ask = { prompt: "Password for 'https://bob@x': ", reported: 'git pull' }
  expect(await answerThenRelay(w, $, ask, ask)).toBeUndefined()
})

test('a remote sudo asking something else is no retry', async ($, on) => {
  const w = await world($, on)
  const sorry = await answerThenRelay(w, $, { prompt: BOB_PROMPT, reported: 'sudo true' }, { prompt: 'Verification code: ', reported: 'sudo true' })
  expect(sorry).toBeUndefined()
})
