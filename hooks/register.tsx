import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Requester } from './core'
import {
  AnsweredPids,
  applyMaskedInput,
  isOurHelper,
  parseHelperPs,
  parseParentPs,
  parseReady,
  parseRequest,
  shouldMask,
  splitLines,
} from './core'

const READY_TIMEOUT_MS = 5000
const REPLY_TIMEOUT_MS = 5000
const ALIVE_POLL_MS = 2000
const PANE = 'askpass'
// Refuses to write unless the target is still a FIFO, so a vanished helper never
// leaves the password in a regular file; read-write so the open never blocks.
const REPLY_SCRIPT = '[ -p "$1" ] || exit 1; exec 3<>"$1"; cat >&3'

type Request = { helperPid: number; prompt: string; requester: Requester; isRetry: boolean }

// Module state. A hot reload starts it over and kills the serve child with the module.
// The password lives only in `typed`, and only while its pane is open.
let askpassPath = ''
let sessionDir = ''
let didSetDisplay = false
// Bumped whenever a serve loop is replaced, so the old loop's end is not taken for a crash.
let serveGeneration = 0
let stopServe = () => {}
const queue: Request[] = []
let current: Request | null = null
let typed = ''
let isMasked = true
let isStatusShown = false
let aliveTimer: Timer | null = null
const answered = new AnsweredPids()

function log($: EngineInterface, text: string): void {
  void $.ui.log(`cc-askpass: ${text}`, { to: 'debug' })
}

function onRequestLine($: EngineInterface, line: string): void {
  void verify($, line).catch(error => log($, `request failed: ${String(error)}`))
}

/** Checks with `ps` that the request comes from our helper, and who asks. */
async function verify($: EngineInterface, line: string): Promise<void> {
  const request = parseRequest(line)
  if (request === null) return log($, `ignored malformed request line: ${line}`)

  const helperPs = await $.process.run(['ps', '-o', 'ppid=,args=', '-p', String(request.helperPid)])
  const helper = parseHelperPs(helperPs.stdout)
  if (helper === null) return
  if (!isOurHelper(helper.args, askpassPath)) {
    $.ui.toast(`Rejected forged askpass request (pid ${request.helperPid})`)
    return log($, `rejected forged request from pid ${request.helperPid}: ${helper.args}`)
  }

  const parentPs = await $.process.run(['ps', '-o', 'user=,comm=,args=', '-p', String(helper.ppid)])
  const requester = parseParentPs(parentPs.stdout, helper.ppid)
  if (requester === null) return

  const isRetry = requester.isSudo && answered.has(requester.pid, await $.clock.now())
  queue.push({ ...request, requester, isRetry })
  if (current === null) await showNext($)
}

async function isAlive($: EngineInterface, pid: number): Promise<boolean> {
  return (await $.process.run(['kill', '-0', String(pid)])).exitCode === 0
}

function paneTitle(requester: Requester): string {
  return requester.isSudo ? 'sudo password' : `Password requested by ${requester.comm} (pid ${requester.pid})`
}

async function openPane($: EngineInterface): Promise<void> {
  if (current === null) return
  const opened = await $.ui.open({ id: PANE, title: paneTitle(current.requester), focus: true, closeOnEscape: true })
  if (opened.isPlaced) return
  // An open the person did not ask for waits on a narrow terminal; /askpass is an asked open.
  const text = `${current.requester.comm} is waiting for a password — type /askpass`
  $.ui.status(text)
  $.ui.toast(text)
  isStatusShown = true
}

async function showNext($: EngineInterface): Promise<void> {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!(await isAlive($, next.helperPid))) continue
    current = next
    typed = ''
    isMasked = shouldMask(next.requester.isSudo, next.prompt)
    const helperPid = next.helperPid
    aliveTimer = $.clock.every(ALIVE_POLL_MS, () => {
      void isAlive($, helperPid).then(alive => {
        if (!alive && current?.helperPid === helperPid) void finish($)
      })
    })
    return openPane($)
  }
}

/** Ends the current request (answered or not) and moves on to the next one. */
async function finish($: EngineInterface): Promise<void> {
  aliveTimer?.cancel()
  aliveTimer = null
  current = null
  typed = ''
  if (isStatusShown) {
    $.ui.status(undefined)
    isStatusShown = false
  }
  await $.ui.close({ id: PANE })
  await showNext($)
}

async function reply($: EngineInterface, request: Request, password: string): Promise<void> {
  try {
    await $.process.run(['sh', '-c', REPLY_SCRIPT, '_', `${sessionDir}/reply.${request.helperPid}`], {
      stdin: `${password}\n`,
      timeoutMs: REPLY_TIMEOUT_MS,
    })
  } catch (error) {
    log($, `reply to pid ${request.helperPid} failed: ${String(error)}`)
  }
}

async function submit($: EngineInterface, request: Request, password: string): Promise<void> {
  if (current !== request) return
  await reply($, request, password)
  if (request.requester.isSudo) answered.mark(request.requester.pid, await $.clock.now())
  await finish($)
}

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

  on('command.run', { command: 'askpass' }, async $ => {
    if (current === null) {
      $.ui.toast('No pending password request')
      return { text: 'No pending password request.' }
    }
    await openPane($)
    return { text: 'Password prompt opened.' }
  })

  // Esc or the close mark: answer empty so the helper exits and sudo gives up.
  on('ui.close', async ($, e, next) => {
    const request = current
    const closed = await next(e)
    if (e.id === PANE && e.origin.kind === 'person' && request !== null) await submit($, request, '')
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const request = current
    if (request === null) return <Text dimColor>No pending password request.</Text>
    // Mobile has no Input; its table hands back a stand-in that draws nothing.
    if (e.surface === 'mobile' || !('Input' in elements)) {
      return <Text>Answer this prompt in the terminal or the desktop app.</Text>
    }
    const { Input } = elements

    // A fresh key per request: an Input keeps its old text when a key is reused.
    const key = `password-${request.helperPid}`
    return (
      <Box flexDirection="column">
        {request.isRetry && <Text color="red">Sorry, try again.</Text>}
        <Text dimColor>Requested by: {request.requester.command}</Text>
        <Text>{request.prompt}</Text>
        <Input
          key={key}
          autoFocus
          value={isMasked ? '•'.repeat(typed.length) : typed}
          submitLabel="send"
          onInput={value => {
            typed = isMasked ? applyMaskedInput(typed, value) : value
            $.ui.invalidate('ui.render')
          }}
          onSubmit={value => {
            const password = isMasked ? applyMaskedInput(typed, value) : value
            void submit($, request, password)
          }}
        />
        <Button
          key="toggle"
          onPress={() => {
            isMasked = !isMasked
            $.ui.invalidate('ui.render')
          }}
        >
          {isMasked ? 'Show' : 'Hide'}
        </Button>
        <Button key="cancel" role="dismiss" onPress={() => void submit($, request, '')}>
          Cancel
        </Button>
      </Box>
    )
  })
}
