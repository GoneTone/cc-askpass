// Pure logic for the askpass mod: nothing here touches `$`.

const ANSWERED_TTL_MS = 10 * 60 * 1000
// Whole command lines are shown; this only stops a pathological argv from flooding the pane.
const MAX_COMMAND_LENGTH = 2000

/** Who a request says asked: shown to the person, never used to refuse it. */
export type AskSource =
  | { kind: 'program'; exe: string }
  | { kind: 'relay'; host: string; realSsh: string | null }
  | { kind: 'unverified'; exe: string | null }

export type Requester = {
  pid: number
  isSudo: boolean
  comm: string
  command: string
  askedBy: AskSource
  // Set for a request relayed by our ssh wrapper: `host` from the wrapper's own args, the rest
  // as the remote side reported it, control characters removed.
  remote?: { host: string; via: string | null; reported: string | null }
}

/** The `Asked by:` text for a source. */
export function askedByLine(source: AskSource): string {
  if (source.kind === 'program') return source.exe
  if (source.kind === 'relay') return `cc-askpass ssh wrapper → ${source.host}${source.realSsh === null ? '' : ` (${source.realSsh})`}`
  return `${source.exe ?? 'unknown program'} (unverified)`
}

const firstLine = (out: string): string => out.split('\n')[0] ?? ''

/** Splits streamed text into complete lines; `rest` is the unterminated tail. */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const lines = (rest + chunk).split('\n')
  return { lines: lines.slice(0, -1), rest: lines.at(-1) ?? '' }
}

/** The session dir from the serve process's first line, `ready<TAB><dir>`. */
export function parseReady(line: string): string | null {
  return /^ready\t(.+)$/.exec(line)?.[1] ?? null
}

/**
 * A helper's request line, `<pid><TAB><prompt>`, optionally followed by `<TAB><via><TAB><reported>`:
 * the host chain and the command a relayed prompt claims. Empty optional fields become null.
 */
export function parseRequest(
  line: string,
): { helperPid: number; prompt: string; via: string | null; reported: string | null } | null {
  const [, pid, prompt, via, reported] = /^(\d+)\t([^\t]*)(?:\t([^\t]*)(?:\t(.*))?)?$/.exec(line) ?? []
  if (pid === undefined || prompt === undefined || Number(pid) <= 0) return null
  return { helperPid: Number(pid), prompt, via: via || null, reported: reported || null }
}

/**
 * The host of a process running our ssh wrapper as `[<interpreter> ]<shimPath> --relay <host>`;
 * null for any other process or a host with characters outside what ssh hosts use.
 */
export function relayHost(args: string, shimPath: string): string | null {
  const afterInterpreter = args.slice(args.indexOf(' ') + 1)
  for (const candidate of [args, afterInterpreter]) {
    if (!candidate.startsWith(`${shimPath} --relay `)) continue
    const host = candidate.slice(shimPath.length + ' --relay '.length)
    if (/^[A-Za-z0-9._@:%-]+$/.test(host)) return host
  }
  return null
}

/**
 * A relayed request's label: the reported host chain, then the host we verified, which always
 * comes last. The wrapper ends `via` with the hop it relays from, so that hop is not doubled.
 */
export function remoteLabel(host: string, via: string | null): string {
  if (!via || via === host) return host
  return via.endsWith(` via ${host}`) ? via : `${via} via ${host}`
}

/** `path` with `dir` first, or null when `dir` is already on it (a reload). */
export function withShim(path: string | undefined, dir: string, separator: ':' | ';' = ':'): string | null {
  if (path === undefined || path === '') return dir
  return path.split(separator).includes(dir) ? null : `${dir}${separator}${path}`
}

