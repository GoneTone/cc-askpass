import { expect, mock, test } from 'claude-code/testing'

import type { ProcessRunResult } from 'claude-code'

import { fnv1a64 } from './core'
import {
  SESSION_DIR,
  SESSION_ID,
  WIN_PATH,
  WIN_PIPE,
  WIN_SOURCE,
  WIN_TOKEN,
  fakeServe,
  recorder,
  windowsWorld,
} from './testkit'

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const ASKPASS_VARS = ['CC_ASKPASS_DIR', 'CC_ASKPASS_EXCLUDE', 'CC_ASKPASS_WRAP', 'SUDO_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE']

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
  expect(rec.envSets.filter(set => set.name !== 'PATH')).toEqual([])
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
  expect(rec.envSets.filter(set => set.name !== 'PATH')).toEqual([])
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
  expect(rec.envSets.filter(set => set.name !== 'PATH')).toEqual([])
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

async function sudoNote($: any) {
  // What the engine passes when it renders a system prompt.
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash'],
    outputStyle: null,
    traits: [],
    sections: [],
  })
  return sections.find((section: { id: string }) => section.id === 'cc-askpass:sudo')
}

test('tells the model sudo can ask once the listener is ready', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  recorder(on)
  await $.session.start(START)
  await clock.settle()
  expect(await sudoNote($)).toBeUndefined()
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  const note = await sudoNote($)
  expect(note?.scope).toBe('session')
  expect(note?.text).toContain('Do not add `-n` or `-S`')
})

test('drops the sudo note when the listener stops', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  const serve = fakeServe(on)
  recorder(on)
  await $.session.start(START)
  serve.emit(`ready\t${SESSION_DIR}\n`)
  await clock.settle()
  serve.end()
  await clock.settle()
  expect(await sudoNote($)).toBeUndefined()
})

test('no sudo note without a person at the prompt', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {})
  fakeServe(on)
  recorder(on)
  await $.session.start({ ...START, isInteractive: false })
  await clock.settle()
  expect(await sudoNote($)).toBeUndefined()
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

/** A session whose Bash commands reach a stand-in tool, recorded; the listener is ready on demand. */
async function bashWorld($: any, on: any, env: Record<string, string> = { PATH: '/usr/bin:/bin' }) {
  const clock = mock.clock(on)
  mock.env(on, env)
  const serve = fakeServe(on)
  const rec = recorder(on)
  const ran: string[] = []
  // Stands in for the Bash tool itself, beneath the plugin's tool.call hook.
  on('tool.call', (_$: unknown, e: { command: string }) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()
  const root = (serve.argvs[0]?.[0] ?? '').replace(/\/bin\/askpass$/, '')
  return {
    rec,
    root,
    async ready() {
      serve.emit(`ready\t${SESSION_DIR}\n`)
      await clock.settle()
    },
    async stop() {
      serve.end()
      await clock.settle()
    },
    async bash(command: string) {
      await $.tool.call({ tool: 'Bash', command } as never)
      return ran.at(-1) ?? ''
    },
  }
}

// The Bash tool takes PATH from a shell snapshot made as the session starts; a command that
// changed it would lose the permission dialog's "don't ask again" option.
test('puts the shim directory first on PATH as the session starts', async ($, on) => {
  const w = await bashWorld($, on)
  expect(w.rec.envValue('PATH')).toBe(`${w.root}/bin/shim:/usr/bin:/bin`)
})

test('leaves Bash commands as Claude wrote them', async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  expect(await w.bash('ssh h sudo true')).toBe('ssh h sudo true')
})

test('no PATH change without a person at the prompt', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { PATH: '/usr/bin' })
  fakeServe(on)
  const rec = recorder(on)
  await $.session.start({ ...START, isInteractive: false })
  await clock.settle()
  expect(rec.envSets.some(set => set.name === 'PATH')).toBe(false)
})

test('switches remote prompts on while listening', async ($, on) => {
  const w = await bashWorld($, on)
  expect(w.rec.envValue('CC_ASKPASS_WRAP')).toBe(undefined)
  await w.ready()
  expect(w.rec.envValue('CC_ASKPASS_WRAP')).toBe('1')
  await w.stop()
  expect(w.rec.envValue('CC_ASKPASS_WRAP')).toBe(undefined)
})

// The shim stays on PATH; the wrapper steps aside unless this is 1, so the option takes
// effect both ways without a new session.
test('remoteHosts off keeps the switch off', { options: { remoteHosts: false } }, async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  expect(w.rec.envValue('PATH')).toBe(`${w.root}/bin/shim:/usr/bin:/bin`)
  expect(w.rec.envSets.some(set => set.name === 'CC_ASKPASS_WRAP' && set.value === '1')).toBe(false)
})

