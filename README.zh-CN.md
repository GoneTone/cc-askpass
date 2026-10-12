# cc-askpass

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文

**一个 Claude Code Mod，让 Claude 直接运行需要 sudo 的命令，不用再把命令复制到自己的终端执行。**

Claude 执行的命令需要密码时（`sudo apt install`、会调用 sudo 的安装脚本、通过 HTTPS 的 `git push`、ssh 密钥的口令），cc-askpass 会在 Claude Code 里弹出密码面板让你可以输入密码。密码会直接交给发起请求的程序，不会进入模型、对话记录或任何日志。

https://github.com/user-attachments/assets/bbb11cc1-cbfb-4b46-ba88-23fbf1ab6254

没有它的话，Claude 的 Bash 工具没有终端，sudo 会直接失败：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

结果只好自己到终端执行。把密码粘贴到对话里，或在 sudoers 里配置 `NOPASSWD` 也能绕过，但两者风险都更高。

- **无需配置。** 装好之后，sudo、ssh 和 git 需要密码时就会在面板里询问你。
- **密码不经过模型。** 密码不会出现在模型的 context、日志、命令行或任何文件里。
- **看得到你在批准什么。** 面板会显示将以 root 执行的命令、发起请求的程序，以及 Claude 执行的命令。

## 安装

需要 Claude Code 2.1.286 及以上，支持 Linux、WSL、macOS 和 Windows。在 Claude Code 里运行：

```
/plugin marketplace add GoneTone/cc-askpass
/plugin install cc-askpass@cc-askpass
```

`/plugin install` 会询问安装范围并列出选项，用默认值即可。然后重启 Claude Code，或运行 `/reload-plugins`。

## 使用方法

Claude 执行的命令要求密码时，就会弹出面板。`$` 那行显示发起请求的命令；如果是 sudo，就是将以 root 执行的命令（例如 `$ sudo apt update`）。`Asked by:` 标出发起请求的程序；如果提示是由 Claude 执行的其他东西间接触发的（例如 `./install.sh`），`Claude ran:` 会显示那条命令。确认这些都符合预期再回答：输入密码后按 Enter。

- `Claude ran:` 或 `$` 那行太长被截断时会出现 **Show full command**，按下后两行都会完整显示；按 **Show less** 再收起。
- **Show/Hide** 切换是否显示你输入的内容。
- 按 **Cancel** 或 Esc 就是不回答，sudo 会直接退出。
- 密码输错时，sudo 会再问一次。

<details>
<summary><b>面板没弹出来，或输入打不进去</b></summary>

- 如果面板出现时你正在输入框里打字（或有对话框打开），按键仍然会送到输入框。这时面板会用红字提醒你：先把键盘切到面板再输入，以免密码打进输入框、被当成消息发给 Claude。切换方法是点一下面板，或按 ctrl+x tab（非 fullscreen 模式下点击无效，只能用按键）。
- 终端宽度不足 144 列时，面板可能不会自动弹出，此时提示栏上方会显示一行提示，例如 `sudo is waiting for a password`，并附上 **Open password prompt** 按钮。点击按钮或输入 `/askpass` 即可打开，Claude 运行中也能用。非 fullscreen 模式下请改按 ctrl+x tab 再按 Enter。
- 输入内容默认会遮住，只有 git 的 `Username for '...'` 和 ssh 的 `(yes/no)` 主机密钥确认例外。

</details>

<details>
<summary><b>远程主机（ssh）</b></summary>

通过 ssh 连到的主机，密码提示也会用同一个面板：`ssh host sudo apt update`、远程脚本里的 sudo（`ssh host ./deploy.sh`）、从那台主机再 ssh 到其他主机，以及 rsync、ansible 或会调用 ssh 的脚本。带有 `-S`（从标准输入读密码）或 `-n`（不询问）的远程 sudo，例如 ansible 的 become，不会使用面板。

