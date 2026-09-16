param([switch]$Start, [switch]$Classic, [switch]$Production)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '已创建 .env；请先填写私有 R2 配置，再按需填写文本与图片供应商配置。'
}
$environmentFile = if ($Production) { 'deploy/.env.production' } else { 'deploy/.env.local' }
$localConfig = Join-Path $projectRoot $environmentFile
if ($Production -and -not (Test-Path -LiteralPath $localConfig)) {
    throw '请从 deploy/.env.production.example 创建 deploy/.env.production 并填写真实 OIDC API audience、数据库密码及服务密钥；生产启动不使用本地免密码登录。'
}
New-Item -ItemType Directory -Path (Split-Path -Parent $localConfig) -Force | Out-Null
if (-not (Test-Path -LiteralPath 'deploy/engine.json')) {
    Copy-Item -LiteralPath 'deploy/engine.example.json' -Destination 'deploy/engine.json'
}
if (-not (Test-Path -LiteralPath $localConfig)) {
    $pgBytes = New-Object byte[] 24
    $authBytes = New-Object byte[] 48
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($pgBytes)
    $rng.GetBytes($authBytes)
    $rng.Dispose()
    $pgPassword = [Convert]::ToHexString($pgBytes).ToLowerInvariant()
    $authSecret = [Convert]::ToHexString($authBytes).ToLowerInvariant()
    $configuration = "APP_ENV=development`nPOSTGRES_PASSWORD=$pgPassword`nDEV_AUTH_SECRET=$authSecret`nDEV_AUTH=true`n"
    [IO.File]::WriteAllText($localConfig, $configuration, [Text.UTF8Encoding]::new($false))
    Write-Host '已生成仅供本地环境使用的隔离数据库密码与登录签名密钥。'
}
if (-not $Production -and -not (Select-String -LiteralPath $localConfig -Pattern '^APP_ENV=' -Quiet)) {
    [IO.File]::AppendAllText($localConfig, "`nAPP_ENV=development`n", [Text.UTF8Encoding]::new($false))
}
if (-not $Production -and -not (Select-String -LiteralPath $localConfig -Pattern '^ADMIN_WEB_PATH=' -Quiet)) {
    $entryBytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Fill($entryBytes)
    [IO.File]::AppendAllText($localConfig, "`nADMIN_WEB_PATH=/console-$([Convert]::ToHexString($entryBytes).ToLowerInvariant())/`n", [Text.UTF8Encoding]::new($false))
    Write-Host "已在 $environmentFile 生成固定后台入口 ADMIN_WEB_PATH。"
}
foreach ($tokenName in $(if ($Production) { @() } else { @('CLASSIC_ENGINE_TOKEN') })) {
    if (-not (Select-String -LiteralPath $localConfig -Pattern "^$tokenName=" -Quiet)) {
        $tokenBytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
        [IO.File]::AppendAllText($localConfig, "$tokenName=$([Convert]::ToHexString($tokenBytes))`n", [Text.UTF8Encoding]::new($false))
    }
}
if ($Production) {
    foreach ($required in @('APP_ENV=production', 'DEV_AUTH=false')) {
        if (-not (Select-String -LiteralPath $localConfig -Pattern "^$required\s*$" -Quiet)) {
            throw "生产环境文件必须显式设置 $required"
        }
    }
}
$previousEnvironmentFile = $env:COMICS_ENV_FILE
try {
    $env:COMICS_ENV_FILE = $environmentFile
    $composeArgs = @('compose', '--env-file', '.env', '--env-file', $environmentFile)
    if ($Production) { $composeArgs += @('--project-name', 'node-comics-production') }
    if ($Classic) { $composeArgs += @('--profile', 'classic') }
    & docker @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose 配置验证失败' }
    if ($Start) {
        if ($Production) {
            & docker @composeArgs build api
            if ($LASTEXITCODE -ne 0) { throw '生产后端镜像构建失败' }
            & docker @composeArgs run --rm --no-deps api python -m app.config --production
            if ($LASTEXITCODE -ne 0) { throw '生产身份或存储配置未通过启动校验；未启动服务' }
        }
        $startArgs = $composeArgs + @('up', '-d', '--build')
        if ($Classic -and (-not (Select-String -LiteralPath $localConfig -Pattern '^NODE_TOKEN=.+$' -Quiet) -or -not (Select-String -LiteralPath $localConfig -Pattern '^NODE_ID=.+$' -Quiet))) {
            $startArgs += @('api', 'control-worker', 'maintenance', 'classic-engine')
            Write-Host "后台添加翻译节点后，将 NODE_ID 与独立 NODE_TOKEN 写入 $environmentFile，再运行 -Start -Classic 启动代理。"
        }
        & docker @startArgs
        if ($LASTEXITCODE -ne 0) { throw 'Docker 启动失败' }
    }
} finally {
    $env:COMICS_ENV_FILE = $previousEnvironmentFile
}
