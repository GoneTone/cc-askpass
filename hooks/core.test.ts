import { expect, test } from 'claude-code/testing'

import {
  AnsweredPids,
  applyMaskedInput,
  askedByLine,
  bashShellArgs,
  bashSshFunction,
  isBashSshFunction,
  claudePidOf,
  clipLines,
  matchBashCommand,
  parsePsTable,
  isOurHelper,
  parseHelperPs,
  parseParentPs,
  parseReady,
  parseRequest,
  relayHost,
  withShim,
  withoutShim,
  remoteLabel,
  stripControl,
  promptLabel,
  wrappedLines,
  shouldMask,
  splitLines,
  fnv1a64,
  parseWinReady,
  parseWinLine,
  winAskSource,
  winClaudeCommand,
  winMsysShell,
  winRequester,
  type WinRequest,
} from './core'

test('splitLines joins a line split across chunks', () => {
  expect(splitLines('', '12\tPass')).toEqual({ lines: [], rest: '12\tPass' })
  expect(splitLines('12\tPass', 'word: \n13\tx\n')).toEqual({
    lines: ['12\tPassword: ', '13\tx'],
    rest: '',
  })
})

test('parseReady reads the session dir', () => {
  expect(parseReady('ready\t/run/user/1000/cc-askpass/s1')).toBe(
    '/run/user/1000/cc-askpass/s1',
  )
  expect(parseReady('12\tx')).toBe(null)
})

test('parseRequest reads pid and prompt', () => {
  expect(parseRequest('4242\t[sudo] password for alice: ')).toEqual({
    helperPid: 4242,
    prompt: '[sudo] password for alice: ',
    via: null,
    reported: null,
  })
  expect(parseRequest('abc\tx')).toBe(null)
  expect(parseRequest('')).toBe(null)
  expect(parseRequest('0\tx')).toBe(null)
})

test('parseRequest reads the optional via and reported fields', () => {
  expect(parseRequest('42	Password: ')).toEqual({ helperPid: 42, prompt: 'Password: ', via: null, reported: null })
  expect(parseRequest('42	Password: 	db01	sudo apt update')).toEqual({
    helperPid: 42, prompt: 'Password: ', via: 'db01', reported: 'sudo apt update',
  })
  expect(parseRequest('42	Password: 		sudo true')?.via).toBe(null)
})

test('relayHost accepts only the plugin wrapper in relay mode', () => {
  const shim = '/opt/p/bin/shim/ssh'
  expect(relayHost(`/bin/sh ${shim} --relay server`, shim)).toBe('server')
  expect(relayHost(`${shim} --relay alice@db-1.example.com`, shim)).toBe('alice@db-1.example.com')
  expect(relayHost(`/bin/sh ${shim} -p 22 server sudo x`, shim)).toBe(null)
  expect(relayHost(`/bin/sh /tmp/evil --relay server`, shim)).toBe(null)
  expect(relayHost(`/bin/sh ${shim} --relay server; rm`, shim)).toBe(null)
})

test('remoteLabel ends with the verified host', () => {
  expect(remoteLabel('server', null)).toBe('server')
  expect(remoteLabel('server', 'db01')).toBe('db01 via server')
  expect(remoteLabel('server', 'db01 via evil')).toBe('db01 via evil via server')
  // The wrapper names the hop it relays from: a single hop reads as just the host.
  expect(remoteLabel('server', 'server')).toBe('server')
  expect(remoteLabel('server', 'db01 via server')).toBe('db01 via server')
})

