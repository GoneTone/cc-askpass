import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Requester } from './core'
import {
  AnsweredPids,
  applyMaskedInput,
  bashShellArgs,
  claudePidOf,
  clipLines,
  fitSections,
  matchBashCommand,
  parsePsTable,
  isOurHelper,
  isTrustedClient,
  parseExeInfo,
  parseHelperPs,
  parseParentPs,
  parseReady,
  parseRequest,
  promptLabel,
  wrappedLines,
  shouldMask,
  splitLines,
} from './core'

const READY_TIMEOUT_MS = 5000
const REPLY_TIMEOUT_MS = 5000
const ALIVE_POLL_MS = 2000
// Time for the band to drop its button and hand the keyboard back (verified at 150 ms).
const BAND_RELEASE_MS = 150
const PANE = 'askpass'
// Width the pane asks for when docked, and the width its content is measured at.
const PANE_WIDTH = 60
// Rows the `$` and "Claude ran" lines may take: a long command must not push the field away.
const MAX_SECTION_ROWS = 3
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
  // The Bash tool command that led to this request, when it says more than the sudo line.
  claudeCommand: string | null
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
// New on every load of this module. A reload shows the same pending requests again, and an
// Input keeps the text it held under its key while the new module knows none of it.
const LOAD_ID = Math.random().toString(36).slice(2, 8)
// Claude's latest Bash commands, to name the one a request comes from. Background commands
// outlive their tool call, so these are kept by count, not by call.
const recentBashCommands: string[] = []
const RECENT_BASH_LIMIT = 50

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

  const helperPs = await $.process.run(['ps', '-ww', '-o', 'ppid=,args=', '-p', String(parsed.helperPid)])
  const helper = parseHelperPs(helperPs.stdout)
  if (helper === null) return
  if (!isOurHelper(helper.args, askpassPath)) {
    $.ui.toast(`Rejected forged askpass request (pid ${parsed.helperPid})`)
    return log($, `rejected forged request from pid ${parsed.helperPid}: ${helper.args}`)
  }

  const parentPs = await $.process.run(['ps', '-ww', '-o', 'user=,comm=,args=', '-p', String(helper.ppid)])
  const requester = parseParentPs(parentPs.stdout, helper.ppid)
  if (requester === null) return
  const request: Request = { ...parsed, requester, isRetry: false, claudeCommand: null }

  if (!requester.isSudo) {
    const exe = await $.process.run(['sh', '-c', EXE_SCRIPT, '_', String(requester.pid)])
    if (!isTrustedClient(requester, exe.exitCode === 0 ? parseExeInfo(exe.stdout) : null)) {
      // The helper is ours: an empty answer makes it fail at once instead of waiting.
      $.ui.toast(`Rejected askpass request from ${requester.comm} (pid ${requester.pid})`)
      log($, `rejected request from untrusted caller: ${requester.command}`)
      return reply($, request.helperPid, '')
    }
  }

  request.claudeCommand = await findClaudeCommand($, requester)
  request.isRetry = requester.isSudo && answered.has(requester.pid, await $.clock.now())
  queue.push(request)
  await showNext($)
}

/** The Bash command Claude ran that led to `requester`, if it differs from its own line. */
async function findClaudeCommand($: EngineInterface, requester: Requester): Promise<string | null> {
  const claudePid = claudePidOf(sessionDir)
  if (claudePid === null || recentBashCommands.length === 0) return null
  try {
    const ps = await $.process.run(['ps', '-e', '-ww', '-o', 'pid=,ppid=,args='])
    const shell = bashShellArgs(parsePsTable(ps.stdout), requester.pid, claudePid)
    const command = shell === null ? null : matchBashCommand(shell, recentBashCommands)
    return command === null || command.trim() === requester.command.trim() ? null : command
  } catch (error) {
    // Only context for the pane: a failure here must not block the request.
    log($, `could not find the Bash command: ${String(error)}`)
    return null
  }
}

async function isAlive($: EngineInterface, pid: number): Promise<boolean> {
  // The shell's builtin kill: /bin/kill may not be installed.
  return (await $.process.run(['sh', '-c', 'kill -0 "$1"', '_', String(pid)])).exitCode === 0
}

function paneTitle(requester: Requester): string {
  return requester.isSudo ? 'sudo password' : `Password requested by ${requester.comm} (pid ${requester.pid})`
}

/** The terminal outside fullscreen reports no clicks, so hints there name keys only. */
function isMainScreen(e: { viewport?: { isFullscreen?: boolean } }): boolean {
  return e.viewport?.isFullscreen === false
}

function focusWarning(isMain: boolean): string {
  const how = isMain ? 'Press ctrl+x tab' : 'Click this pane (or press ctrl+x tab)'
  return `${how} before typing — your keys are going to the prompt below.`
}

function claudeLine(request: Request): string | null {
  if (request.claudeCommand === null) return null
  return clipLines(`Claude ran: ${request.claudeCommand}`, MAX_SECTION_ROWS, PANE_WIDTH)
}

function commandLine(request: Request): string {
  return clipLines(`$ ${request.requester.command}`, MAX_SECTION_ROWS, PANE_WIDTH)
}

/**
 * Rows the pane body needs, measured at PANE_WIDTH (an inline pane is usually wider, so this
 * errs tall). The focus warning is counted always: whether it shows is known only when drawn.
 */
