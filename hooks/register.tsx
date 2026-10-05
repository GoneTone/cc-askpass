import type { EngineInterface, Register } from 'claude-code'

import { parseReady, splitLines } from './core'

const READY_TIMEOUT_MS = 5000

// Module state. A hot reload starts it over and kills the serve child with the module.
let askpassPath = ''
let sessionDir = ''
let didSetDisplay = false
// Bumped whenever a serve loop is replaced, so the old loop's end is not taken for a crash.
let serveGeneration = 0
let stopServe = () => {}

function onRequestLine(_$: EngineInterface, _line: string): void {}

async function setEnv($: EngineInterface): Promise<void> {
  await $.env.set('CC_ASKPASS_DIR', sessionDir)
  await $.env.set('SUDO_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
  // sudo only uses askpass when DISPLAY is set; a real display is left alone.
  if ((await $.env.get('DISPLAY')) === undefined) {
    await $.env.set('DISPLAY', ':0')
    didSetDisplay = true
  }
}

async function unsetEnv($: EngineInterface): Promise<void> {
  await $.env.set('CC_ASKPASS_DIR', undefined)
  await $.env.set('SUDO_ASKPASS', undefined)
  await $.env.set('SSH_ASKPASS', undefined)
  await $.env.set('SSH_ASKPASS_REQUIRE', undefined)
  if (didSetDisplay) {
    await $.env.set('DISPLAY', undefined)
    didSetDisplay = false
  }
}

async function runServe($: EngineInterface): Promise<void> {
  stopServe()
  const generation = ++serveGeneration
  askpassPath = `${$.plugin.root}/bin/askpass`
  const serve = $.process.spawn({ argv: [askpassPath, '--serve', await $.session.id()] })
  stopServe = () => void serve.return(undefined as never)

  let isReady = false
  const readyTimer = $.clock.after(READY_TIMEOUT_MS, () => {
    if (isReady || generation !== serveGeneration) return
    $.ui.toast('cc-askpass: the askpass listener did not start')
    stopServe()
  })

  let rest = ''
  try {
    for await (const chunk of serve) {
      if (chunk.stream !== 'stdout') {
        void $.ui.log(`cc-askpass: ${chunk.text}`, { to: 'debug' })
        continue
      }
      const split = splitLines(rest, chunk.text)
      rest = split.rest
      for (const line of split.lines) {
        if (isReady) {
          onRequestLine($, line)
          continue
        }
        const dir = parseReady(line)
        if (dir === null) continue
        isReady = true
        readyTimer.cancel()
        sessionDir = dir
        await setEnv($)
      }
    }
  } catch (error) {
    void $.ui.log(`cc-askpass: askpass listener failed: ${String(error)}`, { to: 'debug' })
  }
  readyTimer.cancel()

  if (generation !== serveGeneration || !isReady) return
  await unsetEnv($)
  $.ui.toast('cc-askpass: the askpass listener stopped; sudo will not ask for passwords here')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'askpass',
      description: 'Open the pending password prompt',
      immediate: true,
    })
    void runServe($).catch(error => {
      void $.ui.log(`cc-askpass: askpass listener failed: ${String(error)}`, { to: 'debug' })
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    if (sessionDir !== '') await $.process.run(['rm', '-rf', sessionDir])
    return next(e)
  })
}
