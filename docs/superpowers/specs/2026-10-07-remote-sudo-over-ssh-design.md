# cc-askpass — Remote password prompts over ssh — Design

Status: approved design, not yet implemented (2026-10-07).
Extends `2026-10-05-claude-code-askpass-design.md`; everything there still holds unless this
document says otherwise. Native Windows support is a separate sub-project (B) with its own spec.

## 1. Problem

cc-askpass answers password prompts from processes on the user's machine. When Claude runs a
command on another host over ssh, the prompt happens there:

```
ssh server sudo systemctl restart nginx
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

The remote sudo has no terminal and no askpass helper, and even if it had one, the helper
would run on the remote host, out of reach of the pane.

Goal: password prompts raised on a host Claude reached over ssh reach the same pane, and the
answer goes back to the remote process that asked, never through the model's context.

This is an open-source tool: the design covers every scenario below, not one user's workflow.

### Success criteria

- `ssh server sudo apt update` asks in the pane and succeeds.
- `ssh server ./deploy.sh`, where the script calls sudo, asks in the pane and succeeds.
- Hosts that cannot take part (git hosting, network devices, forced commands, Windows sshd)
  behave exactly as without the mod.
- `git push` over ssh, `scp`, `sftp` and `rsync` keep working unchanged.
- The pane always says which host asked, and a remote host cannot fake that.

## 2. Scope

### 2.1 Scenarios to support

1. `ssh host sudo cmd`.
2. Several sudo calls in one connection: `ssh host 'sudo a && sudo b'`.
3. sudo nested in remote programs: `ssh host ./deploy.sh`, `ssh host make install`.
4. Other remote prompts that use askpass: `git pull` over HTTPS on the remote, an ssh key
   passphrase when the remote host ssh's further.
5. ssh started indirectly: `rsync --rsync-path="sudo rsync"`, `ansible -b`, scripts calling ssh.
6. Hops: `ssh -J jump host sudo …`, and sudo on a third host reached by ssh from the remote
   (any depth).
7. `ssh -t` / `ssh -tt` added by Claude.

### 2.2 Environments to tolerate

- Remote OS: Linux distributions, macOS, BSD.
- Remote login shell: sh, bash, zsh, fish, others.
- Remote without python, socat, or a netcat with `-U`.
- Remote `/tmp` mounted noexec, read-only home directory.
- sshd with `AllowStreamLocalForwarding no` and an `AcceptEnv` that only passes `LANG`/`LC_*`.
- Local `~/.ssh/config` with `RemoteCommand`, `ControlMaster`/`ControlPersist`; callers such as
  ansible passing their own `-o ControlPath`.

### 2.3 Out of scope

- Windows sshd as the remote host (the remote helper is POSIX sh). It is detected and left
  untouched (§5.2), so it still works as without the mod.
- `su`, `doas`, polkit (`pkexec`) on the remote, for the same reasons as locally.
- Native Windows as the local host: sub-project B.

## 3. Verified facts

- Claude Code's Bash tool runs `source <snapshot> && eval '<command>'`. The snapshot ends with
  `export PATH='…'`, a PATH captured when the session started. A PATH set with `$.env.set` is
  overwritten on every command; variables the snapshot does not export (`SUDO_ASKPASS` …) are
  not. Setting PATH before the snapshot is taken is not reliable either: Debian's
  `/etc/profile` resets PATH and macOS's `path_helper` puts `/usr/bin` first.
- A `tool.call` hook can rewrite the Bash command with `next({ ...e, command })`.
- sudo started with `-A` uses `SUDO_ASKPASS` whether or not a terminal is present and needs no
  `DISPLAY`.
- OpenSSH on Linux and macOS supports connection multiplexing (`ControlMaster`); extra
  sessions over a master need no new authentication. sshd allows 10 sessions per connection by
  default (`MaxSessions`).

## 4. Architecture

```
Claude's Bash command
  └─ tool.call hook: prefix  export PATH='<plugin>/bin/shim':"$PATH";
       └─ bin/shim/ssh (wrapper)
            ├─ probe channel   ─┐
            ├─ master: ssh host <bootstrap + original command>
            │                    │ remote: <base>/cc-askpass-<token>/
            │                    │   askpass, sudo (wrapper), ssh (wrapper), req FIFO
            ├─ relay channel  ◄──┘  remote askpass → req FIFO → relay
            │     └─ local bin/askpass "<prompt>"  → serve FIFO → mod → pane
            └─ reply channel: ssh -S ctl host 'cat > reply.<pid>'  (password on stdin)
