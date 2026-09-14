param([switch]$Start, [switch]$Classic)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '已创建 .env；请填写图片模型配置以启用真实 AI 重绘。'
}
$localConfig = Join-Path $projectRoot 'deploy/.env.local'
New-Item -ItemType Directory -Path (Split-Path -Parent $localConfig) -Force | Out-Null
if (-not (Test-Path -LiteralPath $localConfig)) {
    $pgBytes = New-Object byte[] 24
    $authBytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($pgBytes)
    $rng.GetBytes($authBytes)
    $rng.Dispose()
    $pgPassword = [Convert]::ToHexString($pgBytes).ToLowerInvariant()
    $authSecret = [Convert]::ToHexString($authBytes).ToLowerInvariant()
    $configuration = "POSTGRES_PASSWORD=$pgPassword`nDEV_AUTH_SECRET=$authSecret`nDEV_AUTH=true`n"
    [IO.File]::WriteAllText($localConfig, $configuration, [Text.UTF8Encoding]::new($false))
    Write-Host '已生成仅供本地环境使用的隔离数据库密码与登录签名密钥。'
}
if (-not (Select-String -LiteralPath $localConfig -Pattern '^CLASSIC_ENGINE_TOKEN=' -Quiet)) {
    $engineBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Fill($engineBytes)
    [IO.File]::AppendAllText($localConfig, "CLASSIC_ENGINE_TOKEN=$([Convert]::ToHexString($engineBytes))`n", [Text.UTF8Encoding]::new($false))
}
docker compose --env-file .env --env-file deploy/.env.local config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose 配置验证失败' }
if ($Start) {
    $composeArgs = @('compose', '--env-file', '.env', '--env-file', 'deploy/.env.local')
    if ($Classic) { $composeArgs += @('--profile', 'classic') }
    $composeArgs += @('up', '-d', '--build')
    & docker @composeArgs
    if ($LASTEXITCODE -ne 0) { throw 'Docker 启动失败' }
}
