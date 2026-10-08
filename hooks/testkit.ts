// Test helpers shared by the *.test.ts files: a fake serve process and recorders
// for the engine calls the mod makes.
import type { On, ProcessRunResult } from 'claude-code'
import { mock } from 'claude-code/testing'

export const SESSION_ID = 'S'
// Named <session id>-<Claude Code pid>; the pid (900) roots the process trees tests build.
export const SESSION_DIR = '/run/user/1000/cc-askpass/S-900'

/** Stands in for `bin/askpass --serve`: the test pushes its output and ends it. */
export function fakeServe(on: On) {
  const argvs: (readonly string[])[] = []
  const queue: string[] = []
  const waiters = new Set<() => void>()
  let isEnded = false
  const wakeAll = () => {
    for (const wake of waiters) wake()
    waiters.clear()
  }

  on('process.spawn', async function* (_$, e, next) {
    argvs.push(e.argv)
    // The mod stopping its loop aborts the stream, as killing the child would.
    next.signal.addEventListener('abort', wakeAll)
    for (;;) {
      while (queue.length > 0 && !next.signal.aborted) yield { stream: 'stdout' as const, text: queue.shift() as string }
      if (isEnded || next.signal.aborted) return { value: { code: 1, signal: null } }
      await new Promise<void>(resolve => waiters.add(resolve))
    }
  })

  return {
    argvs,
    emit(text: string) {
      queue.push(text)
      wakeAll()
    },
    end() {
      isEnded = true
      wakeAll()
    },
  }
}

// What a Windows test's helper source reads as; the build directory is named after its hash.
export const WIN_SOURCE = '// cc-askpass.cs stand-in\n'
export const WIN_PIPE = 'cc-askpass-S-900'
export const WIN_TOKEN = '0123456789abcdef0123456789abcdef'
export const WIN_PATH = 'C:\\Windows\\system32;C:\\Windows'

/**
 * Answers as native Windows: `OS`, `SystemRoot` and PATH, the helper's source (none with
 * `source: null`), and whether its build exists. `root()` is the plugin root the mod read under.
 */
export function windowsWorld(
  on: On,
  options: { isBuilt?: boolean | (() => boolean); source?: string | null; env?: Record<string, string> } = {},
) {
  const reads: string[] = []
  mock.env(on, { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', PATH: WIN_PATH, ...options.env })
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    if (options.source === null) return { deny: `ENOENT: no such file, open '${e.path}'` }
    return { value: options.source ?? WIN_SOURCE }
  })
  on('fs.exists', () => ({ value: typeof options.isBuilt === 'function' ? options.isBuilt() : (options.isBuilt ?? true) }))
  return {
    root: () => (reads[0] ?? '').replace(/\\win\\cc-askpass\.cs$/, ''),
  }
}

// What the built helper says when run with no listener: the mod's check that it can run at all.
export const WIN_NOT_SET =
  'cc-askpass: CC_ASKPASS_PIPE is not set; is the cc-askpass mod loaded in this Claude Code session?\r\n'

export type RunCall = { argv: readonly string[]; stdin?: string; env?: Record<string, string> }

/**
 * Records what the mod does to the world beneath it. `answer` decides each
 * `$.process.run` result (`{ deny }` makes the run throw, as a timeout does); unanswered commands
 * exit 0 with no output, except the Windows helper run bare, which answers as a working helper does.
 */
export function recorder(
  on: On,
  answer: (argv: readonly string[]) => Partial<ProcessRunResult> | { deny: string } | undefined = () => undefined,
) {
  const envSets: { name: string; value?: string }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const runs: RunCall[] = []
  const commands: { name: string; immediate?: true }[] = []
  const opens: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean; rows?: number; columns?: number }[] = []
  const closes: string[] = []
  let placeOpens = true
  let isOpenBroken = false
  let startHold: Promise<void> = Promise.resolve()

  on('session.start', async (_$, e) => {
    await startHold
    return { cwd: e.cwd }
  })
  on('session.end', () => ({ sessionId: SESSION_ID }))
  on('session.id', () => ({ value: SESSION_ID }))
  // The engine's system prompt, reduced to one section.
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base prompt', scope: 'shared' as const }] }))
  // The engine's own band when no plugin draws one: nothing.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('env.set', (_$, e) => {
    envSets.push({ name: e.name, value: e.value })
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    commands.push({ name: e.name, immediate: e.immediate })
    return { value: { command: e.name } }
  })
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, ...(e.init?.env === undefined ? {} : { env: e.init.env }) })
    const helper = e.argv.length === 1 && e.argv[0]?.endsWith('\\cc-askpass.exe') ? { exitCode: 1, stderr: WIN_NOT_SET } : {}
    const answered = answer(e.argv)
    if (answered !== undefined && 'deny' in answered) return { deny: answered.deny }
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...helper, ...answered },
    }
  })
  on('ui.open', (_$, e) => {
    if (isOpenBroken) throw new Error('ui.open refused')
    opens.push({ id: e.id, title: e.title, focus: e.focus, closeOnEscape: e.closeOnEscape, rows: e.rows, columns: e.columns })
    return { value: placeOpens ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'narrow' } }
  })
  on('ui.close', (_$, e) => {
    closes.push(e.id)
    return { value: undefined }
  })

  return {
    envSets,
    toasts,
    logs,
    runs,
    commands,
    opens,
    closes,
    /** Makes later `ui.open` calls answer as an unasked open on a narrow terminal. */
    setPlaced(isPlaced: boolean) {
      placeOpens = isPlaced
    },
    /** Makes later `ui.open` calls throw, as an engine refusal does. */
    breakOpen() {
      isOpenBroken = true
    },
    /** Holds the engine's part of every later session.start until `until` settles. */
    holdStarts(until: Promise<void>) {
      startHold = until
    },
    envValue(name: string) {
      return envSets.filter(set => set.name === name).at(-1)?.value
    },
  }
}
