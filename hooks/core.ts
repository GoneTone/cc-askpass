// Pure logic for the askpass mod: nothing here touches `$`.

const ANSWERED_TTL_MS = 10 * 60 * 1000
// Whole command lines are shown; this only stops a pathological argv from flooding the pane.
const MAX_COMMAND_LENGTH = 2000

export type Requester = {
  pid: number
  isSudo: boolean
  comm: string
  command: string
  // Set for a request relayed by our ssh wrapper: `host` from the wrapper's own args, the rest
  // as the remote side reported it, control characters removed.
  remote?: { host: string; via: string | null; reported: string | null }
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

// ssh's options as getopts takes them (a colon after a letter that takes a value).
const SSH_OPTIONS = '1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy'

/**
 * The host a process running our ssh wrapper in normal mode (`[<interpreter> ]<shimPath> <ssh
 * args>`) connects to, named the way the wrapper names it (no `ssh://`, `user@` or `:port`).
 * ps joins the arguments with spaces, so they are split on whitespace: an option value with
 * a space in it (`-o "ProxyCommand ssh -W %h:%p jump"`) misreads, and the request is refused.
 */
export function wrapperTarget(args: string, shimPath: string): string | null {
  const afterInterpreter = args.slice(args.indexOf(' ') + 1)
  const command = [args, afterInterpreter].find(candidate => candidate.startsWith(`${shimPath} `))
  if (command === undefined) return null
  const words = command.slice(shimPath.length + 1).split(/\s+/).filter(Boolean)
  let i = 0
  for (; i < words.length; i++) {
    const word = words[i] ?? ''
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    for (let j = 1; j < word.length; j++) {
      const at = SSH_OPTIONS.indexOf(word[j] ?? '')
      if (at < 0 || word[j] === ':') return null
      if (SSH_OPTIONS[at + 1] !== ':') continue
      // The value is the rest of the word, or the next word.
      if (j === word.length - 1) i++
      break
    }
  }
  const host = words[i]
  return host === undefined ? null : hostName(host)
}

/** `host` without `ssh://`, `user@` and `:port`; a bare IPv6 address (several colons) stays whole. */
function hostName(host: string): string {
  const name = host.replace(/^ssh:\/\//, '').replace(/^.*@/, '')
  const isUrl = host.startsWith('ssh://')
  const colons = name.split(':').length - 1
  return colons > 0 && (isUrl || colons === 1) ? name.slice(0, name.lastIndexOf(':')) : name
}

/**
 * The args of the relay's parent, skipping subshells that copy the relay's own args (a shell
 * may fork one for `$(…)`); null when the table does not have it.
 */
export function relayParentArgs(table: PsTable, relayPid: number): string | null {
  const relay = table.get(relayPid)
  let parent = relay === undefined ? undefined : table.get(relay.ppid)
  for (let hops = 0; hops < 3 && parent !== undefined && parent.args === relay?.args; hops++) {
    parent = table.get(parent.ppid)
  }
  return parent === undefined || parent.args === relay?.args ? null : parent.args
}

/** `text` without C0 and C1 control characters (ESC included): remote text must not drive the terminal. */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
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
export function parseParentPs(out: string, pid: number): Requester | null {
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

// Programs other than sudo whose askpass answer goes back to them, not to the caller.
// Plain `git` is left out: `git credential fill` prints the answer to stdout. git's HTTPS
// prompts come from its remote helper.
// Linux cuts `comm` at 15 characters (git-remote-https reads as git-remote-http); macOS
// does not, so comm is cut the same way before the lookup.
const ASKPASS_CLIENTS = ['ssh', 'ssh-add', 'scp', 'sftp', 'git-remote-http']
const COMM_LENGTH = 15

export type ExeInfo = { uid: number; path: string }

/** `<owner uid> <path>` of a process's resolved executable. */
export function parseExeInfo(out: string): ExeInfo | null {
  const [, uid, path] = /^(\d+) (.+)$/.exec(firstLine(out)) ?? []
  return uid === undefined || path === undefined ? null : { uid: Number(uid), path }
}

/**
 * Whether a non-sudo requester is a real ssh/git binary. Anything else, a shell running
 * askpass directly included, would hand the answer to a command whose output Claude reads.
 * A root-owned binary named like the process rules out scripts and copies in /tmp.
 */
export function isTrustedClient(requester: Requester, exe: ExeInfo | null): boolean {
  if (exe === null || exe.uid !== 0 || !ASKPASS_CLIENTS.includes(requester.comm.slice(0, COMM_LENGTH))) return false
  return (exe.path.split('/').at(-1) ?? '').startsWith(requester.comm)
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
