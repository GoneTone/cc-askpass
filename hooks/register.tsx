import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Requester } from './core'
import {
  AnsweredPids,
  applyMaskedInput,
  isOurHelper,
  isTrustedClient,
  parseExeInfo,
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
// Writes only into a FIFO: the first test skips a vanished helper, the second catches
// the FIFO being removed between that test and the open (`<>` would create a file).
// Read-write so the open never blocks.
const REPLY_SCRIPT = '[ -p "$1" ] || exit 1; exec 3<>"$1"; [ -p /dev/fd/3 ] || { rm -f "$1"; exit 1; }; cat >&3'
// `<owner uid> <path>` of a process's executable (Linux /proc).
const EXE_SCRIPT = 't=$(readlink -f "/proc/$1/exe") || exit 1; printf \'%s %s\n\' "$(stat -c %u "$t")" "$t"'

type Request = {
  helperPid: number
  prompt: string
  requester: Requester
  isRetry: boolean
  // Set before the first await of an answer, so Enter, Esc and the alive poll answer once.
  isAnswered?: boolean
}

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
let isAdvancing = false
let typed = ''
let isMasked = true
// True while the current request waits for the person to open its pane (narrow terminal).
let isWaitingForOpen = false
let aliveTimer: Timer | null = null
const answered = new AnsweredPids()

function log($: EngineInterface, text: string): void {
  void $.ui.log(`cc-askpass: ${text}`, { to: 'debug' })
}

function onRequestLine($: EngineInterface, line: string): void {
  void verify($, line).catch(error => {
    // ps missing (a slim container) or failing: say so, and let the helper fail now.
    $.ui.toast(`cc-askpass: could not check an askpass request: ${String(error)}`)
    log($, `request failed: ${String(error)}`)
    const parsed = parseRequest(line)
    if (parsed !== null) void reply($, parsed.helperPid, '')
  })
}

/** Checks with `ps` that the request comes from our helper, and that its caller may ask. */
async function verify($: EngineInterface, line: string): Promise<void> {
  const parsed = parseRequest(line)
  if (parsed === null) return log($, `ignored malformed request line: ${line}`)

  const helperPs = await $.process.run(['ps', '-o', 'ppid=,args=', '-p', String(parsed.helperPid)])
  const helper = parseHelperPs(helperPs.stdout)
  if (helper === null) return
  if (!isOurHelper(helper.args, askpassPath)) {
    $.ui.toast(`Rejected forged askpass request (pid ${parsed.helperPid})`)
    return log($, `rejected forged request from pid ${parsed.helperPid}: ${helper.args}`)
  }

  const parentPs = await $.process.run(['ps', '-o', 'user=,comm=,args=', '-p', String(helper.ppid)])
  const requester = parseParentPs(parentPs.stdout, helper.ppid)
  if (requester === null) return
  const request: Request = { ...parsed, requester, isRetry: false }

  if (!requester.isSudo) {
    const exe = await $.process.run(['sh', '-c', EXE_SCRIPT, '_', String(requester.pid)])
    if (!isTrustedClient(requester, exe.exitCode === 0 ? parseExeInfo(exe.stdout) : null)) {
      // The helper is ours: an empty answer makes it fail at once instead of waiting.
      $.ui.toast(`Rejected askpass request from ${requester.comm} (pid ${requester.pid})`)
      log($, `rejected request from untrusted caller: ${requester.command}`)
      return reply($, request.helperPid, '')
    }
  }

  request.isRetry = requester.isSudo && answered.has(requester.pid, await $.clock.now())
  queue.push(request)
  await showNext($)
}

async function isAlive($: EngineInterface, pid: number): Promise<boolean> {
  // The shell's builtin kill: /bin/kill may not be installed.
  return (await $.process.run(['sh', '-c', 'kill -0 "$1"', '_', String(pid)])).exitCode === 0
}

function paneTitle(requester: Requester): string {
  return requester.isSudo ? 'sudo password' : `Password requested by ${requester.comm} (pid ${requester.pid})`
}

function clearWaiting($: EngineInterface): void {
  if (!isWaitingForOpen) return
  isWaitingForOpen = false
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface): Promise<void> {
  if (current === null) return
  const opened = await $.ui.open({ id: PANE, title: paneTitle(current.requester), focus: true, closeOnEscape: true })
  if (opened.isPlaced) return clearWaiting($)
  // An open the person did not ask for waits on a narrow terminal. The band's button and
  // /askpass are opens they ask for, which are placed at any width.
  isWaitingForOpen = true
  $.ui.invalidate('ui.render')
}

/** Shows the next queued request whose helper is still alive; one caller at a time. */
async function showNext($: EngineInterface): Promise<void> {
  if (current !== null || isAdvancing) return
  isAdvancing = true
  try {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (!(await isAlive($, next.helperPid))) continue
      const request = next
      current = request
      typed = ''
      isMasked = shouldMask(request.requester.isSudo, request.prompt)
      aliveTimer = $.clock.every(ALIVE_POLL_MS, () => {
        void isAlive($, request.helperPid)
          .then(alive => (alive || request.isAnswered ? undefined : finish($, request)))
          .catch(error => log($, `alive check failed: ${String(error)}`))
      })
      await openPane($)
      return
    }
  } finally {
    isAdvancing = false
  }
  // A request queued while the loop above was finishing its last check.
  if (current === null && queue.length > 0) await showNext($)
}

