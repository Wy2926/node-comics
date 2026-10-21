# Windows-only build bootstrap. Node operators use node.exe, not this script.
[CmdletBinding()]
param(
    [string]$Version = '0.1.0',
    [string]$OutputDirectory,
    [string]$WorkDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version.' }
$moduleRoot = $PSScriptRoot
if (-not $WorkDirectory) { $WorkDirectory = Join-Path $moduleRoot '.build' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $moduleRoot 'artifacts/dist/NodeComicsNode' }
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output already exists; choose a new directory.' }
New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
$lockStream = [IO.File]::Open((Join-Path $WorkDirectory 'build.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    . (Join-Path $moduleRoot 'bootstrap.ps1')
    $tools = Initialize-NodeTools (Join-Path $moduleRoot 'toolchain.lock.json') $WorkDirectory
    & $tools.Python -I -B (Join-Path $moduleRoot 'build_release.py') --output $OutputDirectory --version $Version --work $WorkDirectory --run $tools.Run --uv $tools.Uv --zip
    if ($LASTEXITCODE -ne 0) { throw "Release build failed (exit $LASTEXITCODE). Inspect the preceding stage output." }
} finally {
    $lockStream.Dispose()
}
