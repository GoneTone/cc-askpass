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
  # $null removes a variable.
  foreach ($name in $vars.Keys) {
    if ($null -eq $vars[$name]) { $info.EnvironmentVariables.Remove($name) } else { $info.EnvironmentVariables[$name] = $vars[$name] }
  }
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

function Start-Serve([string]$session, [string]$exe = $script:exe) {
  $serve = Start-Program $exe @('serve', $session)
  $ready = Read-Line $serve
  Check ($null -ne $ready) "serve printed no ready line: $(Get-Stderr $serve)"
  $fields = $ready -split "`t"
  Check ($fields.Count -eq 4 -and $fields[0] -ceq 'ready' -and $fields[1] -ceq "cc-askpass-$session-$PID" -and $fields[2] -cmatch '^[0-9a-f]{32}$') "bad ready line: $ready"
  # The listener's own image as the kernel names it: the built exe, whatever path started it.
  Check ($fields[3] -eq $script:exe) "the ready line names $($fields[3])"
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
  $reply = Start-Program $script:exe @('--reply') @{ CC_ASKPASS_PIPE = $serve.Pipe }
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

# A fake real ssh for the wrapper: it appends its arguments as one JSON line to FAKE_SSH_LOG and
# plays the relay connection R (serve-stdin), the command connection C (remote.sh run) or a plain
# ssh as FAKE_SSH_MODE says: record, silent, relay, sleep (a plain ssh too) or deaf.
$fakeSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public static class FakeSsh
{
    public static int Main(string[] args)
    {
        string log = Environment.GetEnvironmentVariable("FAKE_SSH_LOG");
        string mode = Environment.GetEnvironmentVariable("FAKE_SSH_MODE") ?? "";
        StringBuilder json = new StringBuilder("{\"argv\":[");
        for (int i = 0; i < args.Length; i++)
        {
            if (i > 0) json.Append(',');
            json.Append('"');
            foreach (char c in args[i])
            {
                if (c == '"' || c == '\\') json.Append('\\').Append(c);
                else if (c < ' ') json.Append("\\u").Append(((int)c).ToString("x4"));
                else json.Append(c);
            }
            json.Append('"');
        }
        File.AppendAllText(log, json.Append("]}\n").ToString(), new UTF8Encoding(false));

        string all = string.Join(" ", args);
        Match relay = Regex.Match(all, "serve-stdin ([0-9a-f]{32})");
        if (relay.Success)
        {
            if (mode == "record") return 255;
            if (mode == "silent") Thread.Sleep(Timeout.Infinite);
            Console.Out.Write("cc-askpass-ready /tmp/cc-askpass-" + relay.Groups[1].Value + "\n");
            if (mode != "relay") Thread.Sleep(Timeout.Infinite);
            Console.Out.Write("junk\nabc\tnot a pid\n77\t[sudo] password for bob: \t\tsudo true\n");
            using (Stream stdin = Console.OpenStandardInput())
            using (FileStream copy = new FileStream(log + ".stdin", FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
            {
                byte[] buffer = new byte[4096];
                int n;
                while ((n = stdin.Read(buffer, 0, buffer.Length)) > 0)
                {
                    copy.Write(buffer, 0, n);
                    copy.Flush();
                }
            }
            return 0;
        }
        if (all.Contains("remote.sh run"))
        {
            if (mode == "deaf") return 5;
            if (mode != "relay") Thread.Sleep(Timeout.Infinite);
            // Ends once R's stdin got the answer.
            for (int i = 0; i < 300; i++)
            {
                Thread.Sleep(100);
                if (!File.Exists(log + ".stdin")) continue;
                using (FileStream copy = new FileStream(log + ".stdin", FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (StreamReader reader = new StreamReader(copy))
                    if (Regex.IsMatch(reader.ReadToEnd(), "\n77\t[^\n]*\n")) return 3;
            }
            return 4;
        }
        // A plain ssh that keeps running, like a tunnel.
        if (mode == "sleep") Thread.Sleep(Timeout.Infinite);
        // A plain ssh that leaves one running in the background, like a ControlPersist master.
        if (mode == "spawn")
        {
            ProcessStartInfo background = new ProcessStartInfo(Assembly.GetEntryAssembly().Location, "background");
            background.UseShellExecute = false;
            background.EnvironmentVariables["FAKE_SSH_MODE"] = "sleep";
            Process.Start(background).Dispose();
        }
        Console.Out.Write("fake-out\n");
        return 7;
    }
}
'@

# Runs the built shim\ssh.exe with the fake ssh after it on PATH and a live listener; $vars
# overrides the defaults ($null removes one). Each run gets its own log.
function Start-Wrapper([string[]]$argv, [hashtable]$vars = @{}) {
  $script:runs++
  $log = Join-Path $tmp "ssh-$script:runs.log"
  $all = @{
    PATH = "$shim;$fakebin;$env:PATH"; CC_ASKPASS_PIPE = $script:serve.Pipe; CC_ASKPASS_WRAP = '1'
    SSH_ASKPASS = $helper; CC_ASKPASS_EXCLUDE = $null; CC_ASKPASS_TEST_READY_MS = $null
    FAKE_SSH_MODE = 'record'; FAKE_SSH_LOG = $log
  }
  foreach ($name in $vars.Keys) { $all[$name] = $vars[$name] }
  $program = Start-Program $wrapper $argv $all
  $program | Add-Member Log $log
  $program
}

# The fake ssh's runs so far, one JSON line each.
function Get-Runs($program) {
  # The comma keeps a one-line array an array.
  if (Test-Path -LiteralPath $program.Log) { ,@(Get-Content -LiteralPath $program.Log -Encoding UTF8) } else { ,@() }
}

# Runs for a failure message, without most of the base64.
function Get-Short($runs) { $text = "$runs"; if ($text.Length -gt 300) { $text.Substring(0, 300) + '...' } else { $text } }

function Test-Argv([string]$run, [string[]]$want) {
  $got = @(($run | ConvertFrom-Json).argv)
  if ($got.Count -ne $want.Count) { return $false }
  for ($i = 0; $i -lt $got.Count; $i++) { if ($got[$i] -cne $want[$i]) { return $false } }
  $true
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

  Test 'parallel builds into one directory all succeed' {
    # Sessions starting at once build the same source into the same directory.
    $dir = Join-Path $tmp 'parallel\same'
    $buildArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $buildScript, $source, $dir)
    $builds = @(1..3 | ForEach-Object { Start-Program $powershell $buildArgs })
    foreach ($build in $builds) {
      $result = Wait-Program $build 120000
      Check ($result.Code -eq 0) "a parallel build exited $($result.Code): $($result.Err)"
    }
    $run = Wait-Program (Start-Program (Join-Path $dir 'cc-askpass.exe') @('Password: '))
    Check ($run.Code -eq 1 -and $run.Err -match 'CC_ASKPASS_PIPE is not set') "cc-askpass.exe exited $($run.Code): $($run.Err)"
    # The wrapper, with no real ssh to find.
    $run = Wait-Program (Start-Program (Join-Path $dir 'shim\ssh.exe') @('h') @{ PATH = $env:SystemRoot })
    Check ($run.Code -eq 255 -and $run.Err -match 'ssh: command not found') "shim\ssh.exe exited $($run.Code): $($run.Err)"
    Check (@(Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.tmp.exe').Count -eq 0) 'a temporary exe was left'
  }

  Test "a build removes a killed build's temporary exe" {
    $dir = Join-Path $tmp 'killed\same'
    $null = New-Item -ItemType Directory $dir
    $litter = Join-Path $dir 'cc-askpass.99999.tmp.exe'
    [IO.File]::WriteAllText($litter, 'half a build')
    $null = Invoke-Build $dir
    Check (-not (Test-Path -LiteralPath $litter)) 'the killed build left its temporary exe'
  }

  Test 'a build failure reaches stderr as UTF-8' {
    $missing = Join-Path $tmp ('' + [char]0x6E2C + [char]0x8A66 + '.cs')
    $buildArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $buildScript, $missing, (Join-Path $tmp 'nobuild'))
    $result = Wait-Program (Start-Program $powershell $buildArgs) 60000
    Check ($result.Code -eq 1) "the build exited $($result.Code)"
    Check ($result.Err.StartsWith('cc-askpass: build failed: ') -and $result.Err.Contains($missing)) "stderr is '$($result.Err)'"
  }

  Test 'the helper writes its errors as UTF-8' {
    $bad = '' + [char]0x6E2C + '\' + [char]0x8A66
    $result = Wait-Program (Start-Program $exe @('serve', $bad))
    Check ($result.Code -eq 1 -and $result.Err.Contains("invalid session id '$bad'")) "serve exited $($result.Code): '$($result.Err)'"
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

  Test 'a prompt reading reply is an askpass request' {
    # A server chooses the prompt text; only --reply runs the replier.
    $ask = Start-Ask 'reply' $serve
    $request = Read-Request $serve
    Check ($request.prompt -ceq 'reply') "prompt is '$($request.prompt)'"
    Send-Reply $serve $request.id 'r'
    $result = Wait-Program $ask
    Check ($result.Code -eq 0 -and $result.Out -ceq "r`n") "askpass exited $($result.Code) with '$($result.Out)'"
  }

  Test 'the listener names itself by its resolved path' {
    # A junction in the plugin path: the kernel names the listener and its clients by the target.
    $junction = Join-Path $tmp 'junction'
    $null = New-Item -ItemType Junction -Path $junction -Target (Split-Path -Parent $exe)
    try {
      $viaJunction = Join-Path $junction 'cc-askpass.exe'
      # Start-Serve checks that the ready line names $exe.
      $other = Start-Serve ('test-' + [guid]::NewGuid().ToString('N')) $viaJunction
      $ask = Start-Ask 'Password: ' $other $viaJunction
      $request = Read-Request $other
      Check ($request.client.exe -eq $exe) "client.exe is $($request.client.exe)"
      Send-Reply $other $request.id 'j'
      Check ((Wait-Program $ask).Out -ceq "j`n") 'askpass through the junction got the wrong reply'
      $other.P.Kill()
      $null = $other.P.WaitForExit(5000)
    } finally {
      # The link only: a recursive delete would follow it.
      [IO.Directory]::Delete($junction)
    }
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

  # The wrapper reads bin\ from the plugin root, four levels above its shim directory.
  $plug = Join-Path $tmp 'plug'
  $null = New-Item -ItemType Directory $plug
  Copy-Item -Recurse -LiteralPath (Join-Path $root 'bin') -Destination (Join-Path $plug 'bin')
  $helper = Invoke-Build (Join-Path $plug 'win\out\h')
  $shim = Join-Path $plug 'win\out\h\shim'
  $wrapper = Join-Path $shim 'ssh.exe'
  $fakebin = Join-Path $tmp 'fakebin'
  $null = New-Item -ItemType Directory $fakebin
  $fake = Join-Path $fakebin 'ssh.exe'
  Add-Type -TypeDefinition $fakeSource -OutputAssembly $fake -OutputType ConsoleApplication
  $runs = 0

  Test 'wrap decisions match the sh wrapper' {
    # The cases of expect_decision in tests/ssh.sh (relay.pid has no Windows counterpart) and a
    # few of its passes_through ones: want, variables, arguments.
    $cases = @(
      @('wrap', @{}, @('h', 'sudo', 'true')),
      @('no', @{}, @('h', '/usr/bin/git-upload-pack', 'x')),
      @('no', @{}, @('h', 'scp', '-t', '/x')),
      @('no', @{}, @('h', 'rsync', '--server', '-e.L', '.', '/x')),
      @('no', @{}, @('h', 'borg', 'serve', '--restrict-to-path', '/r')),
      @('wrap', @{}, @('h', 'sudo', 'rsync', '--server', '-e.L', '.', '/x')),
      @('no', @{ CC_ASKPASS_EXCLUDE = '*.internal' }, @('alice@db.internal', 'sudo', 'true')),
      @('no', @{ CC_ASKPASS_EXCLUDE = '*.internal' }, @('ssh://alice@db.internal:2222', 'sudo', 'true')),
      @('wrap', @{ CC_ASKPASS_EXCLUDE = '*.internal' }, @('alice@db.example', 'sudo', 'true')),
      @('no', @{ CC_ASKPASS_EXCLUDE = "x`nfe80::1" }, @('fe80::1', 'sudo', 'true')),
      @('no', @{ CC_ASKPASS_EXCLUDE = "x[`ndb[0-9].lan" }, @('db1.lan', 'sudo', 'true')),
      @('wrap', @{ CC_ASKPASS_EXCLUDE = "x[`ndb[!0-9].lan" }, @('db1.lan', 'sudo', 'true')),
      @('no', @{ CC_ASKPASS_PIPE = 'cc-askpass-test-nobody' }, @('h', 'sudo', 'true')),
      @('no', @{ SSH_ASKPASS = $null }, @('h', 'sudo', 'true')),
      @('no', @{ SSH_ASKPASS = 'C:\x' }, @('h', 'sudo', 'true')),
      @('no', @{ CC_ASKPASS_WRAP = $null }, @('h', 'sudo', 'true')),
      @('no', @{}, @('-N', 'h', 'sudo', 'true')),
      @('no', @{}, @('h', '-N', '-L', '1:a:2')),
      @('no', @{}, @('-o', 'User alice', 'h', 'sudo', 'true')),
      @('no', @{}, @('-oUser alice', 'h', 'sudo', 'true')),
      @('no', @{}, @('-o', "User`talice", 'h', 'sudo', 'true')),
      @('no', @{}, @('alice smith@h', 'sudo', 'true')),
      @('wrap', @{}, @('-o', 'User=alice', 'h', 'sudo', 'true')),
      @('wrap', @{}, @('h', '-o', 'User alice', 'sudo', 'true')),
      @('wrap', @{}, @('-tp22', 'h', 'sudo', 'true')),
      @('no', @{}, @('h')),
      @('no', @{}, @('-O', 'check', 'h')),
      @('no', @{}, @('-s', 'h', 'sftp')),
      @('no', @{}, @('-f', 'h', 'cmd')),
      @('no', @{}, @('-Z', 'h', 'cmd')),
      @('no', @{}, @('-o', 'ForkAfterAuthentication=YES', 'h', 'sudo', 'true')),
      @('no', @{}, @('h', '-o', 'StdinNull yes', 'sudo', 'true')),
      @('no', @{}, @('-o', 'sessiontype=none', 'h', 'sudo', 'true')),
      @('wrap', @{}, @('-o', 'SessionType=default', 'h', 'sudo', 'true')),
      @('wrap', @{}, @('-o', 'StdinNull=no', 'h', 'sudo', 'true')),
      @('no', @{}, @('git@github.com', 'git-upload-pack', 'a/b.git'))
    )
    foreach ($case in $cases) {
      $want, $vars, $argv = $case
      $run = Start-Wrapper $argv $vars
      $result = Wait-Program $run 10000
      $all = Get-Runs $run
      $label = "$want for $($argv -join ' ')"
      Check ($result.Code -eq 7 -and $result.Out -ceq "fake-out`n") "${label}: exited $($result.Code), stdout '$($result.Out)', stderr '$($result.Err)'"
      if ($want -eq 'wrap') {
        Check ($all.Count -eq 2 -and $all[0] -match 'serve-stdin') "${label}: no relay connection first: $(Get-Short $all)"
      } else {
        Check ($all.Count -eq 1) "${label}: $($all.Count) runs: $(Get-Short $all)"
      }
      Check (Test-Argv $all[-1] $argv) "${label}: the real ssh got $($all[-1])"
    }
  }

  Test 'arguments reach the real ssh unchanged' {
    $argv = @('-o', 'User a b', 'h', '*', '', 'a\\"b', 'trailing\\', 'a\\b', 'C:\\x\\y', "ls`n")
    $run = Start-Wrapper $argv
    $result = Wait-Program $run
    $all = Get-Runs $run
    Check ($all.Count -eq 1 -and (Test-Argv $all[0] $argv)) "the real ssh got $all"
    Check ($result.Code -eq 7 -and $result.Out -ceq "fake-out`n") "exited $($result.Code) with '$($result.Out)'"
  }

  Test 'remoteHosts off passes through' {
    $run = Start-Wrapper @('h', 'sudo', 'true') @{ CC_ASKPASS_WRAP = $null }
    $null = Wait-Program $run
    $all = Get-Runs $run
    Check ($all.Count -eq 1 -and (Test-Argv $all[0] @('h', 'sudo', 'true'))) "the real ssh got $all"
  }

  Test 'another cc-askpass shim on PATH is skipped' {
    $run = Start-Wrapper @('h') @{ PATH = "$shim;$(Join-Path $tmp 'out\b\shim');$fakebin" }
    $result = Wait-Program $run
    Check ($result.Code -eq 7 -and (Get-Runs $run).Count -eq 1) "exited $($result.Code): $($result.Err)"
  }

  Test 'a host that never says ready runs unwrapped' {
    $run = Start-Wrapper @('h', 'sudo', 'true') @{ FAKE_SSH_MODE = 'silent'; CC_ASKPASS_TEST_READY_MS = '500' }
    $result = Wait-Program $run 10000
    $all = Get-Runs $run
    Check ($all.Count -eq 2 -and $all[0] -match 'serve-stdin' -and (Test-Argv $all[1] @('h', 'sudo', 'true'))) "runs: $all"
    Check ($result.Code -eq 7) "exited $($result.Code): $($result.Err)"
  }

  Test 'relay request reaches the listener and the answer reaches R' {
    $password = "p&w|`"x^%!<y> " + [char]0xE9
    $run = Start-Wrapper @('server', 'sudo', 'true') @{ FAKE_SSH_MODE = 'relay' }
    $request = Read-Request $serve 10000
    Check ($request.client.exe -eq $wrapper) "client.exe is $($request.client.exe)"
    Check ($request.prompt -ceq '[sudo] password for bob: ') "prompt is '$($request.prompt)'"
    $relay = $request.relay
    Check ($relay.host -ceq 'server' -and $relay.realSsh -eq $fake -and $relay.remotePid -eq 77) "relay is $($relay | ConvertTo-Json -Compress)"
    Check ($relay.via -ceq 'server' -and $relay.reported -ceq 'sudo true') "relay is $($relay | ConvertTo-Json -Compress)"
    Check ($null -eq (Read-Line $serve 300)) 'a malformed line was relayed'
    Send-Reply $serve $request.id $password
    $result = Wait-Program $run 10000
    Check ($result.Code -eq 3) "exited $($result.Code): $($result.Err)"
    Check ($result.Out -ceq '') "stdout is '$($result.Out)'"

    $stdin = [IO.File]::ReadAllText("$($run.Log).stdin", $utf8)
    $lines = $stdin -split "`n"
    Check ($lines.Count -eq 3 -and $lines[2] -eq '') "R's stdin is '$stdin'"
    $payload = $lines[0] -split ' '
    Check ($payload.Count -eq 2) "payload line is '$($lines[0])'"
    $askpass = [IO.File]::ReadAllBytes((Join-Path $root 'bin\askpass'))
    Check ([Convert]::ToBase64String($askpass) -ceq $payload[0]) 'the payload does not carry bin\askpass'
    Check ($lines[1] -ceq "77`t$password") "R got '$($lines[1])'"

    $all = Get-Runs $run
    $r = @(($all[0] | ConvertFrom-Json).argv)
    # ssh joins the words of the remote command with spaces: A's one-line bootstrap shape.
    Check (($r -join ' ') -cmatch "^-o ClearAllForwardings=yes -x -a -T -- server env CCAP_RS_B64=[A-Za-z0-9+/=]+ /bin/sh -c 'eval .*' _ serve-stdin [0-9a-f]{32}$") "R ran $($all[0])"
    $b64 = [Convert]::ToBase64String($utf8.GetBytes('sudo true'))
    $c = @(($all[1] | ConvertFrom-Json).argv)
    Check ($c.Count -eq 7 -and $c[0] -ceq 'server' -and ($c[1..6] -join ' ') -cmatch "^env CCAP_DIR=(/tmp/cc-askpass-[0-9a-f]{32}) CCAP_CMD_B64=$([regex]::Escape($b64)) /bin/sh \1/remote.sh run$") "C ran $($all[1])"
  }

  Test 'killing the wrapper ends both connections; only C forwards' {
    $run = Start-Wrapper @('-L', '1:h:2', 'h', 'sleep', '60') @{ FAKE_SSH_MODE = 'sleep' }
    for ($i = 0; $i -lt 100 -and (Get-Runs $run).Count -lt 2; $i++) { Start-Sleep -Milliseconds 100 }
    $all = Get-Runs $run
    Check ($all.Count -eq 2) "C did not start: $all"
    # R would take C's forwards (and those of the config) first: C's own would not bind.
    $r = @(($all[0] | ConvertFrom-Json).argv)
    Check (($r -join ' ') -clike '-o ClearAllForwardings=yes -L 1:h:2 -x -a -T -- h env *') "R ran $($all[0])"
    $c = @(($all[1] | ConvertFrom-Json).argv)
    Check (($c[0..2] -join ' ') -ceq '-L 1:h:2 h') "C ran $($all[1])"
    $run.P.Kill()
    $deadline = (Get-Date).AddSeconds(2)
    do {
      $left = @(Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $fake })
      if ($left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    Check ($left.Count -eq 0) "$($left.Count) fake ssh processes are left"
  }

  Test 'killing a pass-through wrapper ends its ssh unless ssh forks' {
    $cases = @(
      @($false, @('-N', '-L', '1:h:2', 'h')),
      @($false, @('h', 'sleep', '60')),
      @($true, @('-f', 'h', 'sleep', '60')),
      @($true, @('-o', 'ForkAfterAuthentication=yes', 'h', 'sleep', '60'))
    )
    foreach ($case in $cases) {
      $forks, $argv = $case
      $run = Start-Wrapper $argv @{ FAKE_SSH_MODE = 'sleep'; CC_ASKPASS_WRAP = $null }
      for ($i = 0; $i -lt 100 -and (Get-Runs $run).Count -lt 1; $i++) { Start-Sleep -Milliseconds 100 }
      Check ((Get-Runs $run).Count -eq 1) "ssh did not start for $argv"
      $run.P.Kill()
      $deadline = (Get-Date).AddSeconds(2)
      do {
        Start-Sleep -Milliseconds 100
        $left = @(Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $fake })
      } while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
      if ($forks) {
        Check ($left.Count -eq 1) "a forking ssh did not outlive the wrapper for $argv"
        foreach ($process in $left) { $process.Kill(); $null = $process.WaitForExit(5000) }
      } else {
        Check ($left.Count -eq 0) "$($left.Count) fake ssh processes are left for $argv"
      }
    }
  }

  Test 'a pass-through ssh that ends leaves its background ssh running' {
    $run = Start-Wrapper @('h') @{ FAKE_SSH_MODE = 'spawn'; CC_ASKPASS_WRAP = $null }
    Check $run.P.WaitForExit(5000) 'the wrapper did not end'
    Check ($run.P.ExitCode -eq 7) "the wrapper exited $($run.P.ExitCode): $(Get-Stderr $run)"
    for ($i = 0; $i -lt 50 -and (Get-Runs $run).Count -lt 2; $i++) { Start-Sleep -Milliseconds 100 }
    # Long enough for a job closing with the wrapper to have ended it.
    Start-Sleep -Milliseconds 500
    $left = @(Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $fake })
    foreach ($process in $left) { $process.Kill(); $null = $process.WaitForExit(5000) }
    Check ($left.Count -eq 1) "$($left.Count) background ssh processes outlived the wrapper"
    Check ((Get-Stderr $run) -notmatch 'job object') "a pass-through warned: $(Get-Stderr $run)"
  }

  Test 'an R that stops reading cannot hold the wrapper' {
    # R says ready but never reads its stdin, so the payload write blocks; C ends at once.
    $run = Start-Wrapper @('h', 'true') @{ FAKE_SSH_MODE = 'deaf' }
    $result = Wait-Program $run 10000
    Check ($result.Code -eq 5) "exited $($result.Code): $($result.Err)"
  }

  Test 'no real ssh fails with 255' {
    $result = Wait-Program (Start-Wrapper @('h', 'true') @{ PATH = "$shim;$env:SystemRoot\System32" })
    Check ($result.Code -eq 255) "exited $($result.Code)"
    Check ($result.Err.Trim() -ceq 'cc-askpass: ssh: command not found') "stderr is '$($result.Err)'"
  }

  # An MSYS ssh (Git's) reads its command line itself: a stand-in is Git's echo.exe with the DLLs
  # it needs, which prints its arguments joined by spaces, as ssh joins a remote command.
  $gitBin = Join-Path $env:ProgramFiles 'Git\usr\bin'
  if (Test-Path -LiteralPath (Join-Path $gitBin 'msys-2.0.dll')) {
    $msysbin = Join-Path $tmp 'msysbin'
    $null = New-Item -ItemType Directory $msysbin
    Copy-Item -LiteralPath (Join-Path $gitBin 'echo.exe') -Destination (Join-Path $msysbin 'ssh.exe')
    foreach ($dll in 'msys-2.0.dll', 'msys-intl-8.dll', 'msys-iconv-2.dll') {
      Copy-Item -LiteralPath (Join-Path $gitBin $dll) -Destination $msysbin
    }
    $msysVars = @{ PATH = "$shim;$msysbin"; CC_ASKPASS_WRAP = $null }

    Test 'an MSYS ssh gets backslashes and quotes intact' {
      # Not \\server\share: MSYS looks such a word up on the network as it starts (seconds for no server).
      $argv = @('h', 'a\\b', 'C:\\x\\y', 'x\\\y\\', 'q"uo\"te', 'it''s *', "ls`n")
      $result = Wait-Program (Start-Wrapper $argv $msysVars)
      Check ($result.Out -ceq (($argv -join ' ') + "`n")) "echo printed '$($result.Out)': $($result.Err)"
    }

    Test 'a long remote command reaches an MSYS ssh whole' {
      # Many short pieces; and a long space-free run that may go bare inside a word that may not.
      foreach ($command in ('ab\c "d" ' * 2000).TrimEnd(), ('printf %s ' + ('x' * 9000) + ' | wc -c')) {
        $run = Start-Wrapper @('h', $command) $msysVars
        # Read while it runs: the output is more than a pipe holds.
        $out = $run.P.StandardOutput.ReadToEndAsync()
        Check ($run.P.WaitForExit(10000) -and $out.Wait(5000)) 'the wrapper did not end'
        Check ($run.P.ExitCode -eq 0 -and $out.Result -ceq "h $command`n") "echo printed $($out.Result.Length) characters: $(Get-Stderr $run)"
      }
    }

    Test 'an argument too long for an MSYS ssh runs nothing' {
      foreach ($argv in @(@('h', (('x' * 9000) + '*')), @('-o', ('User=' + ('y' * 9000) + '*'), 'h', 'true'))) {
        $result = Wait-Program (Start-Wrapper $argv $msysVars)
        Check ($result.Code -eq 255 -and $result.Out -ceq '') "exited $($result.Code) with '$($result.Out)'"
        Check ($result.Err -match 'too long.*nothing was run') "stderr is '$($result.Err)'"
      }
    }
  } else {
    'SKIP: no Git for Windows MSYS runtime, so no MSYS ssh tests'
  }

  # Optional: CC_ASKPASS_TEST_SSH names a reachable host with key login, e.g.
  # 'gonetone@127.0.0.1 -p 2299 -i C:\key -o StrictHostKeyChecking=no'.
  if ($env:CC_ASKPASS_TEST_SSH) {
    Test 'end to end through a real sshd' {
      $target = $env:CC_ASKPASS_TEST_SSH -split ' '
      $vars = @{ PATH = "$shim;$env:PATH" }
      $result = Wait-Program (Start-Wrapper ($target + 'echo ok') $vars) 60000
      Check ($result.Code -eq 0 -and $result.Out -match '^ok\r?\n$') "exited $($result.Code) with '$($result.Out)': $($result.Err)"
      $result = Wait-Program (Start-Wrapper ($target + 'printf %s "$SUDO_ASKPASS"') $vars) 60000
      Check ($result.Out -cmatch '/cc-askpass-[0-9a-f]{32}/askpass$') "SUDO_ASKPASS is '$($result.Out)': $($result.Err)"
      # Git's ssh (MSYS) cuts a quoted argument at 8,186 characters; the command travels as base64.
      $long = 'x' * 9000
      $result = Wait-Program (Start-Wrapper ($target + "printf %s $long | wc -c") $vars) 60000
      Check ($result.Out.Trim() -ceq '9000') "a long command printed '$($result.Out)': $($result.Err)"
      $run = Start-Wrapper ($target + '"$SUDO_ASKPASS" "remote pw: "') $vars
      $request = Read-Request $serve 30000
      Check ($request.prompt -ceq 'remote pw: ' -and $request.relay.host -ceq '127.0.0.1') "request is $($request | ConvertTo-Json -Compress)"
      Send-Reply $serve $request.id 'e2e pw'
      $result = Wait-Program $run 30000
      Check ($result.Code -eq 0 -and $result.Out -ceq "e2e pw`n") "the remote askpass printed '$($result.Out)': $($result.Err)"
    }
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
  # The fake ssh runs as the wrapper's child, not ours: a failed test may leave it behind.
  Get-Process ssh -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$tmp\*" } | ForEach-Object {
    try { $_.Kill() } catch { }
  }
  # A killed exe stays locked for a moment.
  for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $tmp); $i++) {
    try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { Start-Sleep -Milliseconds 250 }
  }
}
exit $code
