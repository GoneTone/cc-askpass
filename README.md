# cc-askpass

English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

Claude Code's Bash tool runs commands without a terminal, so when one of them needs your sudo password, sudo gives up:

```
sudo: a terminal is required to read the password; either use the -S option ...
```

cc-askpass is a Claude Code mod that answers those prompts with a password pane inside Claude Code. The password goes straight to sudo and never enters the model's context.

It covers sudo (including sudo called from scripts and installers), ssh key passphrases, and git credentials over HTTPS.

## Requirements

- Claude Code 2.1.289 or later
- Linux, WSL or macOS (tested on macOS 14 and 26). Native Windows is not supported.

## Install

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

Then restart Claude Code or run `/reload-plugins`. There is nothing to configure.

## Usage

Ask Claude to run anything that needs sudo. A **sudo password** pane opens and shows the whole command that will run as root (for example `$ sudo apt update`). When sudo was called from something else Claude ran, such as `./install.sh` or `curl … | bash`, a `Claude ran:` line shows that command too. Type the password and press Enter.

- **Show/Hide** reveals what you typed. Input is masked for sudo, and for every other prompt except git's `Username for '...'` and ssh's `(yes/no)` host-key question.
- **Cancel** or Esc answers nothing; sudo stops with "no password was provided".
- A wrong password asks again with "Sorry, try again".
- If you were typing in the prompt (or a dialog was open) when the pane appeared, the pane cannot take the keyboard. It then says in red: click it (or press ctrl+x tab; outside fullscreen mode only the keys work) before typing, so your password does not end up in the prompt and get sent to Claude.
- Claude Code decides where the pane goes: beside the transcript in fullscreen mode at 110 columns or more, otherwise above the prompt.
- If the terminal is narrower than 144 columns the pane may not open on its own. A line above the prompt then says `sudo is waiting for a password — click the button below or type /askpass`, with an **Open password prompt** button under it. Click the button or type `/askpass`; both work while Claude is busy. Outside fullscreen mode the terminal reports no clicks, so the line says to press ctrl+x tab (which puts the keyboard on the button) then Enter, or type `/askpass`.

## Ask once instead of every time

Every Bash command Claude runs is a new process, so sudo asks for the password every time. cc-askpass does not cache passwords: a cached password could be read by any process running as you. To have sudo remember that you authenticated instead, run `sudo visudo -f /etc/sudoers.d/cc-askpass` and add:

```
Defaults:YOUR_USER timestamp_type=global
```

sudo then shares one timestamp across all your terminals and Claude Code sessions for its usual timeout (15 minutes by default), and cc-askpass asks once per timeout.

## How it works

```
Claude's Bash command → sudo → bin/askpass → request FIFO → cc-askpass mod → pane
                                     ↑                                          │
                                     └──────────── reply FIFO ←─────────────────┘
```

When a session starts, the mod starts a small listener (`bin/askpass --serve`) and sets these variables for the commands Claude runs: `SUDO_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`, `CC_ASKPASS_DIR`, and `DISPLAY=:0` if `DISPLAY` was unset (sudo only uses askpass when `DISPLAY` is set; `CC_ASKPASS_SET_DISPLAY=1` marks that the mod set it). sudo then runs `bin/askpass`, which hands the prompt to the mod through a FIFO in `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/` (mode 0700). The mod checks with `ps` that the request really comes from `bin/askpass`, shows the pane, and writes your answer into that helper's own FIFO. While the listener runs, the mod also adds a short note to Claude's system prompt saying sudo can ask for a password, so Claude runs `sudo` instead of `sudo -n` or asking you to run it yourself.

## Security

- The password is never written to the model's context, logs, toasts, the status line, command-line arguments, or files.
- Requests are accepted only from `bin/askpass` started by sudo running as root, or by root-owned `ssh`, `ssh-add`, `scp`, `sftp` or `git-remote-http(s)` (git's HTTPS helper) binaries. Anything else, such as a command running `$SUDO_ASKPASS` itself to read your answer, is rejected.
- The pane shows the real command that asked. Check it before you answer: an `ssh` or `git` command sends your answer to the server it names.
- Limitation: a malicious process running as your own user can race to read the reply to a genuine request. cc-askpass keeps the password out of the model's context in normal use; it is not a sandbox against hostile code running as you.

## Limitations

- `su` and `doas` cannot use askpass. Use sudo.
- polkit (`pkexec`, `run0`, `systemctl` as a normal user) fails with "Interactive authentication required" instead of asking.
- Yes/no prompts are not handled. Use flags such as `-y` or `--no-interaction`.
- Masked input tracks typing anywhere in the field, but a character deleted in the middle counts as deleted at the end. If you edit in the middle, press Show to check, or clear the field and type again.
- On hosts without a display, the `DISPLAY=:0` placeholder may make a few graphical programs (for example `xdg-open`) try to reach an X server and fail.
- The mobile app (and Remote Control from a phone) cannot show an input field; answer from the terminal or the desktop app.
- In non-interactive runs (`claude -p`, the SDK) the mod does nothing, since nobody could answer; sudo fails as it would without it.
- With the Bash sandbox on, sudo cannot raise privileges and the helper cannot see the listener, so it fails at once with "the cc-askpass listener is not running".
- ssh confirmation prompts (`SSH_ASKPASS_PROMPT=confirm`) appear as a plain text prompt.

## Uninstall

```sh
claude plugin uninstall cc-askpass
```

If you added the sudoers file, remove it with `sudo rm /etc/sudoers.d/cc-askpass`.

## Development

```sh
sh tests/askpass.sh                            # helper tests (Linux, WSL, macOS)
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # run Claude Code with this checkout
npx -p typescript tsc -p .                     # type-check (after one --plugin-dir run)
```

## License

[MIT](LICENSE)
