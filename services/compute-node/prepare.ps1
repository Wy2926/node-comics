[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Root, [ValidateSet('cuda','amd')][string]$Backend)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nodeRoot = [IO.Path]::GetFullPath($Root)
$work = Join-Path $nodeRoot '.setup'
$tempPath = Join-Path $work 'tmp'
New-Item -ItemType Directory -Force -Path $tempPath | Out-Null
# Child-process settings only; never User/Machine settings.
$env:TEMP = $tempPath
$env:TMP = $tempPath
. (Join-Path $PSScriptRoot 'bootstrap.ps1')
$tools = Initialize-NodeTools (Join-Path $PSScriptRoot 'toolchain.lock.json') $work
& $tools.Python -I -B (Join-Path $PSScriptRoot 'portable_install.py') --root $nodeRoot --run $tools.Run --uv $tools.Uv --backend $Backend
if ($LASTEXITCODE -ne 0) { throw "Preparation failed (exit $LASTEXITCODE). Verified downloads are kept for retry." }