面板会标出主机名（`sudo on server needs your password`），并在 `$` 那行后面加上 `(reported by server)`，表示这条命令是远程主机上报的，本机无法核实。面板也一律会显示 `Claude ran:`，并提醒你先确认。这里要输入的是那台远程主机的密码，不要输入本机的密码。

有些主机无法把提示传回来：网络设备、设有 forced command 的账号、Windows sshd，以及没有 `/bin/sh` 的主机。cc-askpass 会自动识别，命令仍会照常执行，只是这些主机上的提示不会出现在面板。通过 ssh 的 git 操作（例如 `git push` 到 `git@github.com`）则完全不会经过 cc-askpass。

经 cc-askpass 处理的每个 ssh 命令都会各自新开一条连接，不会沿用你在 `~/.ssh/config` 里用 `ControlMaster`/`ControlPersist` 配置的共享连接，也不会沿用调用方自己的 `ControlPath` 或 `-S`（所以像 ansible 这类工具，每条命令都会多开一条连接）。因此，如果登录某台主机需要密码或双因素验证码，每个命令都会再问你一次。想避免的话，把这台主机加到 `excludeHosts`：ssh 到这台主机时会按你原本的参数运行，你自己的共享连接也会恢复作用，但这台主机上的 sudo 提示就不会出现在面板了。每个经过处理的命令还会在主机上多启动几个登录 shell。

有两个相关选项，可以在 Claude Code 里用 `/plugin configure cc-askpass@cc-askpass` 设置，或直接写在配置文件里：

- `remoteHosts`（默认开启）：在面板显示远程主机的密码提示。要关闭，请设置 `"pluginConfigs": { "cc-askpass@cc-askpass": { "options": { "remoteHosts": false } } }`。
- `excludeHosts`：匹配主机名的 glob 模式。ssh 到匹配的主机时，cc-askpass 不会介入。

</details>

<details>
<summary><b>一段时间内只问一次</b></summary>

Claude 执行的每个命令都是新的进程，所以 sudo 每次都会再问。cc-askpass 不会缓存密码，因为缓存的密码可能被你账号下的任何程序读走。你可以改让 sudo 记住你已经输入过密码：运行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 并加入：

```
Defaults:你的用户名 timestamp_type=global, timestamp_timeout=5
```

这样 sudo 会在所有终端和 Claude Code 会话之间共享同一个时间戳，5 分钟后才会再问。

**这会削弱 cc-askpass 提供的保护。** 在时间戳失效之前：

- Claude 执行 sudo 时不会弹出面板，你就看不到、也无法逐一批准以 root 执行的命令。
- 你账号下的其他程序，在任何终端里执行 sudo 也都不需要密码。

能接受这些代价再开启。时间请设短一点，用完后运行 `sudo -k` 就能立即让它失效。如果没有设置 `timestamp_timeout`，sudo 会用它的默认值：5 分钟，部分发行版（例如 Ubuntu）是 15 分钟。

</details>

<details>
<summary><b>Windows</b></summary>

- 不一定要装 Git for Windows：没装的话，Claude Code 只会用 PowerShell 工具。两种工具 cc-askpass 都支持：Bash 工具里 Git for Windows 的 ssh，以及 PowerShell 工具里的 Windows OpenSSH。
- ssh 密钥的口令、ssh 密码登录、通过 HTTPS 或 ssh 的 git，以及远程主机上的 sudo，都会使用面板。Windows 自带的 `sudo.exe` 和 UAC 提示不在处理范围，它们会显示 Windows 本身的对话框。
- 第一次启动会话时（以及插件更新后），cc-askpass 会用 Windows 10 和 11 自带的 .NET Framework，从 `win/` 里的 C# 源码构建它的 helper 程序。不会下载或附带任何二进制文件。构建结果放在 `win/out/`，需要一点时间。
- 如果机器阻止了 `Add-Type` 或未签名的程序（AppLocker、WDAC、强制的执行策略），cc-askpass 就不会启用，并用 toast 说明原因。
- 远程主机：Windows 的 ssh 无法共享连接，所以 `ssh host …` 会开两条连接，一条处理提示，一条执行命令。因此用密码登录，或使用有口令但没有 agent 的密钥时，每个命令会问两次；用 agent 或没有口令的密钥登录则感觉不到差别。

