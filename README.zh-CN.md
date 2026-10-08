# cc-askpass

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文

**让 Claude 直接运行需要 sudo 的命令，不用再把命令复制到自己的终端执行。**

Claude 执行的命令需要密码时（`sudo apt install`、会调用 sudo 的安装脚本、通过 HTTPS 的 `git push`、带口令的 ssh 密钥），cc-askpass 会在 Claude Code 里弹出密码面板。你在面板里输入密码，密码会直接交给发起请求的程序，不会进入模型、对话记录或任何日志。

没有它的话，Claude 的 Bash 工具没有终端，sudo 会直接失败：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

结果只好把命令复制到自己的终端执行，再把结果告诉 Claude。其他变通方法风险更高：把密码粘贴到对话里让 Claude 用 `sudo -S`，密码就进了模型的 context；在 sudoers 里配置 `NOPASSWD`，则任何程序都能不经询问就以 root 运行。

- **无需配置。** 装好之后，sudo、ssh 和 git 需要密码时就会直接询问你。
- **密码不经过模型。** 密码从面板在 Linux 和 macOS 上经由私有的 FIFO、在 Windows 上经由私有的命名管道（named pipe）送到发起请求的进程，不会出现在模型的 context、日志、命令行或任何文件里。
- **看得到你在批准什么。** 面板会显示将以 root 执行的完整命令，以及 Claude 为此执行了哪条命令。
- **看得到是谁在问。** 每个请求都会显示，不会被默默拒绝。面板会标出发起请求的程序（`Asked by:`）和 Claude 执行的命令（`Claude ran:`），由你决定。

## 要求

