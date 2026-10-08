# cc-askpass

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md)

**讓 Claude 直接執行需要 sudo 的指令，不用再把指令複製到自己的終端機執行。**

Claude 執行的指令需要密碼時（`sudo apt install`、會呼叫 sudo 的安裝腳本、透過 HTTPS 的 `git push`、有 passphrase 的 ssh 金鑰），cc-askpass 會在 Claude Code 裡跳出密碼面板。你在面板裡輸入密碼，密碼會直接交給提出要求的程式，不會進入模型、對話紀錄或任何 log。

沒有它的話，Claude 的 Bash 工具沒有終端機，sudo 會直接失敗：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

結果只好把指令複製到自己的終端機執行，再把結果告訴 Claude。其他繞路方法風險更高：把密碼貼進對話讓 Claude 用 `sudo -S`，密碼就進了模型的 context；在 sudoers 設定 `NOPASSWD`，則任何東西都能不經詢問就以 root 執行。

- **不用設定。** 裝好之後，sudo、ssh 和 git 需要密碼時就會直接問你。
- **密碼不經過模型。** 密碼從面板在 Linux 和 macOS 上經由私有的 FIFO、在 Windows 上經由私有的具名管道（named pipe）送到提出要求的程序，不會出現在模型的 context、log、命令列或任何檔案裡。
- **看得到你在核准什麼。** 面板會顯示將以 root 執行的完整指令，以及 Claude 為此執行了哪個指令。
- **看得到是誰在問。** 每個請求都會顯示，不會被默默拒絕。面板會標出提出要求的程式（`Asked by:`）和 Claude 執行的指令（`Claude ran:`），由你決定。

## 需求

