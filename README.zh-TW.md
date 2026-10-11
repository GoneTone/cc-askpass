# cc-askpass

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md)

**一個 Claude Code Mod，讓 Claude 直接執行需要 sudo 的指令，不用再把指令複製到自己的終端機執行。**

Claude 執行的指令需要密碼時（`sudo apt install`、會呼叫 sudo 的安裝腳本、透過 HTTPS 的 `git push`、ssh 金鑰的 passphrase），cc-askpass 會在 Claude Code 裡跳出密碼面板讓你可以輸入密碼。密碼會直接交給提出要求的程式，不會進入模型、對話紀錄或任何 log。

沒有它的話，Claude 的 Bash 工具沒有終端機，sudo 會直接失敗：

```
sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper
sudo: a password is required
```

結果只好自己到終端機執行。把密碼貼進對話，或在 sudoers 設定 `NOPASSWD` 也能繞過，但兩者風險都更高。

- **不用設定。** 裝好之後，sudo、ssh 和 git 需要密碼時就會在面板裡問你。
- **密碼不經過模型。** 密碼不會出現在模型的 context、log、命令列或任何檔案裡。
- **看得到你在核准什麼。** 面板會顯示將以 root 執行的指令、提出要求的程式，以及 Claude 執行的指令。

## 安裝

需要 Claude Code 2.1.286 以上，支援 Linux、WSL、macOS 和 Windows。在 Claude Code 裡執行：

```
/plugin marketplace add GoneTone/cc-askpass
/plugin install cc-askpass@cc-askpass
```

`/plugin install` 會詢問安裝範圍並列出選項，用預設值即可。接著重新啟動 Claude Code，或執行 `/reload-plugins`。

## 使用方式

Claude 執行的指令要求密碼時，就會跳出面板。`$` 那行顯示提出要求的指令；如果是 sudo，就是將以 root 執行的指令（例如 `$ sudo apt update`）。`Asked by:` 標出提出要求的程式；如果提示是由 Claude 執行的其他東西間接觸發的（例如 `./install.sh`），`Claude ran:` 會顯示那個指令。確認這些都符合預期再回答：輸入密碼後按 Enter。

- **Show/Hide** 切換是否顯示你輸入的內容。
- 按 **Cancel** 或 Esc 就是不回答，sudo 會直接結束。
- 密碼打錯時，sudo 會再問一次。

<details>
<summary><b>面板沒跳出來，或打字打不進去</b></summary>

- 如果面板出現時你正在輸入框打字（或有對話框開著），按鍵還是會送到輸入框。這時面板會用紅字提醒你：先把鍵盤切到面板再輸入，免得密碼打進輸入框、被當成訊息送給 Claude。切換方法是點一下面板，或按 ctrl+x tab（非 fullscreen 模式下點擊沒有作用，只能用按鍵）。
- 終端機寬度不到 144 欄時，面板可能不會自動跳出，這時提示列上方會顯示一行提示，例如 `sudo is waiting for a password`，並附上 **Open password prompt** 按鈕。點按鈕或輸入 `/askpass` 即可開啟，Claude 執行中也能用。非 fullscreen 模式下請改按 ctrl+x tab 再按 Enter。
- 輸入內容預設會遮住，只有 git 的 `Username for '...'` 和 ssh 的 `(yes/no)` 主機金鑰確認例外。

</details>

<details>
<summary><b>遠端主機（ssh）</b></summary>

透過 ssh 連到的主機，密碼提示也會用同一個面板：`ssh host sudo apt update`、遠端腳本裡的 sudo（`ssh host ./deploy.sh`）、從那台主機再 ssh 到其他主機，以及 rsync、ansible 或會呼叫 ssh 的腳本。帶有 `-S`（從標準輸入讀密碼）或 `-n`（不詢問）的遠端 sudo，例如 ansible 的 become，不會使用面板。

面板會標出主機名稱（`sudo on server needs your password`），並在 `$` 那行後面加上 `(reported by server)`，表示這個指令是遠端主機回報的，本機無法查證。面板也一律會顯示 `Claude ran:`，並提醒你先確認。這裡要輸入的是那台遠端主機的密碼，不要輸入本機的密碼。

