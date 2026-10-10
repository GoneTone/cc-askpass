import type { EngineInterface, Register, Timer } from 'claude-code'

import { askedByLine, type AskSource, type Requester, type WinRequest } from './core'
import {
  AnsweredPids,
  applyMaskedInput,
  bashShellArgs,
  bashSshFunction,
  isBashSshFunction,
  claudePidOf,
  clipLines,
  matchBashCommand,
  parsePsTable,
  isOurHelper,
  parseExePath,
  parseHelperPs,
  parseParentPs,
  parseReady,
  parseRequest,
  parseWinLine,
  parseWinReady,
  promptLabel,
  relayHost,
  remoteLabel,
  stripControl,
  withShim,
  withoutShim,
  wrappedLines,
  shouldMask,
  splitLines,
  fnv1a64,
  winClaudeCommand,
  winRequester,
} from './core'

const READY_TIMEOUT_MS = 5000
const REPLY_TIMEOUT_MS = 5000
const BUILD_TIMEOUT_MS = 60_000
const ALIVE_POLL_MS = 2000
// Models add `-n` to sudo to avoid prompts they expect to hang; while the listener runs,
// the system prompt says sudo can ask instead.
const SUDO_NOTE =
  'sudo can ask the user for a password in this session: the cc-askpass plugin shows a password ' +
  'prompt inside Claude Code whenever sudo (or ssh/git) needs one. Run sudo commands normally. ' +
  'Do not add `-n` or `-S`, do not pipe a password into sudo, and do not ask the user to run sudo ' +
  'themselves. If the user cancels or the password is wrong, sudo fails as usual; report that.'
// Windows has no sudo: only ssh and git ask there.
const WINDOWS_NOTE =
  'ssh and git can ask the user for a password or key passphrase in this session: the cc-askpass plugin shows a ' +
  'prompt inside Claude Code. Run them normally and do not ask the user to type passwords themselves.'
// Added while remote prompts are on: models add `-t` or ask the user to log in themselves.
const REMOTE_NOTE =
  ' sudo on hosts reached with `ssh` asks through the same prompt: run `ssh host sudo …` directly, ' +
  'without `-t` or `-tt`, and do not ask the user to log in to the host themselves.'
// Shown under the Claude line of every remote pane (spec §8): a process running as the user
// can pose as a relay, so the person is the last check.
const REMOTE_WARNING =
  'A remote prompt can be raised by any program running as you. Answer only if you expected this command to need a password on this host.'
// Shown in red under `Asked by:` when the request did not come through our helper.
const UNVERIFIED_WARNING =
  "This request did not come through cc-askpass's helper. Answer only if you know which program is asking."
// Characters of a remote host chain the heading shows; the verified host at its end always stays.
const MAX_LABEL_LENGTH = 120
// Characters of a remote program's name the heading shows.
const MAX_PROGRAM_LENGTH = 40
// A relayed host chain as the wrapper writes it: host names joined by ` via `.
const VIA_PATTERN = /^[A-Za-z0-9._@:%-]+( via [A-Za-z0-9._@:%-]+)*$/
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
  id: number
  prompt: string
  requester: Requester
  isRetry: boolean
  // The Bash tool command that led to this request, when it says more than the sudo line.
  claudeCommand: string | null
  // Set before the first await of an answer, so Enter, Esc and the alive poll answer once.
  isAnswered?: boolean
  // Windows: the listener generation it came from; its id means nothing to any other listener.
  generation?: number
}

// Module state. A hot reload starts it over and kills the serve child with the module.
// The password lives only in `typed`, and only while its pane is open.
let askpassPath = ''
let sessionDir = ''
// Native Windows (spec §5): a built helper and a named pipe instead of `sh`, `ps` and FIFOs.
let isWin = false
// Windows: the build directory, and the listener's pipe, reply token and own image path once it is ready.
let winOutDir = ''
// Windows: the person's own exported `ssh` function, put back when ours goes.
// ponytail: module state, so a hot reload forgets it; keep it in $.state if that matters.
let inheritedBashSsh: string | undefined
let winListener = { pipe: '', token: '', exe: '' }
// Windows requests whose asker went away; the listener says so instead of `kill -0`.
const goneIds = new Set<number>()
// The commands of PowerShell tool calls running now: the tool puts them on no command line.
const runningPowerShell: string[] = []
let didSetDisplay = false
// True while the listener runs and the env points at it.
let isListening = false
// Bumped whenever a serve loop is replaced, so the old loop's end is not taken for a crash.
let serveGeneration = 0
let stopServe = () => {}
// The running listener's loop, done once it has taken back what it set.
let serving: Promise<void> = Promise.resolve()
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

