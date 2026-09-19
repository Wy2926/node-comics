param(
    [string]$TextModel = 'gpt-5.6-luna',
    [ValidateSet('responses', 'chat_completions')][string]$TextProtocol = 'responses'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
$controlPython = [IO.Path]::GetFullPath((Join-Path $projectRoot 'backend/.venv/Scripts/python.exe'))
$nodePython = [IO.Path]::GetFullPath((Join-Path $projectRoot 'services/classic-engine/.venv-ncnn/Scripts/python.exe'))
foreach ($runtime in @($controlPython, $nodePython)) {
    if (-not (Test-Path -LiteralPath $runtime)) { throw 'Prepare the backend and classic-engine Python environments first.' }
}
& $controlPython scripts/local_classic.py prepare
if ($LASTEXITCODE -ne 0) { throw 'Local classic preflight failed' }
$previousEnvironmentFile = $env:COMICS_ENV_FILE
try {
    $env:COMICS_ENV_FILE = 'deploy/.env.classic-local'
    $composeArgs = @('compose', '--project-name', 'node-comics-classic-local',
        '--env-file', '.env', '--env-file', 'deploy/.env.local', '--env-file', 'deploy/.env.classic-local',
        '-f', 'compose.yaml', '-f', 'deploy/compose.classic-local.yaml')
    & docker @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Classic Compose validation failed' }
    & docker @composeArgs up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Control services failed to start' }
} finally {
    $env:COMICS_ENV_FILE = $previousEnvironmentFile
}
& $controlPython scripts/local_classic.py provision --text-model $TextModel --text-protocol $TextProtocol
if ($LASTEXITCODE -ne 0) { throw 'Node/provider provisioning failed' }
$pidFile = Join-Path $projectRoot 'data/classic-local/node.pid'
$running = $null
if (Test-Path -LiteralPath $pidFile) {
    $savedProcessId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId"
    if ($candidate -and $candidate.ExecutablePath -eq $nodePython -and $candidate.CommandLine -match '-m classic_node run') {
        $running = $candidate
    } elseif ($candidate) {
        throw 'Saved node PID belongs to another process; inspect data/classic-local/node.pid before retrying'
    }
}
if (-not $running) {
    $node = Start-Process -FilePath $nodePython -ArgumentList @('-m', 'classic_node', 'run', '--config', 'node.local.json') `
        -WorkingDirectory (Join-Path $projectRoot 'services/classic-engine') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $projectRoot 'data/classic-local/node.stdout.log') `
        -RedirectStandardError (Join-Path $projectRoot 'data/classic-local/node.stderr.log')
    [IO.File]::WriteAllText($pidFile, [string]$node.Id)
}
& $controlPython scripts/local_classic.py ready
if ($LASTEXITCODE -ne 0) { throw 'Local service readiness failed' }