有些主機無法把提示傳回來：網路設備、設有 forced command 的帳號、Windows sshd，以及沒有 `/bin/sh` 的主機。cc-askpass 會自動偵測，指令還是會照常執行，只是這些主機上的提示不會出現在面板。透過 ssh 的 git 操作（例如 `git push` 到 `git@github.com`）則完全不會經過 cc-askpass。

經 cc-askpass 處理的每個 ssh 指令都會各自開一條新連線，不會沿用你在 `~/.ssh/config` 用 `ControlMaster`/`ControlPersist` 設定的共用連線，也不會沿用呼叫端自己的 `ControlPath` 或 `-S`（所以像 ansible 這類工具，每個指令都會多開一條連線）。因此，如果登入某台主機需要密碼或雙重驗證碼，每個指令都會再問你一次。想避免的話，把這台主機加進 `excludeHosts`：ssh 到這台主機時會照你原本的參數執行，你自己的共用連線也會恢復作用，但這台主機上的 sudo 提示就不會出現在面板了。每個經過處理的指令也會在主機上多啟動幾個登入 shell。

有兩個相關選項，可以在 Claude Code 裡用 `/plugin configure cc-askpass@cc-askpass` 設定，或直接寫在設定檔裡：

- `remoteHosts`（預設開啟）：在面板顯示遠端主機的密碼提示。要關閉，請設定 `"pluginConfigs": { "cc-askpass@cc-askpass": { "options": { "remoteHosts": false } } }`。
- `excludeHosts`：比對主機名稱的 glob 模式。ssh 到符合的主機時，cc-askpass 不會介入。

</details>

<details>
<summary><b>一段時間內只問一次</b></summary>

Claude 執行的每個指令都是新的行程，所以 sudo 每次都會再問。cc-askpass 不會暫存密碼，因為暫存的密碼可能被你帳號底下的任何程式讀走。你可以改讓 sudo 記住你已經輸入過密碼：執行 `sudo visudo -f /etc/sudoers.d/cc-askpass` 並加入：

```
Defaults:你的使用者名稱 timestamp_type=global, timestamp_timeout=5
```

這樣 sudo 會在所有終端機和 Claude Code session 之間共用同一個時間戳記，5 分鐘後才會再問。

**這會削弱 cc-askpass 提供的保護。** 在時間戳記失效之前：

- Claude 執行 sudo 時不會跳出面板，你就看不到、也無法逐一核准以 root 執行的指令。
- 你帳號底下的其他程式，在任何終端機裡執行 sudo 也都不需要密碼。

能接受這些代價再開啟。時間請設短一點，用完後執行 `sudo -k` 就能立刻讓它失效。如果沒有設定 `timestamp_timeout`，sudo 會用它的預設值：5 分鐘，部分發行版（例如 Ubuntu）是 15 分鐘。

</details>

<details>
<summary><b>Windows</b></summary>

- 不一定要裝 Git for Windows：沒裝的話，Claude Code 只會用 PowerShell 工具。兩種工具 cc-askpass 都支援：Bash 工具裡 Git for Windows 的 ssh，以及 PowerShell 工具裡的 Windows OpenSSH。
- ssh 金鑰的 passphrase、ssh 密碼登入、透過 HTTPS 或 ssh 的 git，以及遠端主機上的 sudo，都會使用面板。Windows 自己的 `sudo.exe` 和 UAC 提示不在處理範圍，它們會顯示 Windows 本身的對話框。
- 第一次啟動 session 時（以及外掛更新後），cc-askpass 會用 Windows 10 和 11 內建的 .NET Framework，從 `win/` 裡的 C# 原始碼建置它的 helper 程式。不會下載或附帶任何二進位檔。建置結果放在 `win/out/`，需要一點時間。
- 如果機器封鎖了 `Add-Type` 或未簽署的程式（AppLocker、WDAC、強制的執行原則），cc-askpass 就不會啟用，並用 toast 說明原因。
- 遠端主機：Windows 的 ssh 無法共用連線，所以 `ssh host …` 會開兩條連線，一條處理提示，一條執行指令。因此以密碼登入，或使用有 passphrase 但沒有 agent 的金鑰時，每個指令會問兩次；用 agent 或沒有 passphrase 的金鑰登入則感覺不到差別。

