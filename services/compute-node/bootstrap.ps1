# Shared developer/portable bootstrap; only the dedicated work directory is written.
function Initialize-NodeTools([string]$LockFile, [string]$WorkDirectory) {
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
    $toolchain = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json
    $downloads = Join-Path $WorkDirectory 'downloads'
    $run = Join-Path $WorkDirectory ('run-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Force -Path $downloads,$run | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    function Get-FileDigest([string]$path) {
        $stream = [IO.File]::OpenRead($path)
        $hash = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $hash.Dispose() }
    }
    function Get-VerifiedArchive($asset, [string]$name) {
        $target = Join-Path $downloads $name
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Host "Downloading pinned $name"
            Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile ($target + '.partial')
            if ((Get-FileDigest ($target + '.partial')) -ne $asset.sha256) { throw "Download checksum mismatch: $name" }
            Move-Item -LiteralPath ($target + '.partial') -Destination $target
        }
        if ((Get-FileDigest $target) -ne $asset.sha256) { throw "Cached archive checksum mismatch: $name" }
        return $target
    }
    $uvArchive = Get-VerifiedArchive $toolchain.uv 'uv.zip'
    $pythonArchive = Get-VerifiedArchive $toolchain.python 'python.tar.gz'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $uvRoot = Join-Path $run 'uv'
    $zip = [IO.Compression.ZipFile]::OpenRead($uvArchive)
    try {
        foreach ($entry in $zip.Entries) {
            $path = [IO.Path]::GetFullPath((Join-Path $uvRoot $entry.FullName))
            if (-not $path.StartsWith($uvRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe tool archive entry.' }
        }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($uvArchive, $uvRoot)
    $tar = Join-Path $env:SystemRoot 'System32/tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { throw 'Windows tar.exe is required (Windows 10 1803 or newer).' }
    $entries = & $tar -tzf $pythonArchive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Python archive.' }
    foreach ($entry in $entries) {
        if (-not $entry.StartsWith('python/') -or $entry -match '(^|/)\.\.(/|$)' -or $entry.Contains('\')) { throw 'Unsafe Python archive entry.' }
    }
    & $tar -xzf $pythonArchive -C $run
    if ($LASTEXITCODE -ne 0) { throw 'Cannot extract pinned Python runtime.' }
    $uv = Join-Path $uvRoot 'uv.exe'
    if (-not (Test-Path -LiteralPath $uv)) { throw 'Pinned uv archive has unexpected layout.' }
    return @{ Run = $run; Python = (Join-Path $run 'python/python.exe'); Uv = $uv }
}