- Claude Code 2.1.289 及以上
- Linux、WSL、macOS（已在 macOS 14 和 26 测试）或 Windows。在 Windows 上，Git for Windows 不是必需的：没有它时，Claude Code 只使用 PowerShell 工具。mod 两个工具都支持。见 [Windows](#windows)。

## 安装

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

然后重启 Claude Code，或运行 `/reload-plugins`。无需任何配置。

## 使用方法

让 Claude 执行任何需要 sudo 的命令，就会弹出 **sudo password** 面板，并完整显示将以 root 执行的命令（例如 `$ sudo apt update`）。如果 sudo 是由 Claude 执行的其他东西间接调用的，例如 `./install.sh` 或 `curl … | bash`，还会多一行 `Claude ran:` 显示那个命令。标题下方的 `Asked by:` 一行会标出发起请求的程序。只有在 `Asked by:` 和 `Claude ran:` 都符合你的预期时才回答。输入密码后按 Enter。

- **Show/Hide** 可以显示你输入的内容。sudo 一律遮盖；其他提示也默认遮盖，只有 git 的 `Username for '...'` 和 ssh 首次连接的 `(yes/no)` 确认例外。
- **Cancel** 或 Esc 表示不回答，sudo 会显示“no password was provided”并退出。
- 密码输错时会再问一次，并提示“Sorry, try again”。
- 如果面板出现时你正在输入框里打字（或有对话框打开），面板就拿不到键盘。这时它会用红字提示：先点一下面板（或按 ctrl+x tab；非全屏模式只能用按键）再输入，以免密码打进输入框、被当成消息发给 Claude。
- 面板出现在哪里由 Claude Code 决定：全屏模式且宽度 110 列及以上时停靠在对话记录旁边，其他情况出现在提示栏上方。
- 终端宽度不足 144 列时，面板可能不会自动弹出，此时提示栏上方会显示 `sudo is waiting for a password — click the button below or type /askpass`，下方有一个 **Open password prompt** 按钮。点击按钮或输入 `/askpass` 即可打开，Claude 运行中也能用。非全屏模式下终端不支持鼠标点击，这行提示会改为请你按 ctrl+x tab（键盘会移到按钮上）再按 Enter，或输入 `/askpass`。

### 远程主机

通过 ssh 连到其他主机时，那里的密码提示也会用同一个面板：

- `ssh host sudo apt update`，以及远程脚本里的 sudo（`ssh host ./deploy.sh`）。
- 再往下跳：从远程主机再 `ssh` 到第三台。
- rsync、ansible 和会调用 ssh 的脚本。带有 `-S` 或 `-n` 的远程 sudo（例如 ansible 的 become）则原样放行，不会出现在面板上。

无法参与的主机会被自动检测并原样放行，ssh 的行为和没装 cc-askpass 时一样：git 托管服务（`git@github.com`）、网络设备、设有 forced command 的账号、Windows sshd，以及没有 `/bin/sh` 的主机。

面板会标出主机名（`sudo on server needs your password`），在 `$` 那行后面加上 `(reported by server)`，而且远程提示一律显示 `Claude ran:` 那行，外加一条警告，请你回答前先确认。

调用方自己指定的 `ControlPath` 或 `-S` 不会被沿用，所以像 ansible 这类工具会多开一条连接。你自己 `~/.ssh/config` 里的 `ControlMaster`/`ControlPersist` 也不会被沿用：经 cc-askpass 处理的每个 ssh 命令都会开自己的连接，所以需要密码或双因素认证才能登录的主机，每个命令都会再问一次；这类主机请加到 `excludeHosts`。每个这样的命令还会在主机上多启动几个登录 shell（检查、转发、每次回答各一个）。

有两个选项，可在 `/config` 或配置文件里设置：

- `remoteHosts`（默认开启）：回答远程主机的提示。要关闭，请设置 `"pluginConfigs": { "cc-askpass": { "options": { "remoteHosts": false } } }`。
- `excludeHosts`：按主机名匹配的 glob 模式；ssh 到匹配的主机时一律不处理。

## 一段时间内只问一次

Claude 执行的每个 Bash 命令都是新的进程，所以 sudo 每次都会再问密码。cc-askpass 不会缓存密码，因为以你的身份运行的任何程序都可能读到缓存的密码。如果想让 sudo 记住“已经验证过”，请运行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 并加入：

```
Defaults:你的用户名 timestamp_type=global
```

这样 sudo 会在所有终端和 Claude Code 会话之间共享同一个时间戳，有效期是 sudo 原本的超时时间（默认 15 分钟），cc-askpass 在这段时间内只会问一次。

## 工作原理

```
Claude 的 Bash 命令 → sudo → bin/askpass → 请求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回复 FIFO ←──────────────┘
```

会话开始时，mod 会启动一个小型监听程序（`bin/askpass --serve`），并为 Claude 执行的命令设置这些环境变量：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本未设置时补上 `DISPLAY=:0`（sudo 只有在设置了 `DISPLAY` 时才会使用 askpass；`CC_ASKPASS_SET_DISPLAY=1` 标记这是 mod 设置的）。sudo 接着运行 `bin/askpass`，它通过 `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/`（权限 0700）里的 FIFO 把提示交给 mod。mod 用 `ps` 查出是哪个程序启动了 helper，弹出面板并把该程序显示在 `Asked by:` 那行，再把你的回答写进该 helper 专属的 FIFO。监听程序运行期间，mod 还会在 Claude 的 system prompt 里加一段说明，告诉它 sudo 可以询问密码，所以 Claude 会直接执行 `sudo`，而不是改用 `sudo -n` 或让你自己执行。

对 ssh，mod 还会在 Claude 执行的命令的 PATH 最前面放一个小型 `ssh` 包装程序。它用私有的连接启动真正的 ssh，检查该主机能否参与，并建立一条转发通道，让那里出现的提示（远程主机上的 sudo，或再往下一跳的 ssh）经由同一个 FIFO 回到面板。没通过检查的主机会和没装时一样照常运行。

## Windows

在 Windows 上，mod 没有 shell helper。第一次启动会话时（以及插件更新后），它会用 Windows 10 和 11 自带的 .NET Framework，从 `win/` 里的 C# 源码构建自己的 helper。不会下载或附带任何二进制文件。构建结果放在 `win/out/`，需要一点时间；之后启动会直接沿用。

- helper 是一个 `.exe`：mod 把它当监听程序启动，ssh 和 git 则把它当 askpass 程序运行，它通过只有你的用户能打开的命名管道（named pipe）和 mod 通信。
- 两个工具都支持：Bash 工具里 Git for Windows 的 ssh，以及 PowerShell 工具里的 Windows OpenSSH。ssh 密钥的口令、ssh 密码登录、通过 HTTPS 或 ssh 的 git，以及远程主机上的 sudo，都会在面板里询问。Windows 上没有本机 sudo，所以不处理 `sudo.exe` 和 UAC。
- 禁止 `Add-Type` 或未签名程序的机器（AppLocker、WDAC、强制的执行策略）上，mod 会保持关闭。toast 会说明原因，Claude 的命令则和没装 mod 时一样。
- 远程主机：Windows 的 ssh 无法共享连接，所以被包装的 `ssh host …` 会开两条连接，一条处理提示，一条执行命令。以密码登录时，每个命令会问两次；用密钥或 agent 登录则感觉不到差别。

## 安全性

- 密码不会写入模型的 context、日志、toast、状态栏、命令行参数或任何文件。
- 每个请求都会显示，不会因为来源而被拒绝。你根据两行判断：`Asked by:` 是发起请求的程序（操作系统能回答时就用它的答案），`Claude ran:` 是 Claude 执行的命令。只有在两者都符合预期时才回答，例如你认得的命令所调用的 sudo 或 ssh。`ssh` 或 `git` 命令会把你的回答发送到它指定的服务器。
- 任何以你的身份运行的程序都能弹出面板，包括 Claude 执行的脚本，而且你一回答，它就能获取你输入的内容。cc-askpass 的目标是正常使用时不让密码进入模型的 context，它不是防范你的身份下恶意程序的沙箱。
- 在 Linux 和 macOS 上，`Asked by:` 依据 helper 上报的 pid。等着真正的 sudo 提示并抢先发出请求的程序，有可能被显示成那个 sudo。在 Windows 上，pid 由内核上报。
- 没有经过 cc-askpass helper 的请求，面板会标示为未验证（unverified）。
- 远程提示会标出主机名。在指名其他主机的面板里，输入的要是那台远程主机的密码（绝不是本机的密码）。把 `remoteHosts` 设为 `false` 即可关闭这项功能。

## 限制

- `su` 和 `doas` 不支持 askpass，请改用 sudo。
- polkit（`pkexec`、`run0`、以普通用户运行 `systemctl`）会直接报错“Interactive authentication required”而不会询问。
- 不处理 y/n 之类的提问，请使用 `-y`、`--no-interaction` 等参数。
- 遮盖输入可以在输入框任何位置输入，但在中间删除的字符会被当成删掉末尾的字符。如果在中间编辑过，请按 Show 确认，或清空后重新输入。
- 在没有图形界面的主机上，`DISPLAY=:0` 这个占位值可能让少数图形程序（例如 `xdg-open`）尝试连接 X server 而失败。
- 移动端 app（以及从手机使用 Remote Control）无法显示输入框，请改在终端或桌面版 app 回答。
- 非交互模式（`claude -p`、SDK）下没有人能回答，mod 不会启动，sudo 会和没装 mod 时一样直接失败。
- 开启 Bash 沙箱时，sudo 无法提权，helper 也看不到监听程序，会立即以“the cc-askpass listener is not running”失败。
- ssh 的确认提示（`SSH_ASKPASS_PROMPT=confirm`）会以普通文本输入的形式出现。
- 以 Windows sshd 作为远程主机时原样放行（没有远程提示）。
- Windows：不处理 `sudo.exe` 和 UAC 提示；自己会弹窗的程序（Git Credential Manager、Pageant）照旧用自己的窗口。
- 在 `ssh -t` 下以绝对路径调用 `/usr/bin/sudo` 时，它会直接读取终端而不是询问。
- 远程主机的登录配置文件（rc 文件）如果向 stdout 输出内容，检查会失败，命令照常运行，没有远程提示。
- ssh 的选项值或主机名含有空格时（`-o "User alice"`），该命令没有远程提示；请改写成 `-o User=alice`。
- Claude 的 Bash 命令运行时，PATH 最前面是 `…/bin/shim`（在会话开始时设置，不会改动命令本身）。里面只有 ssh 包装程序，`remoteHosts` 关闭时它会直接放行。

## 卸载

```sh
claude plugin uninstall cc-askpass
```

如果你添加了 sudoers 配置文件，请用 `sudo rm /etc/sudoers.d/cc-askpass` 删除。

## 开发

```sh
sh tests/askpass.sh                            # helper 测试（Linux、WSL、macOS）
sh tests/ssh.sh                                # ssh 包装程序测试（Linux、WSL、macOS）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1   # Windows 测试
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用这份源码启动 Claude Code
npx -p typescript tsc -p .                     # 类型检查（先用 --plugin-dir 加载过一次）
```

## 许可证

[MIT](LICENSE)
