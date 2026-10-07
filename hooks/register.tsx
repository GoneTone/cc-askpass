import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Requester } from './core'
import {
  AnsweredPids,
  applyMaskedInput,
  bashShellArgs,
  claudePidOf,
  clipLines,
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
  relayHost,
  relayParentArgs,
  remoteLabel,
  stripControl,
  wrapperTarget,
  wrappedLines,
  shouldMask,
  splitLines,
} from './core'

const READY_TIMEOUT_MS = 5000
const REPLY_TIMEOUT_MS = 5000
const ALIVE_POLL_MS = 2000
// Models add `-n` to sudo to avoid prompts they expect to hang; while the listener runs,
// the system prompt says sudo can ask instead.
const SUDO_NOTE =
  'sudo can ask the user for a password in this session: the cc-askpass plugin shows a password ' +
  'prompt inside Claude Code whenever sudo (or ssh/git) needs one. Run sudo commands normally. ' +
  'Do not add `-n` or `-S`, do not pipe a password into sudo, and do not ask the user to run sudo ' +
  'themselves. If the user cancels or the password is wrong, sudo fails as usual; report that.'
// Added while remote prompts are on: models add `-t` or ask the user to log in themselves.
const REMOTE_NOTE =
  ' sudo on hosts reached with `ssh` asks through the same prompt: run `ssh host sudo …` directly, ' +
  'without `-t` or `-tt`, and do not ask the user to log in to the host themselves.'
// Shown under the Claude line of every remote pane (spec §8): a process running as the user
// can pose as a relay, so the person is the last check.
const REMOTE_WARNING =
  'A remote prompt can be raised by any program running as you. Answer only if you expected this command to need a password on this host.'
// Characters of a remote host chain the heading shows; the verified host at its end always stays.
const MAX_LABEL_LENGTH = 120
// Characters of a remote program's name the heading shows.
const MAX_PROGRAM_LENGTH = 40
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
// True while the listener runs and the env points at it.
let isListening = false
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
// The plugin's options, read in `register`; a change reloads the module.
let isRemoteOn = true
let excludeHosts: readonly string[] = []

function log($: EngineInterface, text: string): void {
  void $.ui.log(`cc-askpass: ${text}`, { to: 'debug' })
}

// Requests are checked one at a time, so the queue keeps the order they arrived in.
let checking: Promise<void> = Promise.resolve()

