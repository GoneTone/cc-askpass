import { expect, test } from 'claude-code/testing'

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
  wrappedLines,
  shouldMask,
  splitLines,
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
  })
  expect(parseRequest('abc\tx')).toBe(null)
  expect(parseRequest('')).toBe(null)
  expect(parseRequest('0\tx')).toBe(null)
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

test('isTrustedClient accepts root-owned ssh and git binaries only', () => {
  const ssh = { pid: 1, isSudo: false, comm: 'ssh', command: 'ssh host' }
  expect(isTrustedClient(ssh, parseExeInfo('0 /usr/bin/ssh\n'))).toBe(true)
  expect(isTrustedClient(ssh, parseExeInfo('1000 /tmp/ssh\n'))).toBe(false)
  expect(isTrustedClient(ssh, parseExeInfo('0 /usr/bin/dash\n'))).toBe(false)
  expect(isTrustedClient(ssh, null)).toBe(false)
  const remote = { pid: 1, isSudo: false, comm: 'git-remote-http', command: 'git-remote-https origin' }
  expect(isTrustedClient(remote, parseExeInfo('0 /usr/lib/git-core/git-remote-https\n'))).toBe(true)
  // macOS does not cut comm at 15 characters.
  const macRemote = { ...remote, comm: 'git-remote-https' }
  expect(isTrustedClient(macRemote, parseExeInfo('0 /Library/Developer/CommandLineTools/usr/libexec/git-core/git-remote-https\n'))).toBe(true)
  expect(isTrustedClient({ ...remote, comm: 'sshd' }, parseExeInfo('0 /usr/sbin/sshd\n'))).toBe(false)
  // `git credential fill` prints what it is told to stdout, where Claude reads it.
  const git = { pid: 1, isSudo: false, comm: 'git', command: 'git credential fill' }
  expect(isTrustedClient(git, parseExeInfo('0 /usr/bin/git\n'))).toBe(false)
  const bash = { pid: 1, isSudo: false, comm: 'bash', command: 'bash -c x' }
  expect(isTrustedClient(bash, parseExeInfo('0 /usr/bin/bash\n'))).toBe(false)
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

test('matchBashCommand undoes the shell quoting and prefers the longest match', () => {
  const shell = `/bin/bash -c source /x && eval 'timeout 25 tail -f /dev/null; echo "it'"'"'s done"' < /dev/null`
  expect(matchBashCommand(shell, ['ls', `timeout 25 tail -f /dev/null; echo "it's done"`])).toBe(
    `timeout 25 tail -f /dev/null; echo "it's done"`,
  )
  expect(matchBashCommand(`eval 'sudo -k && sudo true'`, ['true', 'sudo -k && sudo true'])).toBe('sudo -k && sudo true')
  expect(matchBashCommand(`eval 'make install'`, ['ls', 'pwd'])).toBe(null)
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