/**
 * 64-bit FNV-1a of `text`'s UTF-16 code units, low byte first, as 16 hex digits: names the
 * Windows helper's build after its source.
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    for (const byte of [unit & 0xff, unit >> 8]) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/** The Windows listener's first line, `ready<TAB><pipe name><TAB><32-digit token>`. */
export function parseWinReady(line: string): { pipe: string; token: string } | null {
  const [, pipe, token] = /^ready\t(cc-askpass-[^\t\\]+)\t([0-9a-f]{32})\r?$/.exec(line) ?? []
  return pipe === undefined || token === undefined ? null : { pipe, token }
}

/** A request as the Windows listener describes it: who connected (pid from the kernel) and what it asked. */
export type WinRequest = {
  id: number
  client: { pid: number; exe: string }
  parent: { pid: number; exe: string; args: string } | null
  // The client's ancestors from its parent up to Claude Code, for `Claude ran:`.
  ancestors: { pid: number; args: string }[]
  prompt: string
  relay: { host: string; realSsh: string; remotePid: number; via: string | null; reported: string | null } | null
}

/** One line of the Windows listener: a request, or `{"gone":<id>}` when its asker went away. */
export function parseWinLine(line: string): WinRequest | { gone: number } | null {
  let value: Partial<WinRequest> & { gone?: unknown }
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value?.gone === 'number') return { gone: value.gone }
  const { parent, relay, ancestors } = value ?? {}
  const isRequest =
    Number.isInteger(value?.id) &&
    isNumber(value.client?.pid) &&
    isString(value.client.exe) &&
    isString(value.prompt) &&
    (parent === null || (isNumber(parent?.pid) && isString(parent.exe) && isString(parent.args))) &&
    (relay === null ||
      (isString(relay?.host) &&
        isString(relay.realSsh) &&
        isNumber(relay.remotePid) &&
        isStringOrNull(relay.via) &&
        isStringOrNull(relay.reported))) &&
    Array.isArray(ancestors) &&
    ancestors.every(ancestor => isNumber(ancestor?.pid) && isString(ancestor.args))
  return isRequest ? (value as WinRequest) : null
}

const isNumber = (value: unknown): value is number => typeof value === 'number'
const isString = (value: unknown): value is string => typeof value === 'string'
const isStringOrNull = (value: unknown): value is string | null => value === null || isString(value)

// Windows paths ignore case and take either slash.
const isSamePath = (a: string, b: string): boolean =>
  a.replaceAll('/', '\\').toLowerCase() === b.replaceAll('/', '\\').toLowerCase()

/**
 * Who a Windows request says asked: through our helper, the program that started it; through
 * our ssh wrapper, its relay; anything else, the client itself, unverified.
 */
export function winAskSource(request: WinRequest, helperExe: string, shimExe: string): AskSource {
  const { client, parent, relay } = request
  // File names may hold bidi and format characters: a path shown to expose a program must not
  // disguise it. The host comes from the wrapper's arguments, which Claude chose.
  if (isSamePath(client.exe, helperExe)) {
    return parent === null ? { kind: 'unverified', exe: null } : { kind: 'program', exe: stripControl(parent.exe) }
  }
  if (isSamePath(client.exe, shimExe) && relay !== null) {
    return { kind: 'relay', host: stripControl(relay.host), realSsh: stripControl(relay.realSsh) }
  }
  return { kind: 'unverified', exe: stripControl(client.exe) }
}

/**
 * A Windows request's Requester, naming the process `Asked by:` names: the program behind our
 * helper, or else the client. `remote` is left to the caller, which cleans the relay's text.
 */
export function winRequester(request: WinRequest, helperExe: string, shimExe: string): Requester {
  const askedBy = winAskSource(request, helperExe, shimExe)
  const { client, parent } = request
  const asker = askedBy.kind === 'program' && parent !== null ? parent : client
  const args = stripControl(parent?.args ?? '')
  return {
    pid: asker.pid,
    isSudo: false,
    comm: (stripControl(asker.exe).split(/[\\/]/).at(-1) ?? '').replace(/\.exe$/i, '') || 'unknown program',
    command: args.length > MAX_COMMAND_LENGTH ? `${args.slice(0, MAX_COMMAND_LENGTH)}…` : args,
    askedBy,
  }
}