test('sets CC_ASKPASS_EXCLUDE from excludeHosts', { options: { excludeHosts: ['*.internal', 'git.example.com'] } }, async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  expect(w.rec.envValue('CC_ASKPASS_EXCLUDE')).toBe('*.internal\ngit.example.com')
})

test('the sudo note mentions ssh', async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  expect((await sudoNote($))?.text).toContain('ssh host sudo')
})

test('the sudo note leaves out ssh with remoteHosts off', { options: { remoteHosts: false } }, async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  const text = (await sudoNote($))?.text ?? ''
  expect(text).toContain('Do not add `-n` or `-S`')
  expect(text).not.toContain('ssh host sudo')
})

test('CC_ASKPASS_EXCLUDE is empty by default', async ($, on) => {
  const w = await bashWorld($, on)
  await w.ready()
  expect(w.rec.envValue('CC_ASKPASS_EXCLUDE')).toBe('')
})

const BUILD_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * A native Windows session started with a person at the prompt; the build exits as `build` says,
 * and the built helper, run bare to see that it runs at all, as `check` says.
 */
async function winWorld(
  $: any,
  on: any,
  options: {
    isBuilt?: boolean | (() => boolean)
    source?: string | null
    env?: Record<string, string>
    store?: Record<string, unknown>
    build?: Partial<ProcessRunResult> | { deny: string }
    check?: Partial<ProcessRunResult> | (() => Partial<ProcessRunResult> | undefined)
  } = {},
) {
  const clock = mock.clock(on)
  mock.store(on, options.store)
  const win = windowsWorld(on, options)
  const serve = fakeServe(on)
  const rec = recorder(on, argv => {
    if (argv[0] === POWERSHELL) return options.build
    if (argv.length !== 1 || !argv[0]?.endsWith('\\cc-askpass.exe')) return undefined
    return typeof options.check === 'function' ? options.check() : options.check
  })
  await $.session.start(START)
  await clock.settle()
  const outDir = `${win.root()}\\win\\out\\${fnv1a64(WIN_SOURCE)}`
  return {
    clock,
    rec,
    serve,
    root: win.root(),
    outDir,
    exe: `${outDir}\\cc-askpass.exe`,
    builds: () => rec.runs.filter(run => run.argv[0] === POWERSHELL),
    async ready() {
      serve.emit(`ready\t${WIN_PIPE}\t${WIN_TOKEN}\t${outDir}\\cc-askpass.exe\n`)
      await clock.settle()
    },
    async stop() {
      serve.end()
      await clock.settle()
    },
  }
}

test('Windows builds the helper only when missing', async ($, on) => {
  const w = await winWorld($, on, { isBuilt: false })
  expect(w.builds().map(run => run.argv)).toEqual([
    [POWERSHELL, ...BUILD_ARGS, `${w.root}\\win\\build.ps1`, `${w.root}\\win\\cc-askpass.cs`, w.outDir],
  ])
})

test('Windows does not build a helper that exists', async ($, on) => {
  const w = await winWorld($, on)
  expect(w.builds()).toEqual([])
})

test('Windows puts the shim first with ;', async ($, on) => {
  const w = await winWorld($, on)
  expect(w.rec.envValue('PATH')).toBe(`${w.outDir}\\shim;${WIN_PATH}`)
})

test('Windows defines the bash ssh function', async ($, on) => {
  const w = await winWorld($, on)
  const ssh = `${w.outDir}\\shim\\ssh.exe`.replaceAll('\\', '/')
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(`() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' '${ssh}' "$@"\n}`)
})

test('Windows runs the built helper once before it touches PATH', async ($, on) => {
  const w = await winWorld($, on)
  // Bare and without the pipe: a helper that runs says CC_ASKPASS_PIPE is not set.
  expect(w.rec.runs.filter(run => run.argv[0] === w.exe)).toEqual([{ argv: [w.exe], env: { CC_ASKPASS_PIPE: '' } }])
  expect(w.rec.envSets.map(set => set.name)).toEqual(['BASH_FUNC_ssh%%', 'PATH'])
})

for (const [what, check] of [
  ['is blocked', { exitCode: 1, stderr: 'This program is blocked by group policy.\r\n' }],
  ['exits 0', { exitCode: 0, stderr: '' }],
  ['fails without its message', { exitCode: 1, stderr: '' }],
] as const) {
  test(`a Windows helper that ${what} toasts and changes nothing`, async ($, on) => {
    const w = await winWorld($, on, { check })
    expect(w.rec.toasts).toHaveLength(1)
    expect(w.rec.toasts[0]).toMatch(/^cc-askpass: could not run the Windows helper: \S/)
    expect(w.rec.envSets).toEqual([])
    expect(w.serve.argvs).toEqual([])
    expect(await sudoNote($)).toBeUndefined()
  })
}