```

### 4.1 Repository layout

```
bin/askpass          existing helper; ask mode shared with the remote side
bin/shim/ssh         new: ssh wrapper, the only file in the PATH-prefixed directory
bin/remote.sh        new: remote bootstrap, relay and wrappers, sent base64-encoded
hooks/core.ts        new pure functions: ssh argument parsing, wrap decision, host label,
                     remote request parsing
hooks/register.tsx   PATH prefix, remote requests, pane wording, system prompt note, options
tests/ssh.sh         new: wrapper and end-to-end tests
```

`bin/shim/` holds only `ssh` so the PATH prefix shadows nothing else.

### 4.2 The `tool.call` prefix

For Bash calls, while the listener is running, the hook prefixes the command with
`export PATH='<plugin root>/bin/shim':"$PATH"; ` (the root single-quoted, `'` escaped). The
prefix runs after the snapshot, so child processes (rsync, git, ansible, scripts) inherit it.
The command recorded for the "Claude ran" line stays the original one. With the listener down
or the remote feature turned off, no prefix is added.

### 4.3 `bin/shim/ssh`

POSIX sh. Never writes to stdout.

1. Find the real ssh: PATH without the shim directory, then `command -v ssh`. If that resolves
   to the wrapper itself, print an error to stderr and exit 255.
2. Pass through (`exec` the real ssh with the original arguments) when:
   - `CC_ASKPASS_DIR` or `SSH_ASKPASS` is unset, or the listener behind `CC_ASKPASS_DIR` is not
     running (`serve.pid` locally, `relay.pid` on a remote hop; same check as `bin/askpass`);
   - there is no remote command (interactive login);
   - any of `-N -W -O -s -G -V -Q` is given;
   - the remote command is a protocol command: `git-upload-pack`, `git-receive-pack`,
     `git-upload-archive`, `scp -t`, `scp -f`, `rsync --server` without `sudo`, `borg serve`,
     `sftp-server`, `internal-sftp`;
   - the host matches an `excludeHosts` pattern.
3. Pass through as well when the real ssh is not a root-owned binary named `ssh`: a PATH the
   model chose must not route the answer into a program of its own.
4. Otherwise open a private master: the real ssh with `-o ControlMaster=yes
   -o ControlPath=<ctl>`. A caller's own `-S`/`ControlPath` is never reused (a caller-supplied
   socket can be a fake multiplexer that receives the answer). `<ctl>` is a short path inside
   the session directory, or in a fresh 0700 directory under `/tmp` when the session path plus
   OpenSSH's 17-byte temporary suffix would exceed the socket path limit (104 bytes on macOS).
   A command too long to carry the bootstrap within one 128 KiB argument runs unwrapped.
5. Probe (§5.2). On failure, run the original command unwrapped over the master.
6. On success run the wrapped command (§4.4) over the master with stdin, stdout and stderr
   untouched, start the relay (§4.5) in the background, and exit with the remote command's
   status. On TERM/INT/HUP stop the master and the relay.

### 4.4 Remote bootstrap

The wrapper sends one command line that works in any login shell, fish included:

