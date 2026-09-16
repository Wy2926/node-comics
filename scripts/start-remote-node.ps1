param([string]$Directory = 'private-test-data/production-node', [switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nodeDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot $Directory))
if ($Stop) {
    if (-not (Test-Path -LiteralPath $nodeDirectory -PathType Container)) { throw 'Node directory does not exist' }
    [IO.File]::WriteAllText((Join-Path $nodeDirectory 'node.stop'), '')
    Write-Host '已请求停止新领取；当前阶段交付后关闭代理和引擎。'
    return
}
$python = Join-Path $projectRoot 'backend/.venv/Scripts/python.exe'
& $python (Join-Path $PSScriptRoot 'run_remote_node.py') --directory $nodeDirectory
if ($LASTEXITCODE -ne 0) { throw 'Remote compute node stopped with an error' }