/** A line of the listener of `generation`, checked behind the lines before it. */
function onRequestLine($: EngineInterface, line: string, generation: number): void {
  // Windows ids restart at 1 with each listener: a replaced one's lines would name the new one's requests.
  const isStale = () => isWin && generation !== serveGeneration
  checking = checking
    .then(() => (isStale() ? undefined : isWin ? verifyWin($, line, generation) : verify($, line)))
    .catch(error => {
      // ps missing (a slim container) or failing: say so, and let the helper fail now.
      $.ui.toast(`cc-askpass: could not check an askpass request: ${String(error)}`)
      log($, `request failed: ${String(error)}`)
      if (isStale()) return
      const parsed = isWin ? parseWinLine(line) : parseRequest(line)
      if (parsed !== null && !('gone' in parsed)) void reply($, 'id' in parsed ? parsed.id : parsed.helperPid, '')
    })
}

/** Queues a Windows request: the listener already named who connected. */
async function verifyWin($: EngineInterface, line: string, generation: number): Promise<void> {
  const parsed = parseWinLine(line)
  if (parsed === null) return log($, `ignored malformed request line: ${line}`)
  if ('gone' in parsed) {
    // The alive poll and the queue drop it.
    goneIds.add(parsed.gone)
    return
  }
  // The kernel names a client by its resolved image path, as it named the listener itself.
  const requester = winRequester(parsed, winListener.exe)
  const request: Request = {
    id: parsed.id,
    prompt: parsed.prompt,
    requester,
    isRetry: false,
    claudeCommand: null,
    generation,
  }
  return enqueue($, request, parsed.relay?.via ?? null, parsed.relay?.reported ?? null, parsed.ancestors)
}

/** Works out who asks with `ps` and queues the request; no caller is refused, the person decides. */
async function verify($: EngineInterface, line: string): Promise<void> {
  const parsed = parseRequest(line)
  if (parsed === null) return log($, `ignored malformed request line: ${line}`)

  const helperPs = await $.process.run(['ps', '-ww', '-o', 'ppid=,args=', '-p', String(parsed.helperPid)])
  const helper = parseHelperPs(helperPs.stdout)
  if (helper === null) return
  const id = parsed.helperPid
  let requester: Requester
  if (!isOurHelper(helper.args, askpassPath)) {
    log($, `request from pid ${id} did not come through our helper: ${helper.args}`)
    requester = {
      pid: id,
      isSudo: false,
      comm: 'unknown program',
      command: stripControl(helper.args),
      askedBy: { kind: 'unverified', exe: null },
    }
  } else {
    const parentPs = await $.process.run(['ps', '-ww', '-o', 'user=,comm=,args=', '-p', String(helper.ppid)])
    const parent = parseParentPs(parentPs.stdout, helper.ppid)
    if (parent === null) return
    requester = { ...parent, askedBy: await programOf($, parent) }
  }
  const request: Request = { id, prompt: parsed.prompt, requester, isRetry: false, claudeCommand: null }
  return enqueue($, request, parsed.via, parsed.reported, [])
}

/**
 * Cleans a relayed request's remote text, names the command Claude ran and queues the request.
 * `via` and `reported` are a relay's raw fields; `ancestors` the Windows client's.
 */