```
env CCAP_TOKEN=<token> CCAP_B64=<base64 of bin/remote.sh + original command> /bin/sh -c 'eval "$(printf %s "$CCAP_B64" | base64 -d 2>/dev/null || printf %s "$CCAP_B64" | base64 -D)"'
```

`bin/remote.sh` then:

1. Picks the first base directory that is writable and allows exec: `$XDG_RUNTIME_DIR`,
   `$HOME/.cache`, `/tmp`. Creates `<base>/cc-askpass-<token>/` with mode 0700. Removes
   `cc-askpass-*` siblings whose recorded owner pid is gone.
2. Writes into it: `askpass` (the ask mode of `bin/askpass`), `sudo` (wrapper), `ssh` (the
   wrapper, for further hops), the request FIFO.
3. Exports `SUDO_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`, `CC_ASKPASS_DIR` (the
   token directory) and `PATH="<token dir>:$PATH"`.
4. Runs the original command as ssh would: `"${SHELL:-/bin/sh}" -c '<original>'`, not `exec`,
   so a trap on EXIT/HUP/TERM removes the token directory afterwards. Exits with its status.
5. If no base directory works, runs the original command with none of the above, which is the
   behaviour without the mod.

The remote `sudo` wrapper finds the real sudo the same way as the ssh wrapper and adds `-A`
unless `-A`, `-S`, `-n` (or long forms) are present. With `-A`, sudo uses askpass even under
`ssh -tt`. Calls to `/usr/bin/sudo` by absolute path skip the wrapper; they have no terminal
in the non-`-t` case and still find `SUDO_ASKPASS`.

The remote `ssh` wrapper is `bin/shim/ssh` itself. On the remote its "local listener" is the
remote askpass: a request from a further hop goes up through the remote askpass, the relay of
the previous hop, and so on to the user's machine.

### 4.5 Relay and reply

- Relay channel: `ssh -S <ctl> host '<relay>'` with stdin `/dev/null`, its stdout into a 0600
  FIFO `r.<wrapper pid>` in the session directory, which the wrapper's `--relay` process reads.
  The remote relay waits for the token directory, writes `relay.pid`, and copies each verified
  request line to its stdout; it exits on a sentinel line the bootstrap writes into the request
  FIFO when the command ends (no `ps -p` needed, so BusyBox hosts are covered).
- Every session the wrapper opens over its master besides the command itself (probe, relay,
  reply) runs with `-F /dev/null -o BatchMode=yes -o ProxyCommand=false`, so a missing socket
  fails instead of opening a new connection somewhere else.
- For each line the wrapper runs `"$SSH_ASKPASS" "<prompt>"` with `CC_ASKPASS_VIA` and
  `CC_ASKPASS_REPORTED` set from the line (§4.6). `SSH_ASKPASS` is `bin/askpass` locally (set by
  the mod) and the token directory's `askpass` on a remote hop (set by the bootstrap), so the
  same wrapper works at every hop. Locally the mod then sees a helper whose parent is
  `bin/shim/ssh` (§5.1).
- Reply channel: `ssh -S <ctl> host 'cat > <token dir>/reply.<pid>'` with the answer on stdin
  (the reply FIFO path is checked on the remote the same way `REPLY_SCRIPT` checks it locally).
  An empty answer makes the remote askpass exit 1.
- The remote askpass fails at once, with a message, when `relay.pid` is missing or dead, as the
  local one does when `serve.pid` is dead.
- The relay verifies each request on the remote host before relaying it, with the rules the mod
  applies locally: the helper is the token directory's `askpass`, and its parent is sudo running
  as root or a root-owned trusted client binary (`ssh`, `ssh-add`, `scp`, `sftp`,
  `git-remote-http`; executable found through `/proc` or `lsof`, as `bin/exe-of` does, so
  `exe-of` ships in the payload). Anything else gets an empty reply on the remote and never
  reaches the pane, so a command Claude runs cannot call `$SUDO_ASKPASS` and read the answer.

### 4.6 Request line