function paneRows(request: Request): number {
  const claude = claudeLine(request)
  const header = 1 + (claude === null ? 0 : wrappedLines(claude, PANE_WIDTH)) + wrappedLines(commandLine(request), PANE_WIDTH)
  const field = (request.isRetry ? 1 : 0) + wrappedLines(promptLabel(request.prompt), PANE_WIDTH) + 1
  const blankLines = 2
  return wrappedLines(focusWarning(false), PANE_WIDTH) + header + field + 1 + blankLines
}

function paneHeading(requester: Requester): string {
  return requester.isSudo ? 'sudo needs your password' : `${requester.comm} (pid ${requester.pid}) needs a password`
}

function clearWaiting($: EngineInterface): void {
  if (!isWaitingForOpen) return
  isWaitingForOpen = false
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface): Promise<void> {
  if (current === null) return
  const opened = await $.ui.open({
    id: PANE,
    title: paneTitle(current.requester),
    focus: true,
    closeOnEscape: true,
    // Sizes the body wants: rows when inline above the prompt, columns when docked.
    rows: paneRows(current),
    columns: PANE_WIDTH,
  })
  log($, `ui.open: ${JSON.stringify(opened)}`)
  if (opened.isPlaced) return clearWaiting($)
  // An open the person did not ask for waits on a narrow terminal. The band's button and
  // /askpass are opens they ask for, which are placed at any width.
  isWaitingForOpen = true
  $.ui.invalidate('ui.render')
}

/**
 * Opens the pane from the band's button. While the band holds the keyboard a pane's focus
 * request is refused, so the band is cleared first and the pane opens once it has let go.
 * The press handler returns this promise: an open after the press is over counts as one
 * the person did not ask for, and waits unplaced on a narrow terminal.
 */
async function openFromBand($: EngineInterface): Promise<void> {
  clearWaiting($)
  await $.clock.sleep(BAND_RELEASE_MS)
  await openPane($)
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
      // A pane still open from before a reload is not drawn again by `ui.open`.
      $.ui.invalidate('ui.render')
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
    // Under -p or the SDK nobody can answer a pane: leave sudo to fail at once as before.
    if (!e.isInteractive) return started
    await $.command.register({
      name: 'askpass',
      description: 'Open the pending password prompt',
      immediate: true,
    })
    void runServe($).catch(error => log($, `askpass listener failed: ${String(error)}`))
    return started
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (e.tool === 'Bash') {
      recentBashCommands.push(e.command)
      if (recentBashCommands.length > RECENT_BASH_LIMIT) recentBashCommands.shift()
    }
    return next(e)
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
    const howToOpen = isMainScreen(e)
      ? 'press ctrl+x tab then Enter, or type /askpass'
      : 'click the button below or type /askpass'
    // The hint has a line of its own: beside the button it wraps mid-sentence.
    return (
      <Box flexDirection="column">
        <Text>
          {request.requester.comm} is waiting for a password — {howToOpen}
        </Text>
        <Box>
          {/* ctrl+x tab hands the band the keys; the ring starts here so Enter presses it. */}
          <Button key="open-askpass" variant="primary" autoFocus onPress={() => openFromBand($)}>
            Open password prompt
          </Button>
        </Box>
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

    // A fresh key per request and per load: an Input keeps its old text when a key is reused.
    const key = `password-${request.helperPid}-${LOAD_ID}`
    // The pane may get fewer rows than asked (a short terminal): show what fits, most
    // needed first, so the field never drops out of sight.
    const width = Math.max(20, e.props.bodyColumns - 2)
    const warning = e.props.isFocused ? null : focusWarning(isMainScreen(e))
    const claude = claudeLine(request)
    const command = commandLine(request)
    const prompt = promptLabel(request.prompt)
    const shown = fitSections(
      [
        { id: 'field', rows: 1 },
        { id: 'prompt', rows: (request.isRetry ? 1 : 0) + wrappedLines(prompt, width) },
        { id: 'warning', rows: warning === null ? 0 : wrappedLines(warning, width) },
        { id: 'command', rows: wrappedLines(command, width) },
        { id: 'cancel', rows: 1 },
        { id: 'claude', rows: claude === null ? 0 : wrappedLines(claude, width) },
        { id: 'heading', rows: 1 },
        { id: 'gapBeforeField', rows: 1 },
        { id: 'gapBeforeCancel', rows: 1 },
      ],
      e.props.scroll.bodyRows,
    )
    const isShown = (id: string) => shown.has(id as never)

    return (
      <Box flexDirection="column" paddingX={1}>
        {warning !== null && isShown('warning') && (
          <Text color="red" bold>
            {warning}
          </Text>
        )}
        {isShown('heading') && <Text bold>{paneHeading(request.requester)}</Text>}
        {claude !== null && isShown('claude') && (
          <Text dimColor wrap="wrap">
            {claude}
          </Text>
        )}
        {isShown('command') && (
          <Text dimColor wrap="wrap">
            {command}
          </Text>
        )}
        {isShown('gapBeforeField') && <Text> </Text>}
        {request.isRetry && isShown('prompt') && <Text color="red">Sorry, try again.</Text>}
        {isShown('prompt') && <Text wrap="wrap">{prompt}</Text>}
        <Box flexDirection="row" columnGap={2}>
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
        </Box>
        {isShown('gapBeforeCancel') && <Text> </Text>}
        {isShown('cancel') && (
          <Box>
            <Button key="cancel" role="dismiss" onPress={() => void submit($, request, '')}>
              Cancel
            </Button>
          </Box>
        )}
      </Box>
    )
  })
}