test('a blocked Windows helper names the reason', async ($, on) => {
  const w = await winWorld($, on, { check: { exitCode: 1, stderr: 'This program is blocked by group policy.\r\n' } })
  expect(w.rec.toasts).toEqual(['cc-askpass: could not run the Windows helper: This program is blocked by group policy.'])
})

test('a Windows listener that never becomes ready takes the shim back off', async ($, on) => {
  const w = await winWorld($, on)
  expect(w.rec.envValue('PATH')).toBe(`${w.outDir}\\shim;${WIN_PATH}`)
  await w.clock.advance(5000)
  expect(w.rec.toasts).toHaveLength(1)
  expect(w.rec.envValue('PATH')).toBe(WIN_PATH)
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(undefined)
})

test('a Windows listener that ends takes the shim back off', async ($, on) => {
  const w = await winWorld($, on)
  await w.ready()
  await w.stop()
  expect(w.rec.envValue('PATH')).toBe(WIN_PATH)
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(undefined)
})

test("a Windows listener that ends puts back the person's own ssh function", async ($, on) => {
  const own = '() {  command ssh -v "$@"\n}'
  const w = await winWorld($, on, { env: { 'BASH_FUNC_ssh%%': own } })
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).not.toBe(own)
  await w.ready()
  await w.stop()
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(own)
})

test("a reload still puts back the person's own ssh function", async ($, on) => {
  // The env holds the function an earlier load set; the store holds what that load found.
  const own = '() {  command ssh -v "$@"\n}'
  const ours = `() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' 'C:/old/shim/ssh.exe' "$@"\n}`
  const w = await winWorld($, on, { env: { 'BASH_FUNC_ssh%%': ours }, store: { inheritedBashSsh: own } })
  await w.ready()
  await w.stop()
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(own)
})

test('a session without an own ssh function forgets the one stored before', async ($, on) => {
  const w = await winWorld($, on, { store: { inheritedBashSsh: '() {  command ssh -v "$@"\n}' } })
  await w.ready()
  await w.stop()
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBe(undefined)
})

test('a second Windows start keeps its shim when the old listener gives up meanwhile', async ($, on) => {
  const w = await winWorld($, on)
  // Holds the second start between setting the shim and starting its listener.
  let release = () => {}
  w.rec.holdStarts(new Promise(resolve => (release = resolve)))
  const second = $.session.start(START)
  // The first listener's ready timer runs out while the second start waits.
  await w.clock.advance(5000)
  release()
  await second
  await w.ready()
  expect(w.serve.argvs).toHaveLength(2)
  expect(w.rec.envValue('PATH')).toBe(`${w.outDir}\\shim;${WIN_PATH}`)
  expect(w.rec.envValue('BASH_FUNC_ssh%%')).toBeDefined()
  expect(w.rec.envValue('CC_ASKPASS_PIPE')).toBe(WIN_PIPE)
  expect(w.rec.toasts).toEqual([])
})

test('a second Windows start whose helper cannot run keeps the running listener', async ($, on) => {
  let checks = 0
  const w = await winWorld($, on, { check: () => (checks++ > 0 ? { exitCode: 1, stderr: 'blocked\r\n' } : undefined) })
  await w.ready()
  await $.session.start(START)
  await w.clock.settle()
  expect(w.serve.argvs).toHaveLength(1)
  expect(w.rec.envValue('CC_ASKPASS_PIPE')).toBe(WIN_PIPE)
  expect(w.rec.envValue('PATH')).toBe(`${w.outDir}\\shim;${WIN_PATH}`)
  expect(w.rec.toasts).toEqual(['cc-askpass: could not run the Windows helper: blocked'])
  expect(await sudoNote($)).toBeDefined()
})

test('replacing a Windows listener that never became ready leaves an inherited SSH_ASKPASS alone', async ($, on) => {
  const w = await winWorld($, on, { env: { SSH_ASKPASS: 'C:\\own\\askpass.exe' } })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.serve.argvs).toHaveLength(2)
  expect(w.rec.envSets.some(set => set.name === 'SSH_ASKPASS')).toBe(false)
})

test('Windows starts the listener from the built exe', async ($, on) => {
  const w = await winWorld($, on)
  expect(w.serve.argvs).toEqual([[`${w.outDir}\\cc-askpass.exe`, 'serve', SESSION_ID]])
})

