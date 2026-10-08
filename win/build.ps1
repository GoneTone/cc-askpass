# Compiles the Windows helper: build.ps1 <source> <outDir>
# Writes <outDir>\cc-askpass.exe and <outDir>\shim\ssh.exe, then removes older builds beside
# <outDir>. Run with Windows PowerShell 5.1: its Add-Type is the .NET Framework C# compiler.
param([string]$Source, [string]$OutDir)
$ErrorActionPreference = 'Stop'

try {
  if (-not $Source -or -not $OutDir) { throw 'usage: build.ps1 <source> <outDir>' }
  $OutDir = [IO.Path]::GetFullPath($OutDir)
  $null = New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'shim')
  $tmp = Join-Path $OutDir 'cc-askpass.tmp.exe'
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 -LiteralPath $Source) -OutputAssembly $tmp `
    -OutputType ConsoleApplication -ReferencedAssemblies System.Core
  # The shim first and the rename last: an existing cc-askpass.exe means a complete build.
  Copy-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'shim\ssh.exe') -Force
  Move-Item -LiteralPath $tmp -Destination (Join-Path $OutDir 'cc-askpass.exe') -Force

  # Only directories that hold build files: a mistaken <outDir> must not empty its parent.
  $buildFiles = 'cc-askpass.exe', 'shim\ssh.exe', 'cc-askpass.tmp.exe'
  Get-ChildItem -LiteralPath (Split-Path -Parent $OutDir) -Directory |
    Where-Object {
      $dir = $_.FullName
      $dir -ne $OutDir -and ($buildFiles | Where-Object { Test-Path -LiteralPath (Join-Path $dir $_) })
    } |
    Where-Object {
      # A build another session still runs stays whole: its shim\ssh.exe goes with its listener.
      -not (Get-ChildItem -LiteralPath $_.FullName -Recurse -File | Where-Object {
        try { [IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'None').Dispose(); $false } catch { $true }
      })
    } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  exit 0
} catch {
  [Console]::Error.WriteLine('cc-askpass: build failed: ' + ($_.Exception.Message -replace '\s+', ' '))
  exit 1
}