test('askedByLine names the program, the wrapper or an unverified caller', () => {
  expect(askedByLine({ kind: 'program', exe: '/usr/bin/sudo' })).toBe('/usr/bin/sudo')
  expect(askedByLine({ kind: 'relay', host: 'server', realSsh: null })).toBe('cc-askpass ssh wrapper → server')
  expect(askedByLine({ kind: 'relay', host: 'server', realSsh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' }))
    .toBe('cc-askpass ssh wrapper → server (C:\\Windows\\System32\\OpenSSH\\ssh.exe)')
  expect(askedByLine({ kind: 'unverified', exe: null })).toBe('unknown program (unverified)')
  expect(askedByLine({ kind: 'unverified', exe: 'C:\\x\\evil.exe' })).toBe('C:\\x\\evil.exe (unverified)')
})

test('stripControl drops C0 and C1 controls, escape included', () => {
  expect(stripControl('a\u001b[31mb\u0007c\u009bd\u007fe\tf')).toBe('a[31mbcdef')
  expect(stripControl('sudo apt update')).toBe('sudo apt update')
})

test('stripControl drops invisible format and bidi characters', () => {
  expect(stripControl('a\u200bb\u200fc\u202ad\u202ee\u2066f\u2069g\u2028h\u2029i')).toBe('abcdefghi')
  // The Arabic letter mark, the BOM, the word joiner to the invisible plus, the Mongolian vowel separator.
  expect(stripControl('a\u061cb\ufeffc\u2060d\u2061e\u2064f\u180eg')).toBe('abcdefg')
})

test('withShim puts the directory first, once', () => {
  expect(withShim('/usr/bin:/bin', '/p/bin/shim')).toBe('/p/bin/shim:/usr/bin:/bin')
  expect(withShim(undefined, '/p/bin/shim')).toBe('/p/bin/shim')
  expect(withShim('', '/p/bin/shim')).toBe('/p/bin/shim')
  // A reload finds PATH as the last load left it.
  expect(withShim('/p/bin/shim:/usr/bin', '/p/bin/shim')).toBe(null)
  expect(withShim('/x:/p/bin/shim:/usr/bin', '/p/bin/shim')).toBe(null)
  expect(withShim('/p/bin/shim2:/usr/bin', '/p/bin/shim')).toBe('/p/bin/shim:/p/bin/shim2:/usr/bin')
})

test('parseHelperPs reads ppid and args', () => {
  expect(parseHelperPs('  4100 /bin/sh /opt/p/bin/askpass [sudo] password: ')).toEqual({
    ppid: 4100,
    args: '/bin/sh /opt/p/bin/askpass [sudo] password: ',
  })
  expect(parseHelperPs('')).toBe(null)
})

test('isOurHelper matches the askpass path exactly', () => {
  expect(isOurHelper('/bin/sh /opt/p/bin/askpass [sudo] password: ', '/opt/p/bin/askpass')).toBe(true)
  expect(isOurHelper('/bin/sh /tmp/evil.sh', '/opt/p/bin/askpass')).toBe(false)
  expect(isOurHelper('/bin/sh /opt/p/bin/askpass-evil x', '/opt/p/bin/askpass')).toBe(false)
})

test('isOurHelper rejects the path smuggled in through a prompt', () => {
  expect(isOurHelper('/bin/sh /tmp/evil  /opt/p/bin/askpass ', '/opt/p/bin/askpass')).toBe(false)
  expect(isOurHelper('cat /opt/p/bin/askpass', '/opt/p/bin/askpass')).toBe(true)
  expect(isOurHelper('/opt/p/bin/askpass [sudo] password: ', '/opt/p/bin/askpass')).toBe(true)
})

test('applyMaskedInput takes typed characters as replacing the bullets around them', () => {
  expect(applyMaskedInput('abc', 'x')).toBe('x')
  expect(applyMaskedInput('abc', 'xyz')).toBe('xyz')
  expect(applyMaskedInput('abc', '••x•')).toBe('abxc')
  expect(applyMaskedInput('abc', 'x•••')).toBe('xabc')
})

test('isOurHelper accepts a plugin path with spaces', () => {
  expect(isOurHelper('/bin/sh /home/a/my plugins/bin/askpass Password: ', '/home/a/my plugins/bin/askpass')).toBe(true)
  expect(isOurHelper('/bin/sh /home/a/my plugins/bin/askpass', '/home/a/my plugins/bin/askpass')).toBe(true)
})

test('parseParentPs recognises a root sudo', () => {
  expect(parseParentPs('root     sudo            sudo apt update', 4100)).toEqual({
    pid: 4100,
    isSudo: true,
    comm: 'sudo',
    command: 'sudo apt update',
  })
  expect(parseParentPs('root /usr/bin/sudo sudo -v', 4100)?.isSudo).toBe(true)
  expect(parseParentPs('alice ssh ssh -T git@github.com', 4100)?.isSudo).toBe(false)
  expect(parseParentPs('alice sudo sudo x', 4100)?.isSudo).toBe(false)
  expect(parseParentPs('', 4100)).toBe(null)
})

test('parseParentPs keeps the whole command up to a safety cap', () => {
  const long = `sudo ${'x'.repeat(1500)}`
  expect(parseParentPs(`root sudo ${long}`, 1)?.command).toBe(long)
  const command = parseParentPs(`root sudo sudo ${'x'.repeat(3000)}`, 1)?.command ?? ''
  expect(command.length).toBe(2001)
  expect(command.endsWith('…')).toBe(true)
})

test('shouldMask masks everything but known non-secret prompts', () => {
  expect(shouldMask(true, 'anything')).toBe(true)
  expect(shouldMask(false, "Username for 'https://github.com': ")).toBe(false)
  expect(shouldMask(false, 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe(false)
  expect(shouldMask(false, '[sudo] Passwort für alice: ')).toBe(true)
  expect(shouldMask(false, 'Enter PIN: ')).toBe(true)
})

test('promptLabel drops the trailing colon the Input draws itself', () => {
  expect(promptLabel('[sudo] password for alice: ')).toBe('[sudo] password for alice')
  expect(promptLabel("Enter passphrase for key '/x': ")).toBe("Enter passphrase for key '/x'")
  expect(promptLabel('Password:')).toBe('Password')
  expect(promptLabel('[sudo] パスワード： ')).toBe('[sudo] パスワード')
  expect(promptLabel('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe(
    'Are you sure you want to continue connecting (yes/no/[fingerprint])?',
  )
})

test('applyMaskedInput tracks appends and deletes', () => {
  expect(applyMaskedInput('', 'a')).toBe('a')
  expect(applyMaskedInput('ab', '••c')).toBe('abc')
  expect(applyMaskedInput('abc', '••')).toBe('ab')
  expect(applyMaskedInput('ab', '••xyz')).toBe('abxyz')
  expect(applyMaskedInput('abc', '')).toBe('')
})

test('AnsweredPids forgets pids after 10 minutes', () => {
  const answered = new AnsweredPids()
  answered.mark(7, 0)
  expect(answered.has(7, 599_999)).toBe(true)
  expect(answered.has(7, 600_001)).toBe(false)
  expect(answered.has(8, 0)).toBe(false)
  // Remote requests are keyed by host, relay and reported command.
  answered.mark('server:4100:sudo true', 0)
  expect(answered.has('server:4100:sudo true', 1)).toBe(true)
})

const TABLE = parsePsTable(
  [
    '  4242  4100 /bin/sh /opt/p/bin/askpass [sudo] password: ',
    '  4100   950 sudo true',
    `   950   900 /bin/bash -c source /x 2>/dev/null || true && eval 'sudo -k && sudo true' < /dev/null`,
    '   900     1 claude',
    '   700   700 loop',
  ].join('\n'),
)

test('parsePsTable reads pid, ppid and args', () => {
  expect(TABLE.get(4100)).toEqual({ ppid: 950, args: 'sudo true' })
  expect(TABLE.size).toBe(5)
})

test('bashShellArgs finds the ancestor Claude started', () => {
  expect(bashShellArgs(TABLE, 4100, 900)).toContain(`eval 'sudo -k && sudo true'`)
  expect(bashShellArgs(TABLE, 4100, 123)).toBe(null)
  expect(bashShellArgs(TABLE, 700, 900)).toBe(null)
  expect(bashShellArgs(TABLE, 99999, 900)).toBe(null)
})

test('matchBashCommand undoes the shell quoting and takes the longest whole quoted command', () => {
  const shell = `/bin/bash -c source /x && eval 'timeout 25 tail -f /dev/null; echo "it'"'"'s done"' < /dev/null`
  expect(matchBashCommand(shell, ['ls', `timeout 25 tail -f /dev/null; echo "it's done"`])).toBe(
    `timeout 25 tail -f /dev/null; echo "it's done"`,
  )
  expect(matchBashCommand(`eval 'sudo -k && sudo true'`, ['true', 'sudo -k && sudo true'])).toBe('sudo -k && sudo true')
  expect(matchBashCommand(`eval 'make install'`, ['ls', 'pwd'])).toBe(null)
  // A command that fell out of the recent list: a shorter one inside it is not it.
  expect(matchBashCommand(`eval './tools/setup.sh'`, ['ls'])).toBe(null)
  // An earlier command quoted inside the one that runs is not it either.
  expect(matchBashCommand(`eval 'sudo sh -c '"'"'apt update'"'"''`, ['apt update', `sudo sh -c 'apt update'`])).toBe(
    `sudo sh -c 'apt update'`,
  )
})

test('matchBashCommand takes a command the tool passed unquoted', () => {
  // A command with nothing to quote is passed as one bare word after eval.
  const shell = `/bin/bash -c source /x && eval ./install.sh < /dev/null && pwd -P >| /tmp/claude-1-cwd`
  expect(matchBashCommand(shell, ['ls', './install.sh'])).toBe('./install.sh')
  expect(matchBashCommand(`eval ./install.sh`, ['./install.sh'])).toBe('./install.sh')
  // The whole word still: neither a shorter command nor a prefix of it.
  expect(matchBashCommand(shell, ['ls', './install'])).toBe(null)
  expect(matchBashCommand(`eval ./install.sh.bak < /dev/null`, ['./install.sh'])).toBe(null)
})

test('claudePidOf reads the pid the session dir is named after', () => {
  expect(claudePidOf('/run/user/1000/cc-askpass/0d1c-26322')).toBe(26322)
  expect(claudePidOf('')).toBe(null)
})

test('wrappedLines counts the rows text takes at a width', () => {
  expect(wrappedLines('', 10)).toBe(1)
  expect(wrappedLines('abc', 10)).toBe(1)
  expect(wrappedLines('x'.repeat(25), 10)).toBe(3)
  expect(wrappedLines('ab\n' + 'x'.repeat(11), 10)).toBe(3)
})

test('clipLines keeps text within a number of rows', () => {
  expect(clipLines('short', 3, 10)).toBe('short')
  expect(clipLines('x'.repeat(40), 3, 10)).toBe(`${'x'.repeat(29)}…`)
  expect(clipLines('1\n2\n3\n4\n5', 3, 10)).toBe('1\n2\n3…')
  expect(wrappedLines(clipLines(`a\n${'y'.repeat(50)}\nb`, 3, 10), 10)).toBe(3)
})

test('fnv1a64 hashes UTF-16 code units, low byte first', () => {
  expect(fnv1a64('')).toBe('cbf29ce484222325')
  // Bytes 61 00.
  expect(fnv1a64('a')).toBe('089be207b544f1e4')
  expect(fnv1a64('a')).not.toBe(fnv1a64('b'))
})

test('withShim splits a Windows PATH on ;', () => {
  expect(withShim('C:\\a;C:\\b', 'C:\\s', ';')).toBe('C:\\s;C:\\a;C:\\b')
  expect(withShim('C:\\a;C:\\s;C:\\b', 'C:\\s', ';')).toBe(null)
})

test('withoutShim takes the directory off PATH', () => {
  expect(withoutShim('C:\\s;C:\\a;C:\\b', 'C:\\s', ';')).toBe('C:\\a;C:\\b')
  expect(withoutShim('C:\\a;C:\\b', 'C:\\s', ';')).toBe('C:\\a;C:\\b')
  expect(withoutShim('C:\\s', 'C:\\s', ';')).toBe('')
  expect(withoutShim(undefined, 'C:\\s', ';')).toBe(undefined)
})

test('bashSshFunction single-quotes the wrapper path', () => {
  expect(bashSshFunction('C:\\p\\shim\\ssh.exe')).toBe(
    `() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' 'C:/p/shim/ssh.exe' "$@"\n}`,
  )
  // `$`, a backtick and a quote are legal in Windows user names and CLAUDE_CONFIG_DIR.
  expect(bashSshFunction("C:\\Users\\a$b`c'd\\shim\\ssh.exe")).toBe(
    "() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' 'C:/Users/a$b`c'\\''d/shim/ssh.exe' \"$@\"\n}",
  )
})

test('isBashSshFunction knows ours, for any path, and nothing else', () => {
  expect(isBashSshFunction(bashSshFunction('C:\\p\\shim\\ssh.exe'))).toBe(true)
  expect(isBashSshFunction(bashSshFunction("C:\\Users\\a$b`c'd\\shim\\ssh.exe"))).toBe(true)
  expect(isBashSshFunction('() {  command ssh -v "$@"\n}')).toBe(false)
  expect(isBashSshFunction('')).toBe(false)
})

test('parseWinReady reads the pipe name, a 32-digit token and the helper path', () => {
  const token = 'a'.repeat(32)
  const exe = 'C:\\p\\win\\out\\0123456789abcdef\\cc-askpass.exe'
  const ready = { pipe: 'cc-askpass-S-900', token, exe }
  expect(parseWinReady(`ready\tcc-askpass-S-900\t${token}\t${exe}`)).toEqual(ready)
  expect(parseWinReady(`ready\tcc-askpass-S-900\t${token}\t${exe}\r`)).toEqual(ready)
  // An older listener's three fields, or no path.
  expect(parseWinReady(`ready\tcc-askpass-S-900\t${token}`)).toBe(null)
  expect(parseWinReady(`ready\tcc-askpass-S-900\t${token}\t`)).toBe(null)
  expect(parseWinReady(`ready\tcc-askpass-S-900\t${'a'.repeat(31)}\t${exe}`)).toBe(null)
  expect(parseWinReady('ready\t/run/user/1000/cc-askpass/S-900')).toBe(null)
})

const HELPER = 'C:\\p\\win\\out\\0123456789abcdef\\cc-askpass.exe'
const SHIM = 'C:\\p\\win\\out\\0123456789abcdef\\shim\\ssh.exe'
const WIN_SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'

function winRequest(fields: Partial<WinRequest> = {}): WinRequest {
  return {
    id: 7,
    client: { pid: 1, exe: HELPER },
    parent: { pid: 2, exe: WIN_SSH, args: 'ssh -T git@github.com' },
    ancestors: [{ pid: 2, args: 'ssh -T git@github.com' }],
    prompt: 'Enter passphrase for key: ',
    relay: null,
    ...fields,
  }
}

test('parseWinLine reads requests and gone lines', () => {
  const request = winRequest()
  expect(parseWinLine(JSON.stringify(request))).toEqual(request)
  expect(parseWinLine('{"gone":3}')).toEqual({ gone: 3 })
  expect(parseWinLine('garbage')).toBe(null)
  const { id: _, ...noId } = request
  expect(parseWinLine(JSON.stringify(noId))).toBe(null)
  const relay = { host: 'server', realSsh: WIN_SSH, remotePid: 4242, via: null, reported: 'sudo true' }
  expect(parseWinLine(JSON.stringify(winRequest({ relay })))).toEqual(winRequest({ relay }))
})

test('parseWinLine rejects fields of the wrong type', () => {
  const relay = { host: 'server', realSsh: WIN_SSH, remotePid: 4242, via: null, reported: null }
  const wrong: Record<string, unknown>[] = [
    { parent: 'ssh' },
    { parent: { pid: '2', exe: WIN_SSH, args: '' } },
    { parent: { pid: 2, exe: WIN_SSH } },
    { parent: undefined },
    { relay: 'server' },
    { relay: { ...relay, host: 7 } },
    { relay: { ...relay, realSsh: null } },
    { relay: { ...relay, remotePid: '4242' } },
    { relay: { ...relay, via: 1 } },
    { relay: { ...relay, reported: false } },
    { ancestors: [null] },
    { ancestors: [{ pid: '2', args: '' }] },
    { ancestors: [{ pid: 2 }] },
  ]
  for (const fields of wrong) expect(parseWinLine(JSON.stringify({ ...winRequest(), ...fields }))).toBe(null)
})

test('winAskSource names the program behind our helper, our relay, or the client', () => {
  expect(winAskSource(winRequest(), HELPER)).toEqual({ kind: 'program', exe: WIN_SSH })
  // Windows paths ignore case.
  const upper = winRequest({ client: { pid: 1, exe: HELPER.toUpperCase() } })
  expect(winAskSource(upper, HELPER)).toEqual({ kind: 'program', exe: WIN_SSH })
  expect(winAskSource(winRequest({ parent: null }), HELPER)).toEqual({ kind: 'unverified', exe: null })
  const relay = { host: 'server', realSsh: WIN_SSH, remotePid: 4242, via: null, reported: null }
  expect(winAskSource(winRequest({ client: { pid: 1, exe: SHIM }, relay }), HELPER)).toEqual({
    kind: 'relay',
    host: 'server',
    realSsh: WIN_SSH,
  })
  const evil = winRequest({ client: { pid: 1, exe: 'C:\\x\\evil.exe' }, relay })
  expect(winAskSource(evil, HELPER)).toEqual({ kind: 'unverified', exe: 'C:\\x\\evil.exe' })
  // A client whose image path could not be read, or held only invisible characters.
  expect(winAskSource(winRequest({ client: { pid: 1, exe: '' } }), HELPER)).toEqual({ kind: 'unverified', exe: null })
  expect(winAskSource(winRequest({ client: { pid: 1, exe: '\u202e' } }), HELPER)).toEqual({ kind: 'unverified', exe: null })
  // Either slash.
  const forward = winRequest({ client: { pid: 1, exe: HELPER.replaceAll('\\', '/') } })
  expect(winAskSource(forward, HELPER)).toEqual({ kind: 'program', exe: WIN_SSH })
  // The shim is the one beside the helper the listener runs from, whatever path the mod built it under.
  const otherShim = winRequest({ client: { pid: 1, exe: 'C:\\q\\shim\\ssh.exe' }, relay })
  expect(winAskSource(otherShim, HELPER).kind).toBe('unverified')
})

test('winAskSource strips bidi and control characters from paths', () => {
  // U+202E turns `evil\u202Egpj.exe` into what reads as "evilexe.jpg".
  const disguised = winRequest({ client: { pid: 1, exe: 'C:\\x\\evil\u202egpj.exe' } })
  expect(winAskSource(disguised, HELPER)).toEqual({ kind: 'unverified', exe: 'C:\\x\\evilgpj.exe' })
  expect(winRequester(disguised, HELPER).comm).toBe('evilgpj')
  const parent = { pid: 2, exe: 'C:\\x\\s\u202esh.exe', args: '' }
  expect(winAskSource(winRequest({ parent }), HELPER)).toEqual({ kind: 'program', exe: 'C:\\x\\ssh.exe' })
  const relay = { host: 'server', realSsh: 'C:\\x\\\u202essh.exe\u001b[2J', remotePid: 4242, via: null, reported: null }
  expect(winAskSource(winRequest({ client: { pid: 1, exe: SHIM }, relay }), HELPER)).toEqual({
    kind: 'relay',
    host: 'server',
    realSsh: 'C:\\x\\ssh.exe[2J',
  })
})

test('winRequester names the process that Asked by names', () => {
  expect(winRequester(winRequest(), HELPER)).toEqual({
    pid: 2,
    isSudo: false,
    comm: 'ssh',
    command: 'ssh -T git@github.com',
    askedBy: { kind: 'program', exe: WIN_SSH },
  })
  const evil = winRequester(winRequest({ client: { pid: 1, exe: 'C:\\x\\evil.exe' } }), HELPER)
  expect([evil.pid, evil.comm]).toEqual([1, 'evil'])
})

test('winClaudeCommand matches Bash calls, then a single PowerShell call', () => {
  const bash = [{ pid: 2, args: 'ssh h' }, { pid: 3, args: `bash.exe -c "eval 'ssh h && git push'"` }]
  expect(winClaudeCommand(bash, ['ssh h', 'ssh h && git push'], [])).toBe('ssh h && git push')
  const pwsh = [{ pid: 2, args: 'ssh h' }, { pid: 3, args: 'pwsh -Command "Invoke-Expression -Command $__claudeCodeScript"' }]
  expect(winClaudeCommand(pwsh, [], ['ssh h'])).toBe('ssh h')
  expect(winClaudeCommand(pwsh, [], ['ssh h', 'git push'])).toBe(null)
  expect(winClaudeCommand([{ pid: 2, args: 'ssh h' }], [], ['ssh h'])).toBe(null)
})

test('winMsysShell names the sh.exe beside the outermost MSYS ancestor', () => {
  const ancestors = [
    { pid: 2, args: 'ssh h' },
    { pid: 3, args: `"C:\\Program Files\\Git\\usr\\bin\\sh.exe" ./deploy.sh` },
    { pid: 4, args: 'C:\\Tools\\Git\\usr\\bin\\bash.exe ./outer.sh' },
  ]
  expect(winMsysShell(ancestors)).toBe('C:\\Tools\\Git\\usr\\bin\\sh.exe')
  expect(winMsysShell(ancestors.slice(0, 2))).toBe('C:\\Program Files\\Git\\usr\\bin\\sh.exe')
  // Windows OpenSSH and the PowerShell tool are no MSYS programs.
  expect(winMsysShell([{ pid: 2, args: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe h' }, { pid: 3, args: 'pwsh -Command x' }])).toBe(null)
})