Every askpass, local or remote, writes one line per request:

```
<pid> TAB <prompt> [TAB <via> TAB <reported command>]
```

The two trailing fields come from `CC_ASKPASS_VIA` and `CC_ASKPASS_REPORTED` when set; a plain
local request (sudo on this machine) has neither, so today's format is unchanged.

- A remote askpass started by sudo/ssh/git sets `<reported command>` itself:
  `ps -o args= -p $PPID` on that host, cut like the local command line, and leaves `<via>`
  empty.
- A wrapper relaying a line from host H sets `<via>` to H, or to `<via of the line> via H` when
  the line already names a hop, and passes `<reported command>` on unchanged.

Tabs and newlines inside fields become spaces; the line is cut under PIPE_BUF. Locally the mod
ignores `<via>` and `<reported command>` unless the helper's parent is this plugin's wrapper.

## 5. Request handling

### 5.1 Verification

A request from a helper whose parent is not sudo or a trusted client is accepted as remote when
the parent's args run this plugin's `bin/shim/ssh --relay <host>` (path checked exactly as
`isOurHelper` does), the relay's own parent is the same wrapper in normal mode, and the host
parsed from that parent's ssh arguments equals `<host>`. A `--relay` run by hand therefore does
not pass. The host label comes from parsing that wrapper's own arguments (`parseSshTarget`), the
command line Claude ran; text from the remote side never decides the host. For a further hop,
the line's `<via>` (§4.6) names the chain (`db01 via server`); `server` is the verified label and
`db01` is shown as reported by `server`.

### 5.2 Probe

Before wrapping, over the master:

```
ssh -S <ctl> host 'command -v mkfifo >/dev/null && command -v base64 >/dev/null && [ -x /bin/sh ] && echo cc-askpass-probe-ok'
```

stdin `/dev/null`, 5 s timeout. Anything but the exact line counts as failure. A forced command
(git hosting, gitolite, backup servers), a network device, Windows sshd or a host without these
tools fails the probe, and the original command runs unwrapped. The result is cached per
`<ctl>` for the life of the master.

### 5.3 Pane

- Heading: `sudo on server needs your password` (`<comm> on <host> needs a password` for others)
  plus a `remote` tag; never the local wording.
- `$` line: the reported command, followed by `(reported by server)`.
- `Claude ran:` line: the Bash command Claude ran, always shown for remote requests (even when
  it equals the `$` line), followed by a dim warning that a remote prompt can be raised by code
  running as the user and to check this command before answering.
- The remote prompt below, quoted. A remote prompt such as `[sudo] password for <local user>`
  still sits under the remote heading.
- Masking: every remote prompt is masked except git's `Username for '…'` and ssh's
  `(yes/no…)`, as locally.
- Retry hint: a second request from the same remote pid on the same host shows
  "Sorry, try again".

### 5.4 System prompt note

The existing sudo note gains one sentence: sudo on hosts reached with `ssh` also asks through
the pane, so run `ssh host sudo …` directly, without `-t`/`-tt` and without asking the user to
log in themselves.

## 6. Options

Declared as `userConfig` in `plugin.json`:

- `remoteHosts` (boolean, default true): the PATH prefix and the wrapper.
- `excludeHosts` (list of glob patterns, default empty): hosts the wrapper never touches even
  when the probe would pass.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| Connection or authentication fails | ssh's own message and exit status, unchanged |
| Probe hangs or fails | Run unwrapped, as without the mod |
| No usable remote base directory | Run the original command without askpass |
| Relay channel refused (`MaxSessions`) | Remote askpass fails at once with a message |
| Caller's own ControlPath (ansible) | Ignored; a private master is opened (one extra connection) |
| ControlPath too long | Use a short 0700 directory under `/tmp` |
| Command too long for one argument with the bootstrap | Run unwrapped |
| Real ssh is not a root-owned `ssh` binary | Pass through |
| Bash tool timeout / interrupt | Wrapper stops master and relay; remote trap cleans up on HUP |
| Connection drops mid-request | Remote askpass watchdog (10 min) ends; next bootstrap removes the stale directory |
| Listener not running | No PATH prefix; a wrapper run anyway passes through |
| Real ssh resolves to the wrapper | Error on stderr, exit 255 |
| Output channels | Wrapper and bootstrap never write to stdout (rsync, git protocols) |