</details>

<details>
<summary><b>安全性</b></summary>

- 密碼不會寫入模型的 context、log、toast、狀態列、指令參數或任何檔案。
- 你帳號底下執行的任何程式都能跳出面板，包括 Claude 執行的腳本；你一回答，它就會拿到你輸入的內容。cc-askpass 能在正常使用下讓密碼不經過模型，但它不是沙箱，擋不住在你帳號底下執行的惡意程式。
- `Asked by:` 盡可能採用作業系統提供的資訊。在 Linux 和 macOS 上，它依據 cc-askpass helper 回報的行程 ID（pid），所以剛好趁真正的 sudo 提示出現時送出請求的程式，有可能被顯示成那個 sudo。在 Windows 上，pid 由核心回報。
- 沒有經過 cc-askpass helper 的請求，會標示為未驗證（unverified）。
- 回答 `ssh` 或 `git` 的提示時，密碼會送到該指令指定的伺服器。

</details>

<details>
<summary><b>限制</b></summary>

- `su` 和 `doas` 不支援 askpass，請改用 sudo。
- polkit（`pkexec`、`run0`、以一般使用者執行 `systemctl`）會直接顯示「Interactive authentication required」而不會詢問。
- 程式自己詢問的 y/n 問題（例如 apt 的 `Do you want to continue? [Y/n]`）不會處理，請使用 `-y`、`--no-interaction` 等參數。
- 輸入內容被遮住時，在中間刪除一個字元，實際被刪掉的會是最後一個字元。如果在中間編輯過，請按 Show 確認，或清空後重新輸入。
- 在沒有圖形介面的主機上，cc-askpass 設定的佔位值 `DISPLAY=:0` 可能讓少數圖形程式（例如 `xdg-open`）失敗。
- 行動版 app（以及從手機使用 Remote Control）無法顯示輸入欄位，請改在終端機或桌面版 app 回答。
- 非互動模式（`claude -p`、SDK）下沒有人能回答，cc-askpass 不會啟動，sudo 會和沒裝時一樣直接失敗。
- 開啟 Bash 沙箱時，sudo 無法在沙箱內執行，會立刻失敗（Linux 上顯示「The "no new privileges" flag is set, which prevents sudo from running as root」，macOS 上顯示「operation not permitted: sudo」）。如果你允許 Claude 在沙箱外執行該指令，面板就會照常詢問。
- ssh 的確認提示（`SSH_ASKPASS_PROMPT=confirm`）會以一般文字輸入的形式出現。
- Windows：自己會開密碼視窗的程式（Git Credential Manager、Pageant）照舊用自己的視窗。
- 在遠端主機上以完整路徑呼叫 sudo（例如 `/usr/bin/sudo`）時不會使用面板：沒有終端機時會直接失敗，在 `ssh -t` 底下則會讀取終端機。請直接寫 `sudo`。
- 如果遠端主機的 shell 啟動檔（例如 `.bashrc`、`.zshenv`）在執行指令時會印出文字，像是歡迎訊息，cc-askpass 就無法確認這台主機是否適用。指令還是會照常執行，但那台主機上的 sudo 不會出現在面板。解決方法是讓那段文字只在互動式 shell 印出，或改印到 stderr。
- ssh 指令中，主機名稱之前的選項或主機名稱本身如果含有空白，例如 `-o "User alice"` 或 `-i "/keys/my key"`，cc-askpass 就不會處理這個 ssh 指令，遠端主機上的 sudo 也就不會出現在面板。`-o` 選項可以改寫成不含空白的 `-o User=alice`。

</details>

<details>
<summary><b>運作方式</b></summary>

cc-askpass 分成兩部分：在 Claude Code 裡負責畫出面板的 mod，以及 sudo 和 ssh 要密碼時執行的小型 helper 程式（`bin/askpass`）。

```
Claude 的 Bash 指令 → sudo → bin/askpass → 請求 FIFO → cc-askpass mod → 面板
                                   ↑                                      │
                                   └──────────── 回覆 FIFO ←──────────────┘
```

