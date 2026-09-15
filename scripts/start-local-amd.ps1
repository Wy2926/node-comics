param([switch]$Setup, [switch]$Smoke)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$enginePython = Join-Path $projectRoot 'services/classic-engine/.venv/Scripts/python.exe'
$backendPython = Join-Path $projectRoot 'backend/.venv/Scripts/python.exe'
if ($Setup) {
    if (-not (Test-Path -LiteralPath $enginePython)) {
        python -m venv services/classic-engine/.venv
        if ($LASTEXITCODE -ne 0) { throw 'Engine virtual environment creation failed' }
    }
    & $enginePython -m pip install --timeout 180 -r services/classic-engine/requirements-directml.txt
    if ($LASTEXITCODE -ne 0) { throw 'Engine dependency installation failed' }
    if (-not (Test-Path -LiteralPath $backendPython)) {
        python -m venv backend/.venv
        if ($LASTEXITCODE -ne 0) { throw 'Backend virtual environment creation failed' }
    }
    & $backendPython -m pip install --timeout 180 -r backend/requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed' }
    & $enginePython services/classic-engine/prepare_native.py
    if ($LASTEXITCODE -ne 0) { throw 'Native model preparation failed' }
}
if (-not (Test-Path -LiteralPath $enginePython) -or -not (Test-Path -LiteralPath $backendPython)) {
    throw 'Run this script with -Setup first; Python 3.11 and Git are required.'
}
$runArgs = @('scripts/run_local_amd.py')
if ($Smoke) { $runArgs += '--smoke' }
& $backendPython @runArgs
if ($LASTEXITCODE -ne 0) { throw 'Local AMD cluster stopped with an error' }