async function enqueue(
  $: EngineInterface,
  request: Request,
  via: string | null,
  reported: string | null,
  ancestors: WinRequest['ancestors'],
): Promise<void> {
  const { requester } = request
  if (requester.askedBy.kind === 'relay') {
    // With remote prompts off no relay is taken: the helper is ours, so an empty answer makes it fail at once.
    if (!isRemoteOn) {
      log($, 'rejected a remote request: remoteHosts is off')
      return reply($, request.id, '')
    }
    // Everything but the host is remote text: it may not drive the terminal.
    const clean = (text: string | null) => (text === null ? null : stripControl(text) || null)
    // The wrapper writes host names only: any other chain is dropped, not shown.
    const hosts = via !== null && VIA_PATTERN.test(via) ? via : null
    requester.remote = { host: requester.askedBy.host, via: hosts, reported: clean(reported) }
  }
  // Any program can raise a pane, so no prompt may drive the terminal either.
  request.prompt = stripControl(request.prompt)

  const claudeCommand = await findClaudeCommand($, requester, ancestors)
  // A local line that repeats the sudo command says nothing new; a remote pane always names it.
  const isRepeat = requester.remote === undefined && claudeCommand?.trim() === requester.command.trim()
  request.claudeCommand = isRepeat ? null : claudeCommand
  const key = retryKey(request)
  request.isRetry = key !== null && answered.has(key, await $.clock.now())
  queue.push(request)
  // The checks are done: a pane that fails to open leaves the request for /askpass.
  void showNext($).catch(error => log($, `could not show the request: ${String(error)}`))
}

/** What the helper's parent is: our ssh wrapper's relay, or a program named by its executable. */
async function programOf($: EngineInterface, parent: Omit<Requester, 'askedBy'>): Promise<AskSource> {
  const host = relayHost(parent.command, `${$.plugin.root}/bin/shim/ssh`)
  if (host !== null) return { kind: 'relay', host, realSsh: null }
  // The path of the parent's executable (bin/exe-of).
  const exe = await $.process.run(['sh', `${$.plugin.root}/bin/exe-of`, String(parent.pid)])
  const path = exe.exitCode === 0 ? parseExePath(exe.stdout) : null
  return { kind: 'program', exe: stripControl(path ?? (parent.isSudo ? 'sudo (root)' : parent.comm)) }
}

/** The command Claude ran that led to `requester`: on Windows from the client's `ancestors`. */
async function findClaudeCommand(
  $: EngineInterface,
  requester: Requester,
  ancestors: WinRequest['ancestors'],
): Promise<string | null> {
  if (isWin) return winClaudeCommand(ancestors, recentBashCommands, runningPowerShell)
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
  // The Windows listener reports a gone asker, relay included: its connection is the request.
  // An ended or replaced listener took every connection with it.
  if (isWin) return isListening && request.generation === serveGeneration && !goneIds.has(request.id)
  if (!(await isAlive($, request.id))) return false
  return request.requester.remote === undefined || isAlive($, request.requester.pid)
}

/**
 * What answered requests are remembered by, to tell a retry; only sudo asks again for the
 * same thing. Locally sudo's pid. A relayed line carries only the remote helper's pid, new on
 * every ask, so a remote sudo goes by its relay (one per ssh command), the command the remote
 * side reported and the prompt.
 */
