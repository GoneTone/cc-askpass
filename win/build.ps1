# Compiles the Windows helper: build.ps1 <source> <outDir>
# Writes <outDir>\cc-askpass.exe and <outDir>\shim\ssh.exe, then removes older builds beside
# <outDir>. Run with Windows PowerShell 5.1: its Add-Type is the .NET Framework C# compiler.
param([string]$Source, [string]$OutDir)
$ErrorActionPreference = 'Stop'

try {
  if (-not $Source -or -not $OutDir) { throw 'usage: build.ps1 <source> <outDir>' }
  $OutDir = [IO.Path]::GetFullPath($OutDir)
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'shim')
  # Sessions starting at once build the same source into the same directory: one at a time, and a
  # build that finds another's finished exe is done.
  $mutex = New-Object Threading.Mutex($false, ('Local\cc-askpass-build-' + (Split-Path -Leaf $OutDir)))
  try {
    if (-not $mutex.WaitOne(120000)) { throw "another build into $OutDir did not finish" }
  } catch [Threading.AbandonedMutexException] {
    # Its holder died; the mutex is now ours.
  }
  try {
    # A build killed mid-way (the mod gives it 60 s) leaves its temporary exe; holding the mutex,
    # no other build is writing one.
    Get-ChildItem -LiteralPath $OutDir -Filter 'cc-askpass.*.tmp.exe' -File |
      Remove-Item -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath (Join-Path $OutDir 'cc-askpass.exe'))) {
      $tmp = Join-Path $OutDir "cc-askpass.$PID.tmp.exe"
      Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 -LiteralPath $Source) -OutputAssembly $tmp `
        -OutputType ConsoleApplication -ReferencedAssemblies System.Core
      # The shim first and the rename last: an existing cc-askpass.exe means a complete build.
      Copy-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'shim\ssh.exe') -Force
      Move-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'cc-askpass.exe') -Force
    }
  } finally {
    $mutex.ReleaseMutex()
  }
} catch {
  # UTF-8, as the mod reads it: the console's code page cannot carry every path or message.
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes(
    'cc-askpass: build failed: ' + ($_.Exception.Message -replace '\s+', ' ') + "`n")
  $stderr = [Console]::OpenStandardError()
  $stderr.Write($bytes, 0, $bytes.Length)
  $stderr.Flush()
  exit 1
}

# Older builds beside <outDir>: the build is done, so nothing here may fail it.
try {
  Get-ChildItem -LiteralPath (Split-Path -Parent $OutDir) -Directory |
    Where-Object {
      # Only directories that hold build files: a mistaken <outDir> must not empty its parent.
      $dir = $_.FullName
      $dir -ne $OutDir -and ((Test-Path -LiteralPath (Join-Path $dir 'cc-askpass.exe')) -or
        (Test-Path -LiteralPath (Join-Path $dir 'shim\ssh.exe')) -or
        (Get-ChildItem -LiteralPath $dir -Filter 'cc-askpass*.tmp.exe' -File -ErrorAction SilentlyContinue))
    } |
    Where-Object {
      # A build another session still runs stays whole: its shim\ssh.exe goes with its listener.
      -not (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
        try { [IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'None').Dispose(); $false } catch { $true }
      })
    } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
} catch {
}
exit 0