</details>

<details>
<summary><b>安全性</b></summary>

- 密码不会写入模型的 context、日志、toast、状态栏、命令行参数或任何文件。
- 你账号下运行的任何程序都能弹出面板，包括 Claude 执行的脚本；你一回答，它就会拿到你输入的内容。cc-askpass 能在正常使用时让密码不经过模型，但它不是沙箱，挡不住在你账号下运行的恶意程序。
- `Asked by:` 尽可能采用操作系统提供的信息。在 Linux 和 macOS 上，它依据 cc-askpass helper 上报的进程 ID（pid），所以恰好趁真正的 sudo 提示出现时发出请求的程序，有可能被显示成那个 sudo。在 Windows 上，pid 由内核上报。
- 没有经过 cc-askpass helper 的请求，会标示为未验证（unverified）。
- 回答 `ssh` 或 `git` 的提示时，密码会发送到该命令指定的服务器。

</details>

<details>
<summary><b>限制</b></summary>

- `su` 和 `doas` 不支持 askpass，请改用 sudo。
- polkit（`pkexec`、`run0`、以普通用户执行 `systemctl`）会直接失败而不会询问：`systemctl` 显示“Interactive authentication required”，`pkexec` 显示“Error creating textual authentication agent”。
- 程序自己询问的 y/n 问题（例如 apt 的 `Do you want to continue? [Y/n]`）不会处理，请使用 `-y`、`--no-interaction` 等参数。
- 输入内容被遮住时，在中间删除一个字符，实际被删掉的会是最后一个字符。如果在中间编辑过，请按 Show 确认，或清空后重新输入。
- 在没有图形界面的主机上，cc-askpass 设置的占位值 `DISPLAY=:0` 可能让图形程序去连接不存在的 X server 而失败。
- 移动版 app（以及从手机使用 Remote Control）无法显示输入框，请改在终端或桌面版 app 回答。
- 非交互模式（`claude -p`、SDK）下没有人能回答，cc-askpass 不会启动，sudo 会和没装时一样直接失败。
- 开启 Bash 沙箱时，sudo 无法在沙箱内运行，会立即失败（Linux 上显示“The "no new privileges" flag is set, which prevents sudo from running as root”，macOS 上显示“operation not permitted: sudo”）。如果你允许 Claude 在沙箱外运行该命令，面板就会照常询问。
- ssh 的确认提示（`SSH_ASKPASS_PROMPT=confirm`）会以普通文本输入的形式出现。
- Windows：自己会弹出密码窗口的程序（Git Credential Manager、Pageant）照旧用自己的窗口。关掉 Git Credential Manager 的窗口后，git 会改在面板里询问。
- 在远程主机上以完整路径调用 sudo（例如 `/usr/bin/sudo`）时不会使用面板：没有终端时会直接失败，在 `ssh -t` 下则会读取终端。请直接写 `sudo`。
- 如果远程主机的 shell 启动文件（例如 `.bashrc`、`.zshenv`）在执行命令时会打印文字，比如欢迎信息，cc-askpass 就无法确认这台主机是否适用。命令仍会照常执行，但那台主机上的 sudo 不会出现在面板。解决方法是让那段文字只在交互式 shell 中打印，或改为输出到 stderr。
- ssh 命令中，主机名之前的选项或主机名本身如果含有空格，例如 `-o "User alice"` 或 `-i "/keys/my key"`，cc-askpass 就不会处理这条 ssh 命令，远程主机上的 sudo 也就不会出现在面板。`-o` 选项可以改写成不含空格的 `-o User=alice`。

</details>

<details>
<summary><b>工作原理</b></summary>

cc-askpass 分成两部分：在 Claude Code 里负责绘制面板的 mod，以及 sudo 和 ssh 要密码时运行的小型 helper 程序（`bin/askpass`）。

