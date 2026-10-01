param([switch]$Start)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '已创建 .env；请检查本地文件存储容量，再按需填写图片供应商配置；文本供应商在管理后台设置。'
}
$environmentFile = 'deploy/.env.local'
$localConfig = Join-Path $projectRoot $environmentFile
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
    $configuration = "APP_ENV=development`nPOSTGRES_PASSWORD=$pgPassword`nDEV_AUTH_SECRET=$authSecret`nDEV_AUTH=true`n"
    [IO.File]::WriteAllText($localConfig, $configuration, [Text.UTF8Encoding]::new($false))
    Write-Host '已生成仅供本地环境使用的隔离数据库密码与登录签名密钥。'
}
if (-not (Select-String -LiteralPath $localConfig -Pattern '^APP_ENV=' -Quiet)) {
    [IO.File]::AppendAllText($localConfig, "`nAPP_ENV=development`n", [Text.UTF8Encoding]::new($false))
}
if (-not (Select-String -LiteralPath $localConfig -Pattern '^ADMIN_WEB_PATH=' -Quiet)) {
    $entryBytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Fill($entryBytes)
    [IO.File]::AppendAllText($localConfig, "`nADMIN_WEB_PATH=/console-$([Convert]::ToHexString($entryBytes).ToLowerInvariant())/`n", [Text.UTF8Encoding]::new($false))
    Write-Host "已在 $environmentFile 生成固定后台入口 ADMIN_WEB_PATH。"
}
if (-not (Select-String -LiteralPath $localConfig -Pattern '^APP_ENV=development\s*$' -Quiet)) {
    throw 'bootstrap 仅用于本地开发；服务器部署使用 deploy/compose.server.yaml 和统一数据库／Redis。'
}
$previousEnvironmentFile = $env:COMICS_ENV_FILE
try {
    $env:COMICS_ENV_FILE = $environmentFile
    $composeArgs = @('compose', '--env-file', '.env', '--env-file', $environmentFile)
    & docker @composeArgs config --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose 配置验证失败' }
    if ($Start) {
        foreach ($module in @('backend/website', 'backend/admin-ui')) {
            & npm --prefix $module ci
            if ($LASTEXITCODE -ne 0) { throw "$module 依赖安装失败" }
            & npm --prefix $module run build
            if ($LASTEXITCODE -ne 0) { throw "$module 静态构建失败" }
        }
        & docker @composeArgs build api
        if ($LASTEXITCODE -ne 0) { throw '后端镜像构建失败' }
        & docker @composeArgs up -d --wait postgres redis
        if ($LASTEXITCODE -ne 0) { throw '本地基础设施未就绪' }
        & docker @composeArgs run --rm migrate
        if ($LASTEXITCODE -ne 0) { throw '显式数据库迁移失败；未启动应用' }
        $startArgs = $composeArgs + @('up', '-d', '--no-build')
        & docker @startArgs
        if ($LASTEXITCODE -ne 0) { throw 'Docker 启动失败' }
    }
} finally {
    $env:COMICS_ENV_FILE = $previousEnvironmentFile
}
