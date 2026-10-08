# Tests for the Windows helper (win/). Run on Windows from the repository root:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/win.ps1
# The file stays ASCII: Windows PowerShell reads a script without a BOM in the ANSI code page.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'win\cc-askpass.cs'
$buildScript = Join-Path $root 'win\build.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$utf8 = New-Object System.Text.UTF8Encoding $false
$started = New-Object System.Collections.ArrayList
$current = 'setup'
$code = 0

Add-Type -Namespace CcAskpassTest -Name Path -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
public static extern int GetLongPathNameW(string path, System.Text.StringBuilder longPath, int size);
'@
# CI runners have an 8.3 TEMP (RUNNER~1); the kernel reports executables by their long path.
function Get-LongPath([string]$path) {
  $long = New-Object System.Text.StringBuilder 1024
  if ([CcAskpassTest.Path]::GetLongPathNameW($path, $long, $long.Capacity) -eq 0) { throw "no long path for $path" }
  $long.ToString()
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('cc-askpass-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $tmp
$tmp = Get-LongPath $tmp

function Check([bool]$ok, [string]$why) { if (-not $ok) { throw $why } }

# Windows command-line quoting, as CommandLineToArgvW and the C runtime read it.
function Quote([string]$arg) {
  '"' + ($arg -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

# Starts a program with redirected UTF-8 output. CC_ASKPASS_PIPE is removed unless $vars sets it.
function Start-Program([string]$exe, [string[]]$argv, [hashtable]$vars = @{}, [string]$dir = $tmp) {
  $info = New-Object System.Diagnostics.ProcessStartInfo $exe
  $info.Arguments = (@($argv) | ForEach-Object { Quote $_ }) -join ' '
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $utf8
  $info.StandardErrorEncoding = $utf8
  $info.WorkingDirectory = $dir
  $info.EnvironmentVariables.Remove('CC_ASKPASS_PIPE')
  foreach ($name in $vars.Keys) { $info.EnvironmentVariables[$name] = $vars[$name] }
  $process = [System.Diagnostics.Process]::Start($info)
  $null = $started.Add($process)
  [pscustomobject]@{ P = $process; Err = $process.StandardError.ReadToEndAsync(); Pending = $null; Pipe = $null; Token = $null }
}

function Get-Stderr($program) { if ($program.Err.Wait(2000)) { $program.Err.Result } else { '' } }

# The next stdout line within $ms, or $null; a line still on its way is kept for the next call.
function Read-Line($program, [int]$ms = 5000) {
  if ($null -eq $program.Pending) { $program.Pending = $program.P.StandardOutput.ReadLineAsync() }
  if (-not $program.Pending.Wait($ms)) { return $null }
  $line = $program.Pending.Result
  $program.Pending = $null
  $line
}

# Waits up to $ms for the program to end; returns its exit code and the whole stdout.
function Wait-Program($program, [int]$ms = 5000) {
  Check $program.P.WaitForExit($ms) "$($program.P.StartInfo.FileName) did not end within $ms ms"
  @{ Code = $program.P.ExitCode; Out = $program.P.StandardOutput.ReadToEnd(); Err = (Get-Stderr $program) }
}

function Invoke-Build([string]$outDir) {
  $build = Start-Program $powershell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $buildScript, $source, $outDir)
  $result = Wait-Program $build 60000
  Check ($result.Code -eq 0) "build into $outDir failed: $($result.Err)"
  Join-Path $outDir 'cc-askpass.exe'
}

function Start-Serve([string]$session) {
  $serve = Start-Program $script:exe @('serve', $session)
  $ready = Read-Line $serve
  Check ($null -ne $ready) "serve printed no ready line: $(Get-Stderr $serve)"
  $fields = $ready -split "`t"
  Check ($fields.Count -eq 3 -and $fields[0] -ceq 'ready' -and $fields[1] -ceq "cc-askpass-$session-$PID" -and $fields[2] -cmatch '^[0-9a-f]{32}$') "bad ready line: $ready"
  $serve.Pipe = $fields[1]
  $serve.Token = $fields[2]
  $serve
}

function Start-Ask([string]$prompt, $serve, [string]$exe = $script:exe, [string]$dir = $tmp) {
  Start-Program $exe @($prompt) @{ CC_ASKPASS_PIPE = $serve.Pipe } $dir
}

function Read-Request($serve, [int]$ms = 5000) {
  $line = Read-Line $serve $ms
  Check ($null -ne $line) 'the listener printed no request line'
  $request = $line | ConvertFrom-Json
  Check ($null -ne $request.id) "not a request line: $line"
  $request
}

# Sends <token>\t<id>\n<password>\n through `reply`, as the mod does.
function Send-Reply($serve, $id, [string]$password, [string]$token = $serve.Token) {
  $reply = Start-Program $script:exe @('reply') @{ CC_ASKPASS_PIPE = $serve.Pipe }
  $bytes = $utf8.GetBytes("$token`t$id`n$password`n")
  $reply.P.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $reply.P.StandardInput.Close()
  $result = Wait-Program $reply
  Check ($result.Code -eq 0) "reply failed: $($result.Err)"
}

function Test([string]$name, [scriptblock]$body) {
  $script:current = $name
  & $body
}

try {
  $session = 'test-' + [guid]::NewGuid().ToString('N')

  Test 'build is idempotent and cleans siblings' {
    $null = Invoke-Build (Join-Path $tmp 'out\a')
    Check (Test-Path -LiteralPath (Join-Path $tmp 'out\a\shim\ssh.exe')) 'no shim\ssh.exe'
    $null = New-Item -ItemType Directory (Join-Path $tmp 'out\keep\shim')
    $script:exe = Invoke-Build (Join-Path $tmp 'out\b')
    Check (-not (Test-Path -LiteralPath (Join-Path $tmp 'out\a'))) 'the first build directory is still there'
    Check (Test-Path -LiteralPath $exe) 'no cc-askpass.exe in the second build'
    Check (Test-Path -LiteralPath (Join-Path $tmp 'out\keep\shim')) 'a directory without build files was removed'
    $wrapper = Wait-Program (Start-Program (Join-Path $tmp 'out\b\shim\ssh.exe') @('host'))
    Check ($wrapper.Code -eq 255) "the ssh stub exited $($wrapper.Code)"
  }

  Test 'a build in use stays until it is free' {
    $old = Join-Path $tmp 'inuse\old'
    $oldServe = Start-Program (Invoke-Build $old) @('serve', 'test-inuse')
    Check ($null -ne (Read-Line $oldServe)) "the old build's listener did not start: $(Get-Stderr $oldServe)"
    $null = Invoke-Build (Join-Path $tmp 'inuse\new')
    Check (Test-Path -LiteralPath (Join-Path $old 'shim\ssh.exe')) 'a build in use lost its shim\ssh.exe'
    $oldServe.P.Kill()
    $null = $oldServe.P.WaitForExit(5000)
    $null = Invoke-Build (Join-Path $tmp 'inuse\newer')
    Check (-not (Test-Path -LiteralPath $old)) 'the old build stayed after its listener ended'
  }

  $serve = Start-Serve $session

  Test 'askpass reaches the pane line and returns the reply' {
    $ask = Start-Ask 'Enter passphrase: ' $serve
    $request = Read-Request $serve
    Check ($request.client.exe -eq $exe) "client.exe is $($request.client.exe)"
    Check ($request.client.pid -eq $ask.P.Id) "client.pid is $($request.client.pid)"
    Check ($request.parent.pid -eq $PID) "parent.pid is $($request.parent.pid)"
    Check ($request.prompt -ceq 'Enter passphrase: ') "prompt is '$($request.prompt)'"
    Check ($null -eq $request.relay) 'relay is set'
    Send-Reply $serve $request.id 'hunter2'
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "hunter2`n") "askpass exited $($result.Code) with '$($result.Out)'"
  }

  Test 'password round-trips exactly' {
    $password = "  p&w|`"x^%!<y>`t\\" + [char]0xE9 + '  '
    $ask = Start-Ask 'Password: ' $serve
    Send-Reply $serve (Read-Request $serve).id $password
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "$password`n") "askpass printed '$($result.Out)'"
  }

  Test 'non-ASCII path, prompt and password' {
    $dir = Join-Path $tmp ('cjk\' + [char]0x6E2C + [char]0x8A66 + ' dir')
    $cjkExe = Invoke-Build $dir
    $prompt = '' + [char]0x5BC6 + [char]0x78BC + [char]0xFF1A
    $password = -join [char[]](0x043F, 0x0430, 0x0440, 0x043E, 0x043B, 0x044C, 0x5BC6, 0x78BC)
    $ask = Start-Ask $prompt $serve $cjkExe
    $request = Read-Request $serve
    Check ($request.client.exe -eq $cjkExe) "client.exe is $($request.client.exe)"
    Check ($request.prompt -ceq $prompt) "prompt is '$($request.prompt)'"
    Send-Reply $serve $request.id $password
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "$password`n") "askpass printed '$($result.Out)'"
  }

  Test 'a prompt with quotes arrives as one argument' {
    $prompt = 'a"&echo INJECTED>m&"b'
    $dir = Join-Path $tmp 'quotes'
    $null = New-Item -ItemType Directory $dir
    $ask = Start-Ask $prompt $serve $exe $dir
    $request = Read-Request $serve
    Check ($request.prompt -ceq $prompt) "prompt is '$($request.prompt)'"
    Send-Reply $serve $request.id 'x'
    $null = Wait-Program $ask
    Check (-not (Test-Path -LiteralPath (Join-Path $dir 'm'))) 'a command ran: m exists'
  }

  Test 'ssh-keygen through both ssh builds' {
    $windowsKeygen = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh-keygen.exe'
    $passphrase = 'k3y "pass" & more'
    $key = Join-Path $tmp 'id_test'
    $made = Wait-Program (Start-Program $windowsKeygen @('-q', '-t', 'ed25519', '-N', $passphrase, '-C', 'test', '-f', $key)) 30000
    Check ($made.Code -eq 0) "ssh-keygen could not make a key: $($made.Err)"
    $public = ((Get-Content -LiteralPath "$key.pub") -split ' ')[0..1] -join ' '
    $keygens = @($windowsKeygen, 'C:\Program Files\Git\usr\bin\ssh-keygen.exe') | Where-Object { Test-Path -LiteralPath $_ }
    foreach ($keygen in $keygens) {
      $run = Start-Program $keygen @('-y', '-f', $key) @{ SSH_ASKPASS = $exe; SSH_ASKPASS_REQUIRE = 'force'; CC_ASKPASS_PIPE = $serve.Pipe }
      $request = Read-Request $serve 10000
      Check ($request.parent.exe -like '*\ssh-keygen.exe') "parent.exe is $($request.parent.exe) for $keygen"
      Send-Reply $serve $request.id $passphrase
      $result = Wait-Program $run 10000
      Check ($result.Code -eq 0 -and $result.Out.StartsWith($public)) "$keygen exited $($result.Code): $($result.Out) $($result.Err)"
    }
  }

  Test 'a wrong token is ignored' {
    $ask = Start-Ask 'Password: ' $serve
    $request = Read-Request $serve
    Send-Reply $serve $request.id 'wrong' ('0' * 32)
    Check (-not $ask.P.WaitForExit(1000)) 'askpass ended after a wrong token'
    Send-Reply $serve $request.id 'right'
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "right`n") "askpass printed '$($result.Out)'"
  }

  Test 'empty reply fails askpass' {
    $ask = Start-Ask 'Password: ' $serve
    Send-Reply $serve (Read-Request $serve).id ''
    $result = Wait-Program $ask
    Check ($result.Code -eq 1) "askpass exited $($result.Code)"
  }

  Test 'gone is reported' {
    $ask = Start-Ask 'Password: ' $serve
    $request = Read-Request $serve
    $ask.P.Kill()
    $line = Read-Line $serve 2000
    Check ($line -ceq "{`"gone`":$($request.id)}") "got '$line'"
  }

  Test 'askpass reconnects after a listener restart' {
    $ask = Start-Ask 'Password: ' $serve
    $null = Read-Request $serve
    $serve.P.Kill()
    $null = $serve.P.WaitForExit(5000)
    $script:serve = Start-Serve $session
    $request = Read-Request $script:serve 8000
    Check ($request.prompt -ceq 'Password: ') "prompt is '$($request.prompt)'"
    Send-Reply $script:serve $request.id 'again'
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "again`n") "askpass exited $($result.Code) with '$($result.Out)'"
  }

  Test 'askpass gives up on a listener that keeps closing' {
    $name = 'test-closer-' + [guid]::NewGuid().ToString('N')
    $closer = "while (`$true) { `$s = New-Object System.IO.Pipes.NamedPipeServerStream('$name', 'InOut', -1); `$s.WaitForConnection(); `$s.Dispose() }"
    $null = Start-Program $powershell @('-NoProfile', '-NonInteractive', '-Command', $closer)
    $result = Wait-Program (Start-Ask 'Password: ' ([pscustomobject]@{ Pipe = $name })) 15000
    Check ($result.Code -eq 1) "askpass exited $($result.Code)"
    Check ($result.Err -match 'keeps closing') "stderr is '$($result.Err)'"
  }

  Test 'two listeners keep their requests apart' {
    $other = Start-Serve ('test-' + [guid]::NewGuid().ToString('N'))
    $first = Start-Ask 'first: ' $serve
    $second = Start-Ask 'second: ' $other
    $request = Read-Request $serve
    Check ($request.prompt -ceq 'first: ') "the first listener got '$($request.prompt)'"
    $otherRequest = Read-Request $other
    Check ($otherRequest.prompt -ceq 'second: ') "the second listener got '$($otherRequest.prompt)'"
    Check ($null -eq (Read-Line $serve 500)) 'the first listener printed another line'
    Check ($null -eq (Read-Line $other 500)) 'the second listener printed another line'
    Send-Reply $serve $request.id 'one'
    Send-Reply $other $otherRequest.id 'two'
    Check ((Wait-Program $first).Out -ceq "one`n") 'the first askpass got the wrong reply'
    Check ((Wait-Program $second).Out -ceq "two`n") 'the second askpass got the wrong reply'
  }

  Test 'without CC_ASKPASS_PIPE askpass fails at once' {
    $result = Wait-Program (Start-Program $exe @('Password: ')) 1000
    Check ($result.Code -eq 1) "askpass exited $($result.Code)"
    Check ($result.Err -match 'cc-askpass mod') "stderr is '$($result.Err)'"
  }

  'PASS: all Windows helper tests'
} catch {
  "FAIL: ${current}: $($_.Exception.Message)"
  $code = 1
} finally {
  foreach ($process in $started) {
    if (-not $process.HasExited) {
      try { $process.Kill(); $null = $process.WaitForExit(5000) } catch { }
    }
  }
  # A killed exe stays locked for a moment.
  for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $tmp); $i++) {
    try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { Start-Sleep -Milliseconds 250 }
  }
}
exit $code
