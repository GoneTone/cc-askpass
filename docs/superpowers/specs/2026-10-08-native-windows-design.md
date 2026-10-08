# cc-askpass — Native Windows, and showing callers instead of judging them — Design

Status: approved design, not yet implemented (2026-10-08).
Sub-project B. Changes the request model of the base design
(`2026-10-05-claude-code-askpass-design.md`) and of sub-project A
(`2026-10-07-remote-sudo-over-ssh-design.md`) on every platform; see §12.

## 1. Problem

On native Windows (Claude Code without WSL) the mod does not run: its helpers are POSIX sh
scripts, and the engine starts processes by argument vector with no shell. Yet Claude on
Windows hits the same wall as elsewhere: ssh key passphrases, ssh password logins and sudo on
hosts reached with ssh all need a terminal that the Bash and PowerShell tools do not have.

Separately, the caller checks of the base design and of A (trusted-client lists, root-owned
binaries, process-chain walks, a verification pass on the remote host) misjudge real setups
and make the design hard to follow. They are replaced, on every platform, by showing who asks
and leaving the decision to the person at the pane.

### Success criteria

- On native Windows, from both the Bash tool (Git Bash) and the PowerShell tool, an ssh key
  passphrase, an ssh password login and `ssh host sudo …` each raise the pane, and the answer
  reaches the program that asked. The password never enters the model's context.
- Every pane, on every platform, shows the executable that asked (`Asked by:`), as reported by
  the operating system wherever it can be.
- Linux, macOS and WSL keep working as today apart from that change.

## 2. Scope

### 2.1 Scenarios to support (Windows)

1. Bash tool → Git for Windows' ssh: key passphrase, password login, keyboard-interactive.
2. Bash tool → git over ssh (`git push git@github.com:…`).
3. PowerShell tool → Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`): the same prompts.
4. git configured to use Windows OpenSSH (`core.sshCommand`, `GIT_SSH`), common with the
   Windows ssh-agent service.
5. git over HTTPS without Git Credential Manager: `GIT_ASKPASS`/`SSH_ASKPASS`.
6. Remote sudo from either tool (`ssh host sudo …`, scripts on the host, further hops), with
   the remote side of A.
7. Indirect: `scp`, `sftp`, `ssh -J`, ssh called from local scripts.

### 2.2 Environments to tolerate

- Git for Windows installed or not (it is optional; without it Claude Code runs commands with
  the PowerShell tool only), installed for all users or for one user, scoop/MSYS2/Cygwin ssh.
- Windows PowerShell 5.1 and PowerShell 7; x64 and ARM64.
- Non-ASCII user names, paths and prompts; spaces in paths.
- Windows Terminal, conhost, VS Code and JetBrains terminals, the desktop app.
- Several Claude Code sessions at once.

### 2.3 Out of scope

- Windows `sudo.exe` and UAC prompts (no password is typed into a program).
- A Windows sshd as the remote host (A's remote side is POSIX sh).
- Programs that show their own window: Git Credential Manager, Pageant.
- Machines that block running unsigned programs built locally (AppLocker, WDAC) or block
  `Add-Type`: the mod stays off and says why (§8).

## 3. Verified facts (spikes, 2026-10-08, Windows 11 26200)

- The engine spawns `powershell.exe` and streams its stdout piece by piece (pieces arrived at
  328, 1064 and 1765 ms for lines 700 ms apart). Lines end in `\r\n`. `$.plugin.root` is a
  backslash path; PATH is `;`-separated.
- `$.env.set('PATH', …)` mid-session reaches the PowerShell tool at once (`ssh` resolved to a
  `ssh.cmd` placed first). The Bash tool keeps the PATH of its snapshot, as on Linux; other
  variables reach both tools at once.
- Both Git for Windows' ssh (OpenSSH 9.7, MSYS) and Windows OpenSSH (9.5) call `SSH_ASKPASS`
  with `SSH_ASKPASS_REQUIRE=force` and no terminal. Windows OpenSSH cannot start a script
  (`CreateProcessW failed error:193`); it starts `.exe` and `.cmd`.
- **A `.cmd` askpass is a command injection.** Windows OpenSSH starts it as
  `cmd.exe /c ""askpass.cmd" "<prompt>""` with `"` in the prompt escaped as `\"`, which cmd does
  not honour: a prompt `a"&echo INJECTED>marker&"b@host's password:` ran `echo`. Prompts can
  come from the remote server (keyboard-interactive), so askpass must be an `.exe`.