```
Claude 的 Bash 命令 → sudo → bin/askpass → 请求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回复 FIFO ←──────────────┘
```

会话开始时，mod 会启动一个监听程序（`bin/askpass --serve`），并为 Claude 执行的命令设置 `SUDO_ASKPASS` 和 `SSH_ASKPASS`（`DISPLAY` 未设置时再补上 `DISPLAY=:0`，因为 sudo 只有在设置了 `DISPLAY` 时才会使用 askpass）。sudo 接着运行 `bin/askpass`，它通过私有目录（权限 0700）里的 FIFO 把提示交给 mod。mod 用 `ps` 查出是哪个程序启动了 helper，弹出面板，再把你的回答写进该 helper 专属的 FIFO。mod 还会在 Claude 的 system prompt 里说明 sudo 可以询问密码，所以 Claude 会直接执行 `sudo`，而不是改用 `sudo -n`。

至于 ssh，mod 会在 Claude 执行命令时的 PATH 最前面放一个小型 `ssh` 包装程序。包装程序会先检查该主机是否适用，再建立一条转发通道，让那里出现的提示（远程的 sudo，或从那台主机再 ssh 到其他主机）回到同一个面板。没通过检查的主机，命令仍会照常运行，只是没有远程提示。

在 Windows 上，helper 是一个 `.exe`，通过只有你的用户能打开的命名管道（named pipe）和 mod 通信。

</details>

## 卸载

在 Claude Code 里运行：

```
/plugin uninstall cc-askpass@cc-askpass
/plugin marketplace remove cc-askpass
```

第二行会移除安装时添加的 marketplace。如果你添加了 sudoers 配置文件，请用 `sudo rm /etc/sudoers.d/cc-askpass` 删除。

## 开发

### 运行本地源码

```sh
claude --plugin-dir .
```

这会启动 Claude Code，并从这个目录加载插件。修改文件后，运行 `/reload-plugins` 或重启 Claude Code。在 Windows 上，`win/cc-askpass.cs` 有改动时 helper 会自动重新构建，因为每次构建都放在 `win/out/<源码的哈希值>`。

### 测试

```sh
claude plugin validate .
claude plugin test .
```

`validate` 检查插件的文件。`test` 在 Claude Code 的测试工具里运行 mod 的测试（`hooks/*.test.ts`），无需登录，所有平台都能运行。

```sh
sh tests/askpass.sh   # Linux、WSL、macOS
sh tests/ssh.sh       # Linux、WSL、macOS
```

`tests/askpass.sh` 测试 helper。`tests/ssh.sh` 测试 ssh 包装程序；其中的端到端测试会以你的用户身份在 127.0.0.1 启动自己的 sshd，所以需要先装好 `sshd`（Debian 和 Ubuntu 上是 `openssh-server`）。没有的话，这部分测试会跳过并显示警告。它还会确认能找到的每种 shell（sh、bash、zsh、fish）都能正确解读远程的设置命令，有 `python3` 时还会多跑几项 socket 检查。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1
```

请在 Windows 上从项目根目录运行。它会编译 helper 并进行测试。

### 类型检查

```sh
npx -p typescript tsc -p .
```

`tsconfig.json` 继承自 `.claude-plugin/types/tsconfig.json`，这个文件是 Claude Code 第一次加载 mod 时生成的，所以运行前要先跑过一次 `claude --plugin-dir .`。这个目录已经在 `.gitignore` 里。

### CI

GitHub Actions 会在 Ubuntu、macOS 和 Windows 上运行 `validate` 和 `test`，然后在 Ubuntu 和 macOS 上运行 `tests/askpass.sh` 和 `tests/ssh.sh`，在 Windows 上运行 `tests/win.ps1`。某个平台失败不会中断其他平台。

### 约定

- 文件统一使用 LF 换行（见 `.gitattributes`）。
- `tests/win.ps1` 请只用 ASCII 字符：Windows PowerShell 会用 ANSI 代码页读取没有 BOM 的脚本。

## 许可证

[MIT](LICENSE)