- Claude Code 2.1.289 以上
- Linux、WSL、macOS（已在 macOS 14 和 26 測試）或 Windows。在 Windows 上，Git for Windows 不是必要的：沒有它時，Claude Code 只使用 PowerShell 工具。mod 兩個工具都支援。見 [Windows](#windows)。

## 安裝

```sh
claude plugin marketplace add GoneTone/cc-askpass
claude plugin install cc-askpass@cc-askpass
```

接著重新啟動 Claude Code，或執行 `/reload-plugins`。不需要任何設定。

## 使用方式

請 Claude 執行任何需要 sudo 的指令，就會跳出 **sudo password** 面板，並完整顯示將以 root 執行的指令（例如 `$ sudo apt update`）。如果 sudo 是由 Claude 執行的其他東西間接呼叫的，例如 `./install.sh` 或 `curl … | bash`，還會多一行 `Claude ran:` 顯示那個指令。標題下方的 `Asked by:` 一行會標出提出要求的程式。只有在 `Asked by:` 和 `Claude ran:` 都符合你的預期時才回答。輸入密碼後按 Enter。

- **Show/Hide** 可以顯示你輸入的內容。sudo 一律遮罩；其他提示也預設遮罩，只有 git 的 `Username for '...'` 和 ssh 第一次連線的 `(yes/no)` 確認例外。
- **Cancel** 或 Esc 代表不回答，sudo 會顯示「no password was provided」並結束。
- 密碼打錯時會再問一次，並提示「Sorry, try again」。
- 如果面板出現時你正在輸入框打字（或有對話框開著），面板就拿不到鍵盤。這時它會用紅字提示：先點一下面板（或按 ctrl+x tab；非 fullscreen 模式只能用按鍵）再輸入，免得密碼打進輸入框、被當成訊息送給 Claude。
- 面板出現在哪裡由 Claude Code 決定：fullscreen 模式且寬度 110 欄以上時停靠在對話記錄旁邊，其他情況出現在提示列上方。
- 終端機寬度不到 144 欄時，面板可能不會自動跳出，這時提示列上方會顯示 `sudo is waiting for a password — click the button below or type /askpass`，下方有一個 **Open password prompt** 按鈕。點按鈕或輸入 `/askpass` 即可開啟，Claude 執行中也能用。非 fullscreen 模式下終端機不支援滑鼠點擊，這行提示會改成請你按 ctrl+x tab（鍵盤會移到按鈕上）再按 Enter，或輸入 `/askpass`。

### 遠端主機

透過 ssh 連到其他主機時，那裡的密碼提示也會用同一個面板：

- `ssh host sudo apt update`，以及遠端腳本裡的 sudo（`ssh host ./deploy.sh`）。
- 再往下跳：從遠端主機再 `ssh` 到第三台。
- rsync、ansible 和會呼叫 ssh 的腳本。帶有 `-S` 或 `-n` 的遠端 sudo（例如 ansible 的 become）則原封不動放行，不會出現在面板上。

無法參與的主機會被自動偵測並原封不動放行，ssh 的行為和沒裝 cc-askpass 時一樣：git 代管服務（`git@github.com`）、網路設備、設有 forced command 的帳號、Windows sshd，以及沒有 `/bin/sh` 的主機。

面板會標出主機名稱（`sudo on server needs your password`），在 `$` 那行後面加上 `(reported by server)`，而且遠端提示一律顯示 `Claude ran:` 那行，外加一則警告，請你回答前先確認。

呼叫端自己指定的 `ControlPath` 或 `-S` 不會被沿用，所以像 ansible 這類工具會多開一條連線。你自己 `~/.ssh/config` 裡的 `ControlMaster`/`ControlPersist` 也不會被沿用：經 cc-askpass 處理的每個 ssh 指令都會開自己的連線，所以需要密碼或雙重驗證才能登入的主機，每個指令都會再問一次；這類主機請加進 `excludeHosts`。每個這樣的指令也會在主機上多啟動幾個登入 shell（檢查、轉送、每次回答各一個）。

有兩個選項，可在 `/config` 或設定檔裡設定：

- `remoteHosts`（預設開啟）：回答遠端主機的提示。要關閉，請設定 `"pluginConfigs": { "cc-askpass": { "options": { "remoteHosts": false } } }`。
- `excludeHosts`：用主機名稱比對的 glob 模式；ssh 到符合的主機時一律不處理。

## 一段時間內只問一次

Claude 執行的每個 Bash 指令都是新的行程，所以 sudo 每次都會再問密碼。cc-askpass 不會暫存密碼，因為以你的身分執行的任何程式都可能讀到暫存的密碼。若想讓 sudo 記住「已經驗證過」，請執行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 並加入：

```
Defaults:你的使用者名稱 timestamp_type=global
```

這樣 sudo 會在所有終端機和 Claude Code session 之間共用同一個時間戳記，有效期間是 sudo 原本的逾時時間（預設 15 分鐘），cc-askpass 在這段期間只會問一次。

## 運作方式

```
Claude 的 Bash 指令 → sudo → bin/askpass → 請求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回覆 FIFO ←──────────────┘
```

session 開始時，mod 會啟動一個小型監聽程式（`bin/askpass --serve`），並為 Claude 執行的指令設定這些環境變數：`SUDO_ASKPASS`、`SSH_ASKPASS`、`SSH_ASKPASS_REQUIRE=force`、`CC_ASKPASS_DIR`，以及在 `DISPLAY` 原本沒有設定時補上 `DISPLAY=:0`（sudo 只有在設定了 `DISPLAY` 時才會使用 askpass；`CC_ASKPASS_SET_DISPLAY=1` 標記這是 mod 設的）。sudo 接著執行 `bin/askpass`，它透過 `$XDG_RUNTIME_DIR/cc-askpass/<session>-<pid>/`（權限 0700）裡的 FIFO 把提示交給 mod。mod 用 `ps` 查出是哪個程式啟動了 helper，跳出面板並把該程式顯示在 `Asked by:` 那行，再把你的回答寫進該 helper 專屬的 FIFO。監聽程式運作期間，mod 也會在 Claude 的 system prompt 加一段說明，告訴它 sudo 可以詢問密碼，所以 Claude 會直接執行 `sudo`，而不是改用 `sudo -n` 或請你自己執行。

對 ssh，mod 還會在 Claude 執行的指令的 PATH 最前面放一個小型 `ssh` 包裝程式。它用私有的連線啟動真正的 ssh，檢查該主機能否參與，並建立一條轉送通道，讓那裡出現的提示（遠端主機上的 sudo，或再往下一跳的 ssh）經由同一個 FIFO 回到面板。沒通過檢查的主機會和沒裝時一樣照常執行。

## Windows

在 Windows 上，mod 沒有 shell helper。第一次啟動 session 時（以及外掛更新後），它會用 Windows 10 和 11 內建的 .NET Framework，從 `win/` 裡的 C# 原始碼建置自己的 helper。不會下載或附帶任何二進位檔。建置結果放在 `win/out/`，需要一點時間；之後啟動會直接沿用。

- helper 是一個 `.exe`：mod 把它當監聽程式啟動，ssh 和 git 則把它當 askpass 程式執行，它透過只有你的使用者能開啟的具名管道（named pipe）和 mod 溝通。
- 兩個工具都支援：Bash 工具裡 Git for Windows 的 ssh，以及 PowerShell 工具裡的 Windows OpenSSH。ssh 金鑰的 passphrase、ssh 密碼登入、透過 HTTPS 或 ssh 的 git，以及遠端主機上的 sudo，都會在面板詢問。Windows 上沒有本機 sudo，所以不處理 `sudo.exe` 和 UAC。
- 封鎖 `Add-Type` 或未簽署程式的機器（AppLocker、WDAC、強制的執行原則）上，mod 會保持關閉。toast 會說明原因，Claude 的指令則和沒裝 mod 時一樣。
- 遠端主機：Windows 的 ssh 無法共用連線，所以被包裝的 `ssh host …` 會開兩條連線，一條處理提示，一條執行指令。以密碼登入時，每個指令會問兩次；用金鑰或 agent 登入則感覺不到差別。

## 安全性

- 密碼不會寫入模型的 context、log、toast、status line、指令參數或任何檔案。
- 每個請求都會顯示，不會因為來源而被拒絕。你根據兩行判斷：`Asked by:` 是提出要求的程式（作業系統能回答時就用它的答案），`Claude ran:` 是 Claude 執行的指令。只有在兩者都符合預期時才回答，例如你認得的指令所呼叫的 sudo 或 ssh。`ssh` 或 `git` 指令會把你的回答送到它指定的伺服器。
- 任何以你的身分執行的程式都能跳出面板，包括 Claude 執行的腳本，而且你一回答，它就能取得你輸入的內容。cc-askpass 的目標是正常使用下不讓密碼進入模型的 context，它不是防範你的身分底下惡意程式的沙箱。
- 在 Linux 和 macOS 上，`Asked by:` 依據 helper 回報的 pid。等著真正的 sudo 提示並搶先送出請求的程式，有可能被顯示成那個 sudo。在 Windows 上，pid 由核心回報。
- 沒有經過 cc-askpass helper 的請求，面板會標示為未驗證（unverified）。
- 遠端提示會標出主機名稱。在指名其他主機的面板裡，輸入的要是那台遠端主機的密碼（絕不是本機的密碼）。把 `remoteHosts` 設為 `false` 即可關閉這項功能。

## 限制

- `su` 和 `doas` 不支援 askpass，請改用 sudo。
- polkit（`pkexec`、`run0`、以一般使用者執行 `systemctl`）會直接顯示「Interactive authentication required」而不會詢問。
- 不處理 y/n 之類的提問，請使用 `-y`、`--no-interaction` 等參數。
- 遮罩輸入可以在欄位任何位置輸入，但在中間刪除的字元會被當成刪掉尾端的字元。如果在中間編輯過，請按 Show 確認，或清空後重新輸入。
- 在沒有圖形介面的主機上，`DISPLAY=:0` 這個假值可能讓少數圖形程式（例如 `xdg-open`）嘗試連線 X server 而失敗。
- 行動版 app（以及從手機使用 Remote Control）無法顯示輸入欄位，請改在終端機或桌面版 app 回答。
- 非互動模式（`claude -p`、SDK）下沒有人能回答，mod 不會啟動，sudo 會和沒裝 mod 時一樣直接失敗。
- 開啟 Bash 沙箱時，sudo 無法提權，helper 也看不到監聽程式，會立刻以「the cc-askpass listener is not running」失敗。
- ssh 的確認提示（`SSH_ASKPASS_PROMPT=confirm`）會以一般文字輸入的形式出現。
- 以 Windows sshd 作為遠端主機時原封不動放行（沒有遠端提示）。
- Windows：不處理 `sudo.exe` 和 UAC 提示；自己會開視窗的程式（Git Credential Manager、Pageant）照舊用自己的視窗。
- 在 `ssh -t` 底下以絕對路徑呼叫 `/usr/bin/sudo` 時，它會直接讀取終端機而不是詢問。
- 遠端主機的登入設定檔（rc 檔）若會輸出到 stdout，檢查會失敗，指令照常執行，沒有遠端提示。
- ssh 的選項值或主機名稱含有空白時（`-o "User alice"`），該指令沒有遠端提示；請改寫成 `-o User=alice`。
- Claude 的 Bash 指令執行時，PATH 最前面會是 `…/bin/shim`（在 session 開始時設定，不會改動指令本身）。裡面只有 ssh 包裝程式，`remoteHosts` 關閉時它會直接放行。

## 移除

```sh
claude plugin uninstall cc-askpass
```

如果你有加入 sudoers 設定檔，請用 `sudo rm /etc/sudoers.d/cc-askpass` 刪除。

## 開發

```sh
sh tests/askpass.sh                            # helper 測試（Linux、WSL、macOS）
sh tests/ssh.sh                                # ssh 包裝程式測試（Linux、WSL、macOS）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1   # Windows 測試
claude plugin validate . && claude plugin test .
claude --plugin-dir .                          # 用這份原始碼啟動 Claude Code
npx -p typescript tsc -p .                     # 型別檢查（先用 --plugin-dir 載入過一次）
```

## 授權

[MIT](LICENSE)