## 8. Security boundaries

- Locally nothing changes: a request is shown only after `ps` shows it comes from this
  plugin's helper, started by sudo, a trusted client, or this plugin's ssh wrapper.
- On the remote host the relay applies the local verification rules (§4.5), so a command that
  simply calls askpass itself gets no answer.
- Residual risk, accepted by the project owner (2026-10-07) with the feature on by default: a
  relay is a shell script, and a process running as the user can make its command line look
  like one (`exec -a` with `BASH_ENV` needs no compiler). Only root-owned identities (sudo's
  euid, a root-owned executable) are anchored by the kernel. So code running as the user,
  locally or on the remote host, including a command Claude runs that deliberately forges a
  relay, can raise a pane that names a remote host and capture what is typed into it. Local
  sudo prompts are not affected. Mitigations: every remote pane shows the `Claude ran:` line
  (the Bash command as Claude Code recorded it, which no process can change) and a warning;
  the README states the risk and how to turn the feature off (`remoteHosts: false`). The pane therefore names the host from local, verified data and labels everything
  else as reported by the host.
- The token directory is 0700 and the socket permissions are sshd's (owner only), so other
  accounts on the remote host cannot raise prompts.
- The password travels pane → local FIFO → reply channel stdin → remote FIFO. It is never in an
  argument list, a file, the model's context, logs or toasts, on either side.
- Nothing is left on the remote host after the command ends; a crash leaves a 0700 directory
  that the next bootstrap removes.
- README: a remote prompt wants the remote host's password; never type a local password into a
  pane that says another host.

## 9. Testing

- `hooks/core.test.ts`: ssh argument parsing (options with values `-p -i -o -J -l -F -S -E -b
  -c -D -L -R`, combined flags like `-tp22`, `--`, `user@host`, `ssh://user@host:port`, remote
  command as one string or several words); pass-through decisions; protocol command detection;
  `excludeHosts` globs; host label from wrapper args, including args crafted to look like a
  different host; remote request line parsing and rejection of malformed lines.
- `hooks/pane.test.ts` / `lifecycle.test.ts`: PATH prefix only while listening and only for
  Bash; "Claude ran" matching unaffected by the prefix; remote request accepted only from the
  plugin's wrapper; pane heading, `(reported by …)` label and quoted prompt; the leak test
  extended to the remote flow; options turning the feature off.
- `tests/ssh.sh` with a recording fake `ssh`: pass-through versus wrap per case, options added,
  exit status propagated, nothing on stdout.
- `tests/ssh.sh` end to end against an sshd on localhost with a test key: the remote test
  script calls `$SUDO_ASKPASS` and the answer comes back; the remote `sudo` wrapper adds `-A`
  (checked with a fake sudo); a second hop (localhost to localhost); probe failure via a forced
  command without `/bin/sh`; `ssh -tt`; cleanup after the connection is killed.
- CI runs the shell tests on Linux and macOS runners (Remote Login enabled on macOS).
- Manual E2E with real sudo passwords on the macOS VM and WSL: `ssh host sudo …` and sudo
  inside a remote script.

## 10. Spikes before building

1. `tool.call` rewrite: the prefixed command runs, the transcript and the "Claude ran" record
   keep the original, background (`run_in_background`) commands get the prefix too.
2. `userConfig` options reach the module (`register(on, options)`), and their change takes
   effect without a restart or after `/reload-plugins`.
3. sshd on localhost in GitHub Actions on Linux and macOS runners.
