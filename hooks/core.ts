// Pure logic for the askpass mod: nothing here touches `$`.

const ANSWERED_TTL_MS = 10 * 60 * 1000
const MAX_COMMAND_LENGTH = 200

export type Requester = { pid: number; isSudo: boolean; comm: string; command: string }

/** Splits streamed text into complete lines; `rest` is the unterminated tail. */
export function splitLines(rest: string, chunk: string): { lines: string[]; rest: string } {
  const lines = (rest + chunk).split('\n')
  return { lines: lines.slice(0, -1), rest: lines[lines.length - 1] }
}

/** The session dir from the serve process's first line, `ready<TAB><dir>`. */
export function parseReady(line: string): string | null {
  const match = /^ready\t(.+)$/.exec(line)
  return match ? match[1] : null
}

/** A helper's request line, `<pid><TAB><prompt>`. */
export function parseRequest(line: string): { helperPid: number; prompt: string } | null {
  const match = /^(\d+)\t(.*)$/.exec(line)
  if (!match || Number(match[1]) <= 0) return null
  return { helperPid: Number(match[1]), prompt: match[2] }
}

/** Output of `ps -o ppid=,args= -p <helper pid>`. */
export function parseHelperPs(out: string): { ppid: number; args: string } | null {
  const match = /^\s*(\d+)\s+(.*)$/.exec(out.split('\n')[0])
  return match ? { ppid: Number(match[1]), args: match[2] } : null
}

/** Whether a helper's args run our askpass script, not a look-alike path. */
export function isOurHelper(args: string, askpassPath: string): boolean {
  return ` ${args} `.includes(` ${askpassPath} `)
}

/** Output of `ps -o user=,comm=,args= -p <pid>`; macOS prints the full path in `comm`. */
export function parseParentPs(out: string, pid: number): Requester | null {
  const match = /^\s*(\S+)\s+(\S+)\s+(.*?)\s*$/.exec(out.split('\n')[0])
  if (!match) return null
  const [, user, commPath, args] = match
  const comm = commPath.split('/').pop() ?? commPath
  const command = args.length > MAX_COMMAND_LENGTH ? `${args.slice(0, MAX_COMMAND_LENGTH)}…` : args
  return { pid, isSudo: user === 'root' && comm === 'sudo', comm, command }
}

/**
 * Masks by default: prompts are localized, so only prompts known not to be secret
 * (git's untranslated username prompt, ssh's host-key question) are shown in clear.
 */
export function shouldMask(isSudo: boolean, prompt: string): boolean {
  return isSudo || !(/^Username for '/.test(prompt) || /\(yes\/no/.test(prompt))
}

/**
 * The real text behind a masked field, from the field's new text: longer means
 * characters were added at the end, shorter means characters were deleted from it.
 */
export function applyMaskedInput(real: string, shown: string): string {
  return shown.length > real.length ? real + shown.slice(real.length) : real.slice(0, shown.length)
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
