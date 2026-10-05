// Test helpers shared by the *.test.ts files: a fake serve process and recorders
// for the engine calls the mod makes.
import type { On, ProcessRunResult } from 'claude-code'

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

export type RunCall = { argv: readonly string[]; stdin?: string }

/**
 * Records what the mod does to the world beneath it. `answer` decides each
 * `$.process.run` result; unanswered commands exit 0 with no output.
 */
export function recorder(on: On, answer: (argv: readonly string[]) => Partial<ProcessRunResult> | undefined = () => undefined) {
  const envSets: { name: string; value?: string }[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const runs: RunCall[] = []
  const commands: { name: string; immediate?: true }[] = []
  const opens: { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean; rows?: number; columns?: number }[] = []
  const closes: string[] = []
  let placeOpens = true
  let isOpenBroken = false

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
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
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer(e.argv) },
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
    envValue(name: string) {
      return envSets.filter(set => set.name === name).at(-1)?.value
    },
  }
}