function onRequestLine($: EngineInterface, line: string): void {
  checking = checking.then(() => verify($, line)).catch(error => {
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
  const request: Request = { helperPid: parsed.helperPid, prompt: parsed.prompt, requester, isRetry: false, claudeCommand: null }

  if (!requester.isSudo) {
    const host = relayHost(requester.command, `${$.plugin.root}/bin/shim/ssh`)
    if (!(await (host === null ? isTrustedCaller($, requester) : isWrapperRelay($, requester.pid, host)))) {
      // The helper is ours: an empty answer makes it fail at once instead of waiting.
      $.ui.toast(`Rejected askpass request from ${requester.comm} (pid ${requester.pid})`)
      log($, `rejected request from untrusted caller: ${requester.command}`)
      return reply($, request.helperPid, '')
    }
    if (host !== null) {
      // Everything but the host is remote text: it may not drive the terminal.
      const clean = (text: string | null) => (text === null ? null : stripControl(text) || null)
      requester.remote = { host, via: clean(parsed.via), reported: clean(parsed.reported) }
      request.prompt = stripControl(parsed.prompt)
    }
  }

  const claudeCommand = await findClaudeCommand($, requester)
  // A local line that repeats the sudo command says nothing new; a remote pane always names it.
  const isRepeat = requester.remote === undefined && claudeCommand?.trim() === requester.command.trim()
  request.claudeCommand = isRepeat ? null : claudeCommand
  const key = retryKey(request)
  request.isRetry = key !== null && answered.has(key, await $.clock.now())
  queue.push(request)
  // The checks are done: a pane that fails to open leaves the request for /askpass.
  void showNext($).catch(error => log($, `could not show the request: ${String(error)}`))
}

/** Whether a non-sudo caller is a real ssh/git binary (see `isTrustedClient`). */
async function isTrustedCaller($: EngineInterface, requester: Requester): Promise<boolean> {
  // `<owner uid> <path>` of the caller's executable (bin/exe-of).
  const exe = await $.process.run(['sh', `${$.plugin.root}/bin/exe-of`, String(requester.pid)])
  return isTrustedClient(requester, exe.exitCode === 0 ? parseExeInfo(exe.stdout) : null)
}

/**
 * Whether relay `relayPid` was started by our ssh wrapper running in normal mode for `host`:
 * a `--relay` started by hand, or by a wrapper connected elsewhere, does not pass. The host
 * comes from the command line Claude's command ran, never from the remote side.
 */
async function isWrapperRelay($: EngineInterface, relayPid: number, host: string): Promise<boolean> {
  const ps = await $.process.run(['ps', '-e', '-ww', '-o', 'pid=,ppid=,args='])
  const wrapper = relayParentArgs(parsePsTable(ps.stdout), relayPid)
  return wrapper !== null && wrapperTarget(wrapper, `${$.plugin.root}/bin/shim/ssh`) === host
}

/** The Bash command Claude ran that led to `requester`, if one of the recent ones matches. */
async function findClaudeCommand($: EngineInterface, requester: Requester): Promise<string | null> {
  const claudePid = claudePidOf(sessionDir)
  if (claudePid === null || recentBashCommands.length === 0) return null
  try {
    const ps = await $.process.run(['ps', '-e', '-ww', '-o', 'pid=,ppid=,args='])
    const shell = bashShellArgs(parsePsTable(ps.stdout), requester.pid, claudePid)
    return shell === null ? null : matchBashCommand(shell, recentBashCommands)
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

/** A relayed request also ends with its relay: nothing is left to carry the answer back. */
async function isRequestAlive($: EngineInterface, request: Request): Promise<boolean> {
  if (!(await isAlive($, request.helperPid))) return false
  return request.requester.remote === undefined || isAlive($, request.requester.pid)
}

/**
 * What answered requests are remembered by, to tell a retry: sudo's pid locally. A relayed
 * line carries only the remote helper's pid, new on every ask, so a remote request goes by its
 * relay (one per ssh command) and the command the remote side reported.
 */
function retryKey(request: Request): number | string | null {
  const { remote, isSudo, pid } = request.requester
  if (remote !== undefined) return `${remote.host}:${pid}:${remote.reported ?? ''}`
  return isSudo ? pid : null
}

/** The program a remote request names: the reported command's first word, or "a program". */
function remoteProgram(reported: string | null): string {
  const first = (reported ?? '').split(' ')[0] ?? ''
  return (first.split('/').at(-1) ?? '').slice(0, MAX_PROGRAM_LENGTH) || 'a program'
}

/** The remote host chain, its start cut when long: the verified host at its end stays. */
function hostLabel(remote: NonNullable<Requester['remote']>): string {
  const label = remoteLabel(remote.host, remote.via)
  return label.length > MAX_LABEL_LENGTH ? `…${label.slice(1 - MAX_LABEL_LENGTH)}` : label
}

/** Who waits for the password, for the band. */
function askerName(requester: Requester): string {
  const { remote } = requester
  return remote === undefined ? requester.comm : `${remoteProgram(remote.reported)} on ${remote.host}`
}

function isMaskedByDefault(request: Request): boolean {
  const { remote, isSudo } = request.requester
  // A remote sudo is masked whatever its prompt says, as sudo is locally.
  return shouldMask(remote === undefined ? isSudo : remoteProgram(remote.reported) === 'sudo', request.prompt)
}

function paneTitle(requester: Requester): string {
  if (requester.remote !== undefined) return `Password for ${requester.remote.host}`
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
  // A remote pane always has the line: what Claude Code recorded is the one thing no process
  // can change, and "(unknown)" says nothing vouches for the request.
  const command = request.claudeCommand ?? (request.requester.remote === undefined ? null : '(unknown)')
  if (command === null) return null
  return clipLines(`Claude ran: ${command}`, MAX_SECTION_ROWS, PANE_WIDTH)
}

function commandLine(request: Request): string {
  const { remote } = request.requester
  if (remote === undefined) return clipLines(`$ ${request.requester.command}`, MAX_SECTION_ROWS, PANE_WIDTH)
  if (remote.reported === null) return `$ (not reported by ${remote.host})`
  // Only the reported text is cut: who reported it must stay in view.
  const suffix = ` (reported by ${remote.host})`
  const room = MAX_SECTION_ROWS * PANE_WIDTH - suffix.length
  const line = `$ ${remote.reported}`
  return `${line.length > room ? `${line.slice(0, room - 1)}…` : line}${suffix}`
}

/**
 * Rows the pane body needs, measured at PANE_WIDTH (an inline pane is usually wider, so this
 * errs tall). The focus warning is counted always: whether it shows is known only when drawn.
 */
function paneRows(request: Request): number {
  const claude = claudeLine(request)
  // The `remote` tag and the warning under the Claude line.
  const remote = request.requester.remote === undefined ? 0 : 1 + wrappedLines(REMOTE_WARNING, PANE_WIDTH)
  const header =
    wrappedLines(paneHeading(request.requester), PANE_WIDTH) +
    remote +
    (claude === null ? 0 : wrappedLines(claude, PANE_WIDTH)) +
    wrappedLines(commandLine(request), PANE_WIDTH)
  const field = (request.isRetry ? 1 : 0) + wrappedLines(promptLabel(request.prompt), PANE_WIDTH) + 1
  const blankLines = 2
  return wrappedLines(focusWarning(false), PANE_WIDTH) + header + field + 1 + blankLines
}

function paneHeading(requester: Requester): string {
  const { remote } = requester
  if (remote !== undefined) {
    const program = remoteProgram(remote.reported)
    return `${program} on ${hostLabel(remote)} needs ${program === 'sudo' ? 'your' : 'a'} password`
  }
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
      if (!(await isRequestAlive($, next))) continue
      const request = next
      current = request
      typed = ''
      isMasked = isMaskedByDefault(request)
      // A pane still open from before a reload is not drawn again by `ui.open`.
      $.ui.invalidate('ui.render')
      aliveTimer = $.clock.every(ALIVE_POLL_MS, () => {
        void isRequestAlive($, request)
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
  const key = retryKey(request)
  if (key !== null) answered.mark(key, await $.clock.now())
  await finish($, request)
}

async function setEnv($: EngineInterface): Promise<void> {
  await $.env.set('CC_ASKPASS_DIR', sessionDir)
  await $.env.set('SUDO_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
  // Read by bin/shim/ssh, one glob per line.
  await $.env.set('CC_ASKPASS_EXCLUDE', excludeHosts.join('\n'))
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
  isListening = false
  await $.env.set('CC_ASKPASS_DIR', undefined)
  await $.env.set('SUDO_ASKPASS', undefined)
  await $.env.set('SSH_ASKPASS', undefined)
  await $.env.set('SSH_ASKPASS_REQUIRE', undefined)
  await $.env.set('CC_ASKPASS_EXCLUDE', undefined)
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
        isListening = true
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

export const register: Register = (on, options) => {
  isRemoteOn = options.remoteHosts !== false
  excludeHosts = typeof options.excludeHosts === 'object' ? options.excludeHosts : []

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

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isListening) return composed
    const text = isRemoteOn ? SUDO_NOTE + REMOTE_NOTE : SUDO_NOTE
    return { sections: [...composed.sections, { id: 'cc-askpass:sudo', text, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    // The command as Claude wrote it: the prefix below is ours.
    recentBashCommands.push(e.command)
    if (recentBashCommands.length > RECENT_BASH_LIMIT) recentBashCommands.shift()
    if (!isListening || !isRemoteOn) return next(e)
    // After the snapshot's own `export PATH`, so the command and its children (rsync, git,
    // scripts) find the ssh wrapper first.
    const shim = `${$.plugin.root}/bin/shim`.replaceAll(`'`, `'\\''`)
    return next({ ...e, command: `export PATH='${shim}':"$PATH"; ${e.command}` })
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
          {askerName(request.requester)} is waiting for a password — {howToOpen}
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
    const warning = e.props.isFocused ? null : focusWarning(isMainScreen(e))
    const claude = claudeLine(request)
    const isRemote = request.requester.remote !== undefined

    return (
      <Box flexDirection="column" paddingX={1}>
        {warning !== null && (
          <Text color="red" bold>
            {warning}
          </Text>
        )}
        <Text bold wrap="wrap">
          {paneHeading(request.requester)}
        </Text>
        {isRemote && <Text dimColor>remote</Text>}
        {claude !== null && (
          <Text dimColor wrap="wrap">
            {claude}
          </Text>
        )}
        {isRemote && (
          <Text dimColor wrap="wrap">
            {REMOTE_WARNING}
          </Text>
        )}
        <Text dimColor wrap="wrap">
          {commandLine(request)}
        </Text>
        <Text> </Text>
        {request.isRetry && <Text color="red">Sorry, try again.</Text>}
        <Text wrap="wrap">{promptLabel(request.prompt)}</Text>
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
        <Text> </Text>
        <Box>
          <Button key="cancel" role="dismiss" onPress={() => void submit($, request, '')}>
            Cancel
          </Button>
        </Box>
      </Box>
    )
  })
}