test('Windows sets its env on ready', async ($, on) => {
  const w = await winWorld($, on)
  expect(w.rec.envSets.filter(set => set.name !== 'PATH' && set.name !== 'BASH_FUNC_ssh%%')).toEqual([])
  await w.ready()
  expect(w.rec.envValue('CC_ASKPASS_PIPE')).toBe(WIN_PIPE)
  expect(w.rec.envValue('SSH_ASKPASS')).toBe(`${w.outDir}\\cc-askpass.exe`)
  expect(w.rec.envValue('SSH_ASKPASS_REQUIRE')).toBe('force')
  expect(w.rec.envValue('CC_ASKPASS_WRAP')).toBe('1')
  expect(w.rec.envValue('CC_ASKPASS_EXCLUDE')).toBe('')
  await w.stop()
  expect(w.rec.envValue('CC_ASKPASS_PIPE')).toBe(undefined)
  expect(w.rec.envValue('SSH_ASKPASS')).toBe(undefined)
  for (const name of ['SUDO_ASKPASS', 'DISPLAY', 'CC_ASKPASS_DIR']) {
    expect(w.rec.envSets.some(set => set.name === name)).toBe(false)
  }
  expect(w.rec.toasts).toEqual(['cc-askpass: the askpass listener stopped; ssh will not ask for passwords here'])
})

test('a failed build toasts and changes nothing', async ($, on) => {
  const w = await winWorld($, on, { isBuilt: false, build: { exitCode: 1, stderr: 'Add-Type is blocked\r\n' } })
  expect(w.rec.toasts).toEqual(['cc-askpass: could not build the Windows helper: Add-Type is blocked'])
  expect(w.rec.envSets).toEqual([])
  expect(w.serve.argvs).toEqual([])
  expect(await sudoNote($)).toBeUndefined()
})

test('a build that fails after another session built the helper counts as built', async ($, on) => {
  // Missing before the build; there after it, written by a build that ran beside this one.
  let checks = 0
  const isBuilt = () => checks++ > 0
  const w = await winWorld($, on, { isBuilt, build: { exitCode: 1, stderr: 'cc-askpass: build failed: in use\r\n' } })
  expect(w.builds()).toHaveLength(1)
  expect(w.rec.toasts).toEqual([])
  expect(w.serve.argvs).toEqual([[w.exe, 'serve', SESSION_ID]])
})

test('a build that times out after another session built the helper counts as built', async ($, on) => {
  let checks = 0
  const w = await winWorld($, on, { isBuilt: () => checks++ > 0, build: { deny: 'timed out after 60000 ms' } })
  expect(w.rec.toasts).toEqual([])
  expect(w.serve.argvs).toEqual([[w.exe, 'serve', SESSION_ID]])
})

test('a build that times out names the timeout', async ($, on) => {
  const w = await winWorld($, on, { isBuilt: false, build: { deny: 'timed out after 60000 ms' } })
  expect(w.rec.toasts).toHaveLength(1)
  expect(w.rec.toasts[0]).toMatch(/^cc-askpass: could not build the Windows helper: .*timed out after 60000 ms/)
})

test('a missing helper source counts as a failed build', async ($, on) => {
  const w = await winWorld($, on, { source: null })
  expect(w.rec.toasts).toHaveLength(1)
  expect(w.rec.toasts[0]).toMatch(/^cc-askpass: could not build the Windows helper: .*ENOENT/)
  expect(w.builds()).toEqual([])
  expect(w.rec.envSets).toEqual([])
  expect(w.serve.argvs).toEqual([])
})

const WIN_NOTE =
  'ssh and git can ask the user for a password or key passphrase in this session: the cc-askpass plugin shows a ' +
  'prompt inside Claude Code. Run them normally and do not ask the user to type passwords themselves.'

test('Windows system prompt note covers ssh only', async ($, on) => {
  const w = await winWorld($, on)
  await w.ready()
  const text = (await sudoNote($))?.text ?? ''
  expect(text.startsWith(WIN_NOTE)).toBe(true)
  expect(text).toContain('ssh host sudo')
  expect(text).not.toContain('`-n`')
})

test('Windows system prompt note without remote hosts', { options: { remoteHosts: false } }, async ($, on) => {
  const w = await winWorld($, on)
  await w.ready()
  expect((await sudoNote($))?.text).toBe(WIN_NOTE)
})

test('Windows session.end removes nothing', async ($, on) => {
  const w = await winWorld($, on)
  await w.ready()
  await $.session.end({ reason: 'prompt_input_exit' } as never)
  // Only the session start's check that the helper runs.
  expect(w.rec.runs.map(run => run.argv)).toEqual([[w.exe]])
})