function retryKey(request: Request): number | string | null {
  const { remote, isSudo, pid } = request.requester
  if (remote === undefined) return isSudo ? pid : null
  if (remoteProgram(remote.reported) !== 'sudo') return null
  return `${remote.host}:${pid}:${remote.reported}:${request.prompt}`
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

function askedByText(requester: Requester): string {
  return `Asked by: ${askedByLine(requester.askedBy)}`
}

function isUnverified(requester: Requester): boolean {
  return requester.askedBy.kind === 'unverified'
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
    wrappedLines(askedByText(request.requester), PANE_WIDTH) +
    (isUnverified(request.requester) ? wrappedLines(UNVERIFIED_WARNING, PANE_WIDTH) : 0) +
    remote +
    (claude === null ? 0 : wrappedLines(claude, PANE_WIDTH)) +
    wrappedLines(commandLine(request), PANE_WIDTH)
  const field = (request.isRetry ? 1 : 0) + wrappedLines(promptLabel(request.prompt), PANE_WIDTH) + 1
  const blankLines = 3
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

/**
 * Answers Windows request `id` through `cc-askpass.exe --reply`, which hands it to the listener's
 * reply pipe. Exit 0 means written, not accepted: a wrong token or an ended request is dropped there.
 */
async function winReply($: EngineInterface, id: number, password: string): Promise<void> {
  // The reply is one line: a line break would cut the password short, so it is sent as a cancel.
  if (/[\r\n]/.test(password)) {
    log($, `the password for request ${id} had a line break; answered empty`)
    password = ''
  }
  try {
    const result = await $.process.run([askpassPath, '--reply'], {
      stdin: `${winListener.token}\t${id}\n${password}\n`,
      env: { CC_ASKPASS_PIPE: winListener.pipe },
      timeoutMs: REPLY_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) log($, `reply to request ${id} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`)
  } catch (error) {
    log($, `reply to request ${id} failed: ${String(error)}`)
  }
}

async function reply($: EngineInterface, id: number, password: string): Promise<void> {
  if (isWin) return winReply($, id, password)
  try {
    await $.process.run(['sh', '-c', REPLY_SCRIPT, '_', `${sessionDir}/reply.${id}`], {
      stdin: `${password}\n`,
      timeoutMs: REPLY_TIMEOUT_MS,
    })
  } catch (error) {
    log($, `reply to pid ${id} failed: ${String(error)}`)
  }
}

async function submit($: EngineInterface, request: Request, password: string): Promise<void> {
  if (current !== request || request.isAnswered) return
  request.isAnswered = true
  await reply($, request.id, password)
  const key = retryKey(request)
  if (key !== null) answered.mark(key, await $.clock.now())
  await finish($, request)
}

async function setEnv($: EngineInterface): Promise<void> {
  // Where the helper finds the listener goes first. Windows has no sudo and no DISPLAY check.
  if (isWin) {
    await $.env.set('CC_ASKPASS_PIPE', winListener.pipe)
  } else {
    await $.env.set('CC_ASKPASS_DIR', sessionDir)
    await $.env.set('SUDO_ASKPASS', askpassPath)
  }
  await $.env.set('SSH_ASKPASS', askpassPath)
  await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
  // Read by bin/shim/ssh, one glob per line.
  await $.env.set('CC_ASKPASS_EXCLUDE', excludeHosts.join('\n'))
  // remoteHosts: the wrapper stays on PATH all session and checks this on every call.
  await $.env.set('CC_ASKPASS_WRAP', isRemoteOn ? '1' : undefined)
  if (isWin) return
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
  if (isWin) {
    await $.env.set('CC_ASKPASS_PIPE', undefined)
  } else {
    await $.env.set('CC_ASKPASS_DIR', undefined)
    await $.env.set('SUDO_ASKPASS', undefined)
  }
  await $.env.set('SSH_ASKPASS', undefined)
  await $.env.set('SSH_ASKPASS_REQUIRE', undefined)
  await $.env.set('CC_ASKPASS_EXCLUDE', undefined)
  await $.env.set('CC_ASKPASS_WRAP', undefined)
  if (didSetDisplay) {
    await $.env.set('DISPLAY', undefined)
    await $.env.set('CC_ASKPASS_SET_DISPLAY', undefined)
    didSetDisplay = false
  }
}

/**
 * The Windows helper's build directory, `win\out\<hash of its source>`, compiled first when it
 * holds no `cc-askpass.exe`; otherwise why it could not be built (a missing source counts too).
 */
async function buildHelper($: EngineInterface, root: string): Promise<{ outDir: string } | { error: string }> {
  try {
    const source = `${root}\\win\\cc-askpass.cs`
    const outDir = `${root}\\win\\out\\${fnv1a64(await $.fs.read(source))}`
    if (await $.fs.exists(`${outDir}\\cc-askpass.exe`)) return { outDir }
    // Windows PowerShell 5.1, whatever the tools run: its Add-Type is the .NET Framework compiler.
    const systemRoot = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    // A run that throws (a timeout) is a failed build like any other.
    const build = await $.process
      .run(
        [powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${root}\\win\\build.ps1`, source, outDir],
        { timeoutMs: BUILD_TIMEOUT_MS },
      )
      .catch((error: unknown) => ({ exitCode: -1, stderr: String(error) }))
    // A build of the same source by another session starting at once may have finished it.
    if (build.exitCode === 0 || (await $.fs.exists(`${outDir}\\cc-askpass.exe`))) return { outDir }
    // build.ps1 prints one line; PowerShell's own errors put the reason first.
    const reason = build.stderr.trim().split(/\r?\n/)[0]?.replace(/^cc-askpass: build failed: /, '')
    return { error: reason || `exit code ${build.exitCode}` }
  } catch (error) {
    return { error: String(error) }
  }
}

/**
 * Why the built helper cannot run (AppLocker, WDAC or an antivirus blocks it), or null when it
 * runs: bare and without a listener, a working helper says CC_ASKPASS_PIPE is not set.
 */
async function helperRunError($: EngineInterface, exe: string): Promise<string | null> {
  try {
    const run = await $.process.run([exe], { env: { CC_ASKPASS_PIPE: '' }, timeoutMs: REPLY_TIMEOUT_MS })
    if (run.exitCode === 1 && run.stderr.includes('CC_ASKPASS_PIPE is not set')) return null
    return run.stderr.trim().split(/\r?\n/)[0] || `exit code ${run.exitCode}`
  } catch (error) {
    return String(error)
  }
}

/**
 * Builds the Windows helper, checks that it runs and gives bash our ssh; false, toasted, when
 * either failed: a shim that cannot run would break every ssh.
 */
async function startWindows($: EngineInterface): Promise<boolean> {
  const built = await buildHelper($, $.plugin.root)
  if ('error' in built) {
    $.ui.toast(`cc-askpass: could not build the Windows helper: ${built.error}`)
    return false
  }
  const error = await helperRunError($, `${built.outDir}\\cc-askpass.exe`)
  if (error !== null) {
    $.ui.toast(`cc-askpass: could not run the Windows helper: ${error}`)
    return false
  }
  // A second start replaces a running listener only now that its own helper runs. The old one
  // ends first: ending later, it could take back the shim set below.
  if (serveGeneration > 0) {
    serveGeneration++
    stopServe()
    // Its last env writes land before they are taken back.
    await serving
    await endWinListener($)
  }
  winOutDir = built.outDir
  const before = await $.env.get('BASH_FUNC_ssh%%')
  // An earlier load's function is ours; anything else is the person's and comes back later.
  inheritedBashSsh = before !== undefined && !isBashSshFunction(before) ? before : undefined
  // Git Bash's profile puts its /usr/bin (and its ssh) before the inherited PATH, so every bash
  // imports this as an `ssh` function instead; the two variables stop it rewriting `/x` arguments
  // into Windows paths.
  await $.env.set('BASH_FUNC_ssh%%', bashSshFunction(`${winOutDir}\\shim\\ssh.exe`))
  return true
}

/**
 * Takes our ssh back off PATH and out of bash once the listener never started or ended. The Bash
 * tool's snapshot keeps the function, where the wrapper passes through: CC_ASKPASS_WRAP is unset.
 */
async function removeWinShim($: EngineInterface): Promise<void> {
  await $.env.set('BASH_FUNC_ssh%%', inheritedBashSsh)
  await $.env.set('PATH', withoutShim(await $.env.get('PATH'), `${winOutDir}\\shim`, ';'))
}

/**
 * Drops every Windows request: they went with the listener that held their connections, and no
 * `gone` line will come. A new listener numbers its requests from 1; the askers send theirs anew.
 */
async function dropWinRequests($: EngineInterface): Promise<void> {
  goneIds.clear()
  queue.length = 0
  if (current !== null) await finish($, current)
}

/** Everything the Windows listener set, and its requests, gone with it. */
async function endWinListener($: EngineInterface): Promise<void> {
  // Its env only once it was ready: an inherited SSH_ASKPASS it never replaced stays.
  if (isListening) await unsetEnv($)
  await dropWinRequests($)
  await removeWinShim($)
}

async function runServe($: EngineInterface): Promise<void> {
  stopServe()
  const generation = ++serveGeneration
  askpassPath = isWin ? `${winOutDir}\\cc-askpass.exe` : `${$.plugin.root}/bin/askpass`
  if (isWin) await dropWinRequests($)
  const serve = $.process.spawn({ argv: [askpassPath, isWin ? 'serve' : '--serve', await $.session.id()] })
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
          onRequestLine($, line, generation)
          continue
        }
        const ready = isWin ? parseWinReady(line) : parseReady(line)
        if (ready === null) continue
        isReady = true
        readyTimer.cancel()
        if (typeof ready === 'string') sessionDir = ready
        else winListener = ready
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
    if (isWin) await removeWinShim($)
    return
  }
  if (isWin) await endWinListener($)
  else await unsetEnv($)
  $.ui.toast(`cc-askpass: the askpass listener stopped; ${isWin ? 'ssh' : 'sudo'} will not ask for passwords here`)
}

export const register: Register = (on, options) => {
  isRemoteOn = options.remoteHosts !== false
  const globs: unknown = options.excludeHosts
  excludeHosts = Array.isArray(globs) ? globs.filter((glob): glob is string => typeof glob === 'string') : []

  on('session.start', async ($, e, next) => {
    // Under -p or the SDK nobody can answer a pane: leave sudo to fail at once as before.
    if (!e.isInteractive) return next(e)
    isWin = (await $.env.get('OS')) === 'Windows_NT'
    // Before the session's shell snapshot, which fixes PATH for every Bash command: a command
    // that changed PATH itself would lose the permission dialog's "don't ask again".
    if (isWin && !(await startWindows($))) return next(e)
    const shim = isWin ? `${winOutDir}\\shim` : `${$.plugin.root}/bin/shim`
    const path = withShim(await $.env.get('PATH'), shim, isWin ? ';' : ':')
    if (path !== null) await $.env.set('PATH', path)
    const started = await next(e)
    await $.command.register({
      name: 'askpass',
      description: 'Open the pending password prompt',
      immediate: true,
    })
    serving = runServe($).catch(error => log($, `askpass listener failed: ${String(error)}`))
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isListening) return composed
    const note = isWin ? WINDOWS_NOTE : SUDO_NOTE
    const text = isRemoteOn ? note + REMOTE_NOTE : note
    return { sections: [...composed.sections, { id: 'cc-askpass:sudo', text, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (e.tool === 'Bash') {
      recentBashCommands.push(e.command)
      if (recentBashCommands.length > RECENT_BASH_LIMIT) recentBashCommands.shift()
    }
    return next(e)
  })

  // A request's ancestors show that the PowerShell tool runs, not what: while exactly one call
  // runs, that call is the one (spec §7). The tool has no typed arguments, so it is matched by pattern.
  on('tool.call', { tool: /^PowerShell$/ }, async ($, e, next) => {
    const { command } = e as { command?: unknown }
    if (typeof command !== 'string') return next(e)
    runningPowerShell.push(command)
    try {
      return await next(e)
    } finally {
      runningPowerShell.splice(runningPowerShell.indexOf(command), 1)
    }
  })

  on('session.end', async ($, e, next) => {
    // After /clear or an in-process resume the process goes on under a new session id and
    // no session.start follows, so the listener and the env pointing at its dir stay.
    // The Windows listener leaves no files: it ends with Claude Code.
    const isProcessEnding = e.reason !== 'clear' && e.reason !== 'resume'
    if (!isWin && isProcessEnding && sessionDir !== '') await $.process.run(['rm', '-rf', sessionDir])
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
    const key = `password-${request.id}-${LOAD_ID}`
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
        <Text dimColor wrap="wrap">
          {askedByText(request.requester)}
        </Text>
        {isUnverified(request.requester) && (
          <Text color="red" wrap="wrap">
            {UNVERIFIED_WARNING}
          </Text>
        )}
        {isRemote && <Text dimColor>remote</Text>}
        <Text> </Text>
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