/**
 * The command Claude ran that led to a Windows request. A Bash call is on its shell's command
 * line, matched from the outermost ancestor in; a PowerShell call is on none, so it is named
 * only when an ancestor runs the PowerShell tool's launcher and exactly one call is running.
 */
export function winClaudeCommand(
  ancestors: WinRequest['ancestors'],
  recentBash: readonly string[],
  runningPowerShell: readonly string[],
): string | null {
  for (const { args } of ancestors.toReversed()) {
    const command = matchBashCommand(args, recentBash)
    if (command !== null) return command
  }
  const isPowerShell = ancestors.some(({ args }) => args.includes('$__claudeCodeScript'))
  return isPowerShell && runningPowerShell.length === 1 ? (runningPowerShell[0] ?? null) : null
}

/**
 * `text` without C0 and C1 control characters (ESC included) and the invisible format and
 * bidi characters that reorder or hide text: remote text must not drive the terminal or
 * disguise itself.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
}

/** Output of `ps -o ppid=,args= -p <helper pid>`; the args keep the prompt's trailing space. */
export function parseHelperPs(out: string): { ppid: number; args: string } | null {
  const [, ppid, args] = /^\s*(\d+)\s+(.*)$/.exec(firstLine(out)) ?? []
  return ppid === undefined || args === undefined ? null : { ppid: Number(ppid), args }
}

/**
 * Whether a helper's args run our askpass script: the path must be the program or its
 * interpreter's first argument, so a path smuggled into the prompt text does not count.
 */
export function isOurHelper(args: string, askpassPath: string): boolean {
  const afterInterpreter = args.slice(args.indexOf(' ') + 1)
  return [args, afterInterpreter].some(
    candidate => candidate === askpassPath || candidate.startsWith(`${askpassPath} `),
  )
}

/** Output of `ps -o user=,comm=,args= -p <pid>`; macOS prints the full path in `comm`. */
export function parseParentPs(out: string, pid: number): Omit<Requester, 'askedBy'> | null {
  const [, user, commPath, args] = /^\s*(\S+)\s+(\S+)\s+(.*?)\s*$/.exec(firstLine(out)) ?? []
  if (user === undefined || commPath === undefined || args === undefined) return null
  const comm = commPath.split('/').at(-1) ?? commPath
  const command = args.length > MAX_COMMAND_LENGTH ? `${args.slice(0, MAX_COMMAND_LENGTH)}…` : args
  return { pid, isSudo: user === 'root' && comm === 'sudo', comm, command }
}

/** A prompt for the line above the field, its trailing colon (and blanks) dropped. */
export function promptLabel(prompt: string): string {
  return prompt.replace(/\s*[:：]?\s*$/, '')
}

/**
 * Masks by default: prompts are localized, so only prompts known not to be secret
 * (git's untranslated username prompt, ssh's host-key question) are shown in clear.
 */