- A console `.exe` built on the machine from C# source with the built-in .NET Framework 4.8
  (`Add-Type -OutputType ConsoleApplication`) compiles in 154 ms, starts in 59 ms, and receives
  the same prompt intact as one argument; nothing ran.
- A named pipe whose ACL allows only the current user works with both ssh builds; the server
  gets the client's pid from the kernel (`GetNamedPipeClientProcessId`); a passphrase with
  `& | " ^ % ! <` round-trips intact.
- Process information through CIM costs about 0.85 s per query; Win32 APIs are used instead.
- ControlMaster is unusable on Windows: Windows OpenSSH refuses it (`getsockname failed: Not a
  socket`); Git's ssh starts a master, but every session over it fails
  (`mux_client_request_session: … Connection reset by peer`) and silently opens a new
  connection (9 logins for 9 sessions).
- Git Bash cannot open `//./pipe/…` as a file.
- Git's ssh 9.7 refuses user names with shell characters; Windows OpenSSH 9.5 does not.
- The PowerShell tool runs `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command
  "…Invoke-Expression -Command $__claudeCodeScript"` under `cmd.exe`, the command itself in the
  environment variable `CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT`: it is not on any command line. The
  Bash tool's `bash.exe -c "… eval '<command>'"` carries it, as on Linux.

## 4. Request model: show, don't judge (all platforms)

A request is never rejected because of who sent it. The pane gains one line, `Asked by:`, the
executable that asked, and the person decides. Removed:

- local: `isTrustedCaller`, `isTrustedClient`, `parseExeInfo` (the root-owned trusted-client
  rule), `isWrapperRelay`/`relayWrapperHost` (the relay's parent-chain check), the
  "Rejected forged askpass request" and "Rejected askpass request from …" toasts;
- remote (`bin/remote.sh`): `verify()` and shipping `exe-of`; the relay passes every line from
  the token directory's request FIFO;
- the wrapper's "real ssh must be a root-owned binary named `ssh`" pass-through rule.

Kept: the Bash-command matching for `Claude ran:` (display only), `remoteHosts` (a relayed
request is still answered empty while it is off) and `excludeHosts`, masking, retry hints, and
the check that a helper pid runs this plugin's askpass, which only decides what `Asked by:` can
say (it compares against our own path, so it cannot misjudge a real setup).

`Asked by:` is decided as follows.

| Platform | Request from | Shown |
|---|---|---|
| Windows | a client the kernel reports as this plugin's `cc-askpass.exe` | its parent's executable path, e.g. `C:\Windows\System32\OpenSSH\ssh.exe` |
| Windows | a client the kernel reports as this plugin's `shim\ssh.exe` (relay) | `cc-askpass ssh wrapper → <host> (<real ssh path>)` |
| Windows | any other client | that client's executable path, plus the unverified warning |
| Linux/macOS | a helper pid whose `ps` args run this plugin's `bin/askpass` | the parent's executable from `bin/exe-of`, e.g. `/usr/bin/sudo` |
| Linux/macOS | that helper's parent running `bin/shim/ssh --relay <host>` | `cc-askpass ssh wrapper → <host>` |
| Linux/macOS | any other pid | `unknown program (unverified)`, plus the unverified warning |

The unverified warning: "This request did not come through cc-askpass's helper. Answer only
if you know which program is asking." The reply then goes where the request said it should
(the `reply.<pid>` FIFO on Linux, the pipe connection on Windows).

## 5. Windows architecture

### 5.1 Repository layout

```
win/cc-askpass.cs   C# source, one program, its mode chosen by name and arguments:
                      cc-askpass.exe serve <session id>   listener, started by the mod
                      cc-askpass.exe <prompt>             askpass, started by ssh/git
                      cc-askpass.exe --reply              the mod's way back to the listener
                      ssh.exe <ssh arguments>             ssh wrapper (§6)
win/build.ps1       compiles win/cc-askpass.cs into win/out/<hash>/cc-askpass.exe and copies
                    it to win/out/<hash>/shim/ssh.exe
hooks/core.ts       Asked-by logic, Windows request parsing, `;` PATH handling
hooks/register.tsx  platform branch
tests/win.ps1       Windows tests (§10)
```

`<hash>` is the 64-bit FNV-1a hash of `cc-askpass.cs` in hex, computed by the mod from the
source text (`$.fs.read`; the module has no crypto library). It only tells builds apart. `win/out/` is in
`.gitignore`: the repository holds no binaries.

### 5.2 Platform detection

Windows when `$.env.get('OS')` is `Windows_NT` (WSL has no `OS`). Everything below applies to
Windows only; Linux, macOS and WSL keep the existing paths, changed only by §4.

### 5.3 Session start (Windows)

Before `next(e)`, as on Linux, and only with a person at the prompt:

1. If `win/out/<hash>/cc-askpass.exe` does not exist (`$.fs.exists`), run
   `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive
   -ExecutionPolicy Bypass -File win\build.ps1 <source> <out dir>` (60 s timeout). It compiles
   with `Add-Type -TypeDefinition … -OutputAssembly … -OutputType ConsoleApplication`, writes
   to a temporary name of its own (`cc-askpass.<pid>.tmp.exe`) and renames, so a half-written
   exe is never used. Builds into one directory (sessions starting at once) take turns under a
   named mutex, and one that finds `cc-askpass.exe` already there is done; the mod also takes
   a failed (or timed-out) build as done when `cc-askpass.exe` exists afterwards. Under the
   mutex a build first deletes temporary exes a killed build left. It then removes other
   `win/out/*` directories, skipping files still locked by running processes; that clean-up
   never fails a finished build. Windows PowerShell 5.1 is always used, whatever the tools run.
2. Run the built `cc-askpass.exe` once, bare and with `CC_ASKPASS_PIPE` empty: a helper that
   runs exits 1 saying `CC_ASKPASS_PIPE is not set`. Anything else (AppLocker, WDAC or an
   antivirus blocking it) toasts `cc-askpass: could not run the Windows helper: <reason>` and
   stops here: nothing below is set, so ssh never meets a shim that cannot run.
3. Put `win\out\<hash>\shim` first on PATH (`;`-separated, once: a reload finds it there). It
   holds only `ssh.exe`, which PowerShell and native programs find for `ssh`. Git Bash's
   `/etc/profile` puts its own directories (`/usr/bin` among them) before the inherited PATH,
   so for bash the mod also sets the environment variable `BASH_FUNC_ssh%%` to
   `() {  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' '<shim ssh.exe, forward slashes>' "$@"\n}`
   (single quotes, a `'` in the path written `'\''`: `$` and backticks are legal in Windows
   user names and `CLAUDE_CONFIG_DIR`): every bash (the Bash tool, `bash -c`, `sh -c`, scripts)
   imports it as an `ssh` function. The two variables stop Git Bash from rewriting
   POSIX-looking arguments (`/etc/x`) into Windows paths on the way to a native program, which
   Git's own ssh would never see.
4. Start `cc-askpass.exe serve <session id>` with `$.process.spawn`.
5. On its ready line set `CC_ASKPASS_PIPE`, `SSH_ASKPASS` (the exe's path),
   `SSH_ASKPASS_REQUIRE=force` and `CC_ASKPASS_WRAP` (as on Linux). `SUDO_ASKPASS` and `DISPLAY`
   are not set.
6. When the listener never becomes ready or ends, the mod also takes the shim back off PATH
   and unsets `BASH_FUNC_ssh%%`. The PowerShell tool sees that at once; the Bash tool's shell
   snapshot keeps the function, whose wrapper passes through since `CC_ASKPASS_WRAP` is unset.

### 5.4 Listener (`serve`)

- Pipe `\\.\pipe\cc-askpass-<session id>-<Claude Code pid>` (the listener's parent), created
  with `FILE_FLAG_FIRST_PIPE_INSTANCE`, an ACL granting only the current user's SID, and
  unlimited instances; a second pipe of the same name plus `-reply` for replies. A restart
  (mod reload) reuses the names; creation retries for 5 s while the old listener's instances
  close, then fails.
- Prints `ready<TAB><pipe name><TAB><token><TAB><helper path>` (token: 32 hex digits from a
  CSPRNG) once both pipes exist. The helper path is the listener's own image
  (`QueryFullProcessImageNameW`), which the kernel gives with junctions and subst drives
  resolved, as it gives the clients' paths: the mod knows our helper and `<its dir>\shim\ssh.exe`
  by it (case- and slash-insensitive), not by the path it built under, and rejects a ready line
  without it. All output, stderr included, is UTF-8 with `\n`.
- For each connection on the request pipe: the client pid from `GetNamedPipeClientProcessId`;
  its executable (`QueryFullProcessImageNameW`); its parent pid (Toolhelp snapshot), the
  parent's executable and command line (`NtQueryInformationProcess`,
  `ProcessCommandLineInformation`); and the ancestors' pids and command lines up to the
  listener's parent, at most 16, for `Claude ran:`. It reads one request line (§5.6), assigns
  an id, and prints one JSON line:

  ```json
  {"id":7,"client":{"pid":1,"exe":"…"},"parent":{"pid":2,"exe":"…","args":"…"},
   "ancestors":[{"pid":3,"args":"…"}],"prompt":"…","relay":null}
  ```

  `relay` is `{"host","realSsh","remotePid","via","reported"}` for a relay line. The listener
  judges nothing.
- When a request connection closes before its reply (the asker gave up or was killed) it
  prints `{"gone":<id>}`, and the mod drops the request or closes its pane. This replaces the
  `kill -0` liveness checks of the Linux path, which need `sh`.
- On the reply pipe it reads `<token><TAB><id>\n<password>\n`; a wrong token or an unknown id
  closes the connection without effect. It writes `<password>\n` to the waiting request
  connection and closes it.

### 5.5 Askpass and reply

- Askpass (`cc-askpass.exe <prompt>`): fails with the base design's message when
  `CC_ASKPASS_PIPE` is unset or the pipe cannot be reached within 5 s. Sends the prompt (tabs
  and newlines as spaces, cut to 1000 bytes), waits for one line, prints it, exits 0; an empty
  line exits 1. If the connection breaks before a reply (listener restart) it reconnects and
  sends again; it gives up after 10 minutes, the Bash tool's longest timeout.
- Reply (`cc-askpass.exe --reply`): copies its stdin to the reply pipe. It is an option, not a
  word: ssh passes askpass the prompt as its one argument, and a server chooses the prompt
  (one that reads `reply` is an ordinary request). The mod runs it with
  `$.process.run(argv, { stdin })`: the engine's spawn takes input only at start, so the
  long-lived listener cannot receive it on stdin.

### 5.6 Request lines on the pipe

- From askpass: `<prompt>`.
- From the ssh wrapper: `relay<TAB><host><TAB><real ssh path><TAB><remote pid><TAB><prompt><TAB><via><TAB><reported>`,
  the last four as in A §4.6.

## 6. Windows remote (second connection)

Linux, macOS and WSL keep A's ControlMaster design. On Windows `shim\ssh.exe` does this:

1. **Find the real ssh**: the first `ssh.exe` on PATH (PATHEXT order) outside the shim
   directory. None: error on stderr, exit 255.
2. **Decide**: pass through (start the real ssh with the original arguments, wait, exit with
   its status) under A's §4.3 rules, ported to C#: `CC_ASKPASS_WRAP` not `1`, listener pipe
   unreachable, `SSH_ASKPASS` not this plugin's exe, no remote command, `-N -W -O -s -G -V -Q`,
   protocol commands, `excludeHosts`. A command whose base64 does not fit the 32,767-character
   command line passes through.
3. **Relay connection R**: the real ssh with the original options and host and A's §4.4
   one-line command shape (base64, plain words and a single-quoted eval, so fish works) running
   `remote.sh serve-stdin <token>`. R's stdin first carries one base64 line with `remote.sh`,
   `askpass` and the remote `ssh` wrapper: they cannot ride on the command line. `remote.sh`
   creates the 0700 token directory as in A, writes the files and the request FIFO, and prints
   `cc-askpass-ready <token dir>`. The wrapper waits up to 60 s for that line (the login
   password may be typed meanwhile); anything else first, R exiting, or the timeout means pass
   through.
4. **Command connection C**: the real ssh with the original arguments, the remote command
   replaced by `env CCAP_DIR=<token dir> CCAP_CMD_B64=<command> /bin/sh <token dir>/remote.sh
   run`, stdin, stdout and stderr inherited untouched. `run` exports A's variables and runs
   the command as A §4.4 step 4 does.
5. **Relay**: each line R prints (A §4.6 format) becomes a relay request on the local pipe;
   the answer goes back as `<remote pid><TAB><password>\n` on R's stdin, which `remote.sh`
   writes into `<token dir>/reply.<remote pid>`. The wrapper is R's only stdin writer.
6. **End**: when C exits, the wrapper closes R's stdin; `remote.sh` removes the token
   directory and exits. The wrapper exits with C's status.
7. **Interrupts**: R and C run in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so
   killing the wrapper (Bash tool timeout, Ctrl+C) ends both; the remote trap cleans up on
   hang-up as in A. A pass-through ssh runs in the same job, as `exec` leaves no wrapper
   behind on Linux (a killed `ssh -N -L` frees its port), except when it forks (`-f`,
   `-o ForkAfterAuthentication=yes`) and must outlive the wrapper. When a pass-through ssh
   ends by itself the wrapper lifts the kill-on-close limit first, so what ssh left in the
   background (a ControlPersist master, a config's ForkAfterAuthentication) keeps running. A
   job that cannot be set up warns only when the wrapper relays; a pass-through is then plain ssh.

Arguments reach the real ssh through a command line built with the standard Windows quoting
rules, every argument quoted: .NET Framework 4.8 has no `ArgumentList`, and Git's ssh (a
Cygwin program) expands unquoted wildcards when started from a native process.

A login by password is asked twice per command (R and C); key and agent logins notice
nothing. This was chosen over a single connection with `-R` forwarding, which needs a socket
client on the host (perl, python3, socat, `nc -U` or bash) that minimal hosts lack.

`remote.sh` gains the `serve-stdin` and `run` modes; its relay, cleanup and the remote `sudo`
and `ssh` wrappers are A's (the hosts are POSIX).

## 7. Pane

As today, plus `Asked by:` under the heading, before `Claude ran:`, on every platform.
`Claude ran:` on Windows: a Bash tool command is matched against the ancestors' command lines
as on Linux. A PowerShell tool command is on no command line (§3), so when an ancestor runs
the PowerShell tool's launcher (`$__claudeCodeScript`) and exactly one PowerShell tool call is
in progress (the mod tracks calls from `tool.call` until `next` resolves), that call's command
is shown; otherwise `Claude ran:` is left out for a local request and shows `(unknown)` for a
remote one, as today. The system prompt note on Windows covers ssh
only (no local sudo).

## 8. Error handling (Windows)

| Situation | Behaviour |
|---|---|
| Build fails (`Add-Type` blocked, no .NET Framework 4.8, ExecutionPolicy forced by policy) | Toast `cc-askpass: could not build the Windows helper: <reason>`; the mod stays off; Claude's commands behave as without it |
| The built exe cannot run (AppLocker, WDAC, Defender) | Found by running it once before PATH and `BASH_FUNC_ssh%%` are touched (§5.3 step 2): toast `cc-askpass: could not run the Windows helper: <reason>`, nothing set, no listener; Claude's commands behave as without the mod |
| Pipe name taken by another process | The listener fails: toast, mod off, the shim taken back off PATH and `BASH_FUNC_ssh%%` unset |
| Listener ends mid-session | `SSH_ASKPASS` and `CC_ASKPASS_WRAP` unset, the shim taken back off PATH and `BASH_FUNC_ssh%%` unset (or put back to the person's own exported `ssh` function, if one was there); a wrapper still reached (the Bash tool's snapshot keeps the function) passes through |
| `session.start` again in one load | The old listener and everything it set end first, so its late end cannot take back the new shim |
| Sessions build the same helper at once | Builds take turns; each ends with a working exe |
| Pass-through ssh when the wrapper is killed | Ends with it (a job object, as `exec` on Linux), unless it forks (`-f`, `-o ForkAfterAuthentication=yes`) |
| Askpass cannot reach the pipe (mod disabled) | Message on stderr, exit 1; ssh behaves as without askpass |
| No real ssh after the shim | Error on stderr, exit 255 |
| Non-ASCII paths, names, prompts | UTF-16 arguments and pipes; UTF-8 output to the mod; `\r\n` tolerated |
| Several sessions | Pipe names carry the session id and Claude Code's pid |
| Plugin updated while an old helper runs | Old `win/out` directories are removed when no longer locked |
| R gets no ready line in 60 s | Pass through; the command may ask for the login password again |

## 9. Security boundaries

- Any program running as the user can raise a pane, on every platform, including scripts
  Claude runs. The person decides from `Asked by:` and `Claude ran:`; the README says to answer
  only when both are what they expect (sudo or ssh, for a command they recognise). This replaces
  A §8's residual-risk paragraph: what A accepted for relays now holds for every request.
- On Linux and macOS `Asked by:` rests on the pid the helper reports: a process running as the
  user that waits for a real sudo prompt and races it can be shown as that sudo. On Windows the
  kernel gives the pid. The README states both.
- The password travels only through stdin, pipes, FIFOs and R's stdin: never an argument, a
  file, an environment variable, a log line, a toast or the model's context.
- Windows pipes: current user only, first instance, token-checked replies.
- No component runs anything through `cmd.exe`; askpass is an `.exe` (§3).

## 10. Testing

- `hooks/core.test.ts`: `Asked by:` for each row of §4's table; Windows JSON request parsing;
  `withShim` with `;`; removed trust tests deleted.
- `hooks/lifecycle.test.ts`: with `OS=Windows_NT`, the build runs only when the exe is
  missing; PATH, environment and listener argv; a failed build or a helper that cannot run
  toasts and sets nothing; a listener that never becomes ready or ends takes the shim back off
  PATH and out of bash; PowerShell tool commands are recorded.
- `hooks/pane.test.ts`: the `Asked by:` line and the unverified warning.
- `tests/win.ps1` (Windows): build; listener plus both ssh-keygens with an encrypted key; a
  prompt with `"&%^!` arrives intact; a wrong reply token is ignored; askpass reconnects after a
  listener restart; the wrapper's wrap/pass-through decisions (A's `tests/ssh.sh` table);
  parallel builds; UTF-8 error text; a listener started through a junction; a killed
  pass-through wrapper ends its ssh unless it forks.
- `tests/ssh.sh`, `tests/askpass.sh`: follow §4 (no remote `verify`, no `exe-of` payload).
- CI: `windows-latest` joins the matrix (validate, plugin test, `tests/win.ps1`). Windows
  runners cannot run a POSIX sshd for the remote tests, so remote end-to-end runs by hand.
- Manual end-to-end on Windows with a user-run sshd in WSL: Bash and PowerShell tools ×
  passphrase, password login, remote sudo, a further hop; `Asked by:` wording; Ctrl+C clean-up;
  mod reload.

## 11. Verified before building (2026-10-08)

- PATH set at session start reaches the PowerShell tool first after pwsh's own directory:
  `ssh` resolves to the shim. In the Bash tool it does not come first: Git Bash's
  `/etc/profile` puts `/c/Users/<user>/bin`, `/mingw64/bin`, `/usr/local/bin`, `/usr/bin` ahead
  of it, so `/usr/bin/ssh` wins. An exported function through `BASH_FUNC_ssh%%` set at session
  start reaches the Bash tool, `bash -c`, `sh -c` and bash scripts (§5.3).
- Native programs started from Git Bash get POSIX-looking arguments rewritten
  (`/etc/init.d/x` → `C:/Program Files/Git/etc/init.d/x`); `MSYS_NO_PATHCONV=1` and
  `MSYS2_ARG_CONV_EXCL='*'` stop it.
- Git's ssh started from a native process expands unquoted wildcards (`*` became a file name
  in the working directory); quoted arguments arrive intact (`"*"`, `"a*b"`, `"a\"b"`).
- ARM64: no hardware at hand; untested.

## 12. Changes to earlier designs

- Base design: request verification becomes §4 of this document.
- A §4.3 step 3 (root-owned real ssh), §4.5's last bullet (remote verification), §5.1
  (relay verification) and §8's residual-risk paragraph are replaced by §4 and §9 here.