session 開始時，mod 會啟動一個監聽程式（`bin/askpass --serve`），並為 Claude 執行的指令設定 `SUDO_ASKPASS` 和 `SSH_ASKPASS`（`DISPLAY` 沒有設定時再補上 `DISPLAY=:0`，因為 sudo 只有在設定了 `DISPLAY` 時才會使用 askpass）。sudo 接著執行 `bin/askpass`，它透過私有目錄（權限 0700）裡的 FIFO 把提示交給 mod。mod 用 `ps` 查出是哪個程式啟動了 helper，跳出面板，再把你的回答寫進該 helper 專屬的 FIFO。mod 也會在 Claude 的 system prompt 說明 sudo 可以詢問密碼，所以 Claude 會直接執行 `sudo`，而不是改用 `sudo -n`。

至於 ssh，mod 會在 Claude 執行指令時的 PATH 最前面放一個小型 `ssh` 包裝程式。包裝程式會先檢查該主機是否適用，再建立一條轉送通道，讓那裡出現的提示（遠端的 sudo，或從那台主機再 ssh 到其他主機）回到同一個面板。沒通過檢查的主機，指令還是會照常執行，只是沒有遠端提示。

在 Windows 上，helper 是一個 `.exe`，透過只有你的使用者能開啟的具名管道（named pipe）和 mod 溝通。

</details>

## 移除

在 Claude Code 裡執行：

```
/plugin uninstall cc-askpass@cc-askpass
/plugin marketplace remove cc-askpass
```

第二行會移除安裝時加入的 marketplace。如果你有加入 sudoers 設定檔，請用 `sudo rm /etc/sudoers.d/cc-askpass` 刪除。

## 開發

### 執行本機的原始碼

```sh
claude --plugin-dir .
```

這會啟動 Claude Code，並從這個目錄載入外掛。修改檔案後，執行 `/reload-plugins` 或重新啟動 Claude Code。在 Windows 上，`win/cc-askpass.cs` 有變動時 helper 會自動重新建置，因為每次建置都放在 `win/out/<原始碼的雜湊值>`。

### 測試

```sh
claude plugin validate .
claude plugin test .
```

`validate` 檢查外掛的檔案。`test` 在 Claude Code 的測試工具裡執行 mod 的測試（`hooks/*.test.ts`），不需要登入，所有平台都能跑。

```sh
sh tests/askpass.sh   # Linux、WSL、macOS
sh tests/ssh.sh       # Linux、WSL、macOS
```

`tests/askpass.sh` 測試 helper。`tests/ssh.sh` 測試 ssh 包裝程式；其中的端對端測試會以你的使用者身分在 127.0.0.1 啟動自己的 sshd，所以需要先裝好 `sshd`（Debian 和 Ubuntu 上是 `openssh-server`）。沒有的話，這部分測試會跳過並顯示警告。它也會確認找得到的每種 shell（sh、bash、zsh、fish）都能正確解讀遠端的設定指令，有 `python3` 時還會多跑幾項 socket 檢查。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1
```

請在 Windows 上從專案根目錄執行。它會編譯 helper 並進行測試。

### 型別檢查

```sh
npx -p typescript tsc -p .
```

`tsconfig.json` 繼承自 `.claude-plugin/types/tsconfig.json`，這個檔案是 Claude Code 第一次載入 mod 時產生的，所以執行前要先跑過一次 `claude --plugin-dir .`。這個目錄已經在 `.gitignore` 裡。

### CI

GitHub Actions 會在 Ubuntu、macOS 和 Windows 上執行 `validate` 和 `test`，接著在 Ubuntu 和 macOS 上執行 `tests/askpass.sh` 和 `tests/ssh.sh`，在 Windows 上執行 `tests/win.ps1`。某個平台失敗不會中斷其他平台。

### 慣例

- 檔案一律使用 LF 換行（見 `.gitattributes`）。
- `tests/win.ps1` 請只用 ASCII 字元：Windows PowerShell 會用 ANSI 字碼頁讀取沒有 BOM 的腳本。

## 授權

[MIT](LICENSE)