/** Ends `request` (answered or not) and moves on to the next one; a no-op once it ended. */
async function finish($: EngineInterface, request: Request): Promise<void> {
  if (current !== request) return
  aliveTimer?.cancel()
  aliveTimer = null
  current = null
  typed = ''
  clearWaiting($)
  await $.ui.close({ id: PANE })
  await showNext($)
}

async function reply($: EngineInterface, helperPid: number, password: string): Promise<void> {
  try {
    await $.process.run(['sh', '-c', REPLY_SCRIPT, '_', `${sessionDir}/reply.${helperPid}`], {
      stdin: `${password}\n`,
      timeoutMs: REPLY_TIMEOUT_MS,
    })
  } catch (error) {
    log($, `reply to pid ${helperPid} failed: ${String(error)}`)
  }
}

async function submit($: EngineInterface, request: Request, password: string): Promise<void> {
  if (current !== request || request.isAnswered) return
  request.isAnswered = true
  await reply($, request.helperPid, password)
  if (request.requester.isSudo) answered.mark(request.requester.pid, await $.clock.now())
  await finish($, request)
}

async function setEnv($: EngineInterface): Promise<void> {
  await $.env.set('CC_ASKPASS_DIR', sessionDir)
  await $.env.set('SUDO_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
  // sudo only uses askpass when DISPLAY is set; a real display is left alone. The marker
  // survives a hot reload (module variables do not), so ownership of :0 is not forgotten.
  const display = await $.env.get('DISPLAY')
  const isOurs = display === ':0' && (await $.env.get('CC_ASKPASS_SET_DISPLAY')) === '1'
  if (display === undefined || isOurs) {
    await $.env.set('DISPLAY', ':0')
    await $.env.set('CC_ASKPASS_SET_DISPLAY', '1')
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
    await $.env.set('CC_ASKPASS_SET_DISPLAY', undefined)
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
  let didGiveUp = false
  let lastError = ''
  const notStarted = () => $.ui.toast(`cc-askpass: the askpass listener did not start${lastError && `: ${lastError}`}`)
  const readyTimer = $.clock.after(READY_TIMEOUT_MS, () => {
    if (isReady || generation !== serveGeneration) return
    didGiveUp = true
    notStarted()
    stopServe()
  })

  let rest = ''
  try {
    for await (const chunk of serve) {
      if (chunk.stream !== 'stdout') {
        lastError = chunk.text.trim()
        log($, chunk.text)
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
    log($, `askpass listener failed: ${String(error)}`)
  }
  readyTimer.cancel()

  if (generation !== serveGeneration) return
  if (!isReady) {
    if (!didGiveUp) notStarted()
    return
  }
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
    void runServe($).catch(error => log($, `askpass listener failed: ${String(error)}`))
    return started
  })

  on('session.end', async ($, e, next) => {
    // After /clear or an in-process resume the process goes on under a new session id and
    // no session.start follows, so the listener and the env pointing at its dir stay.
    const isProcessEnding = e.reason !== 'clear' && e.reason !== 'resume'
    if (isProcessEnding && sessionDir !== '') await $.process.run(['rm', '-rf', sessionDir])
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const request = current
    if (!isWaitingForOpen || request === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text>{request.requester.comm} is waiting for a password — type /askpass or click </Text>
        <Button key="open-askpass" onPress={() => void openPane($)}>
          Open password prompt
        </Button>
      </Box>
    )
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
