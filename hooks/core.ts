// Pure logic for the askpass mod: nothing here touches `$`.

const ANSWERED_TTL_MS = 10 * 60 * 1000
// Whole command lines are shown; this only stops a pathological argv from flooding the pane.
const MAX_COMMAND_LENGTH = 2000

export type Requester = { pid: number; isSudo: boolean; comm: string; command: string }

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

/** A helper's request line, `<pid><TAB><prompt>`. */
export function parseRequest(line: string): { helperPid: number; prompt: string } | null {
  const [, pid, prompt] = /^(\d+)\t(.*)$/.exec(line) ?? []
  if (pid === undefined || prompt === undefined || Number(pid) <= 0) return null
  return { helperPid: Number(pid), prompt }
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

/** A prompt as an Input label: the Input draws its own colon after the label. */
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

/** Sudo pids already answered: a second request from one means the password was wrong. */
export class AnsweredPids {
  private readonly answeredAt = new Map<number, number>()

  mark(pid: number, now: number): void {
    this.prune(now)
    this.answeredAt.set(pid, now)
  }

  has(pid: number, now: number): boolean {
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
// `comm` is cut at 15 characters: git-remote-https reads as git-remote-http.
const ASKPASS_CLIENTS = ['ssh', 'ssh-add', 'scp', 'sftp', 'git-remote-http']

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
  if (exe === null || exe.uid !== 0 || !ASKPASS_CLIENTS.includes(requester.comm)) return false
  return (exe.path.split('/').at(-1) ?? '').startsWith(requester.comm)
}
