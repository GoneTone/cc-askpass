import { expect, test } from 'claude-code/testing'

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
  promptLabel,
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