export function shouldMask(isSudo: boolean, prompt: string): boolean {
  return isSudo || !(/^Username for '/.test(prompt) || /\(yes\/no/.test(prompt))
}

/**
 * The real text behind a masked field, from the field's new text. Bullets stand for
 * characters already typed; other characters are new and replace whatever bullets are
 * missing around them (a select-all paste replaces everything). With no new characters,
 * the text got shorter, taken as deleted from the end.
 */
export function applyMaskedInput(real: string, shown: string): string {
  const leading = Math.min(/^•*/.exec(shown)?.[0].length ?? 0, real.length)
  const rest = shown.slice(leading)
  const trailing = Math.min(/•*$/.exec(rest)?.[0].length ?? 0, real.length - leading)
  const inserted = rest.slice(0, rest.length - trailing)
  if (inserted === '') return real.slice(0, shown.length)
  return real.slice(0, leading) + inserted + real.slice(real.length - trailing)
}

/**
 * Sudo pids (and keys of remote requests) already answered: a second request from one means
 * the password was wrong.
 */
export class AnsweredPids {
  private readonly answeredAt = new Map<number | string, number>()

  mark(pid: number | string, now: number): void {
    this.prune(now)
    this.answeredAt.set(pid, now)
  }

  has(pid: number | string, now: number): boolean {
    this.prune(now)
    return this.answeredAt.has(pid)
  }

  // Old entries go so a recycled pid is not mistaken for a retry.
  private prune(now: number): void {
    for (const [pid, at] of this.answeredAt) {
      if (now - at > ANSWERED_TTL_MS) this.answeredAt.delete(pid)
    }
  }
}

export type ExeInfo = { uid: number; path: string }

/** `<owner uid> <path>` of a process's resolved executable. */
export function parseExeInfo(out: string): ExeInfo | null {
  const [, uid, path] = /^(\d+) (.+)$/.exec(firstLine(out)) ?? []
  return uid === undefined || path === undefined ? null : { uid: Number(uid), path }
}

export type PsTable = Map<number, { ppid: number; args: string }>

/** Output of `ps -e -ww -o pid=,ppid=,args=`. */
export function parsePsTable(out: string): PsTable {
  const table: PsTable = new Map()
  for (const line of out.split('\n')) {
    const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? []
    if (pid !== undefined && ppid !== undefined && args !== undefined) {
      table.set(Number(pid), { ppid: Number(ppid), args })
    }
  }
  return table
}

/** The args of `pid`'s ancestor that Claude Code started: the Bash tool's shell, if any. */
export function bashShellArgs(table: PsTable, pid: number, claudePid: number): string | null {
  const seen = new Set<number>()
  for (let current = table.get(pid); current !== undefined; current = table.get(current.ppid)) {
    if (current.ppid === claudePid) return current.args
    if (seen.has(current.ppid)) return null
    seen.add(current.ppid)
  }
  return null
}

/**
 * Which of Claude's recent Bash commands that shell runs. The tool passes the command
 * single-quoted, a quote inside written as '"'"'; the longest match wins, so `true`
 * does not stand in for `sudo -k && sudo true`.
 */
export function matchBashCommand(shellArgs: string, recent: readonly string[]): string | null {
  const unquoted = shellArgs.replaceAll(`'"'"'`, `'`)
  let best: string | null = null
  for (const command of recent) {
    if (unquoted.includes(command) && command.length > (best?.length ?? 0)) best = command
  }
  return best
}

/** The Claude Code pid a session dir is named after (`<session id>-<pid>`). */
export function claudePidOf(sessionDir: string): number | null {
  const pid = /-(\d+)$/.exec(sessionDir)?.[1]
  return pid === undefined ? null : Number(pid)
}

/** Rows `text` takes when wrapped at `width` characters (wide characters count as one). */
export function wrappedLines(text: string, width: number): number {
  return text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0)
}

/** `text` cut to fit `maxRows` rows at `width`, an ellipsis marking the cut. */
export function clipLines(text: string, maxRows: number, width: number): string {
  const kept: string[] = []
  let rows = 0
  for (const line of text.split('\n')) {
    const need = wrappedLines(line, width)
    if (rows + need <= maxRows) {
      kept.push(line)
      rows += need
      continue
    }
    const room = maxRows - rows
    if (room > 0) {
      kept.push(`${line.slice(0, room * width - 1)}…`)
    } else {
      // The last kept line is full: put the ellipsis in place of its last character.
      const last = kept.pop() ?? ''
      kept.push(last.length > 0 && last.length % width === 0 ? `${last.slice(0, -1)}…` : `${last}…`)
    }
    return kept.join('\n')
  }
  return kept.join('\n')
}
