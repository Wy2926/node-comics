# Windows PowerShell 5.1+. Preview by default; -Apply performs deletion.
[CmdletBinding()]
param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$comparison = [StringComparison]::OrdinalIgnoreCase
$artifactRoots = @('artifacts', 'services/classic-engine/artifacts', 'services/compute-node/artifacts')
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps/extension/wxt.config.ts'))) {
    throw 'Keep this script in the node-comics scripts directory.'
}
$gitRoot = & git -C $repoRoot rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::GetFullPath($gitRoot).Equals($repoRoot, $comparison)) {
    throw 'The script must belong to the repository root, not a copied subdirectory.'
}
$trackedFiles = @(& git -C $repoRoot -c core.quotepath=false ls-files -- $artifactRoots)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect tracked files.' }

function Assert-SafePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $allowed = $false
    foreach ($root in $artifactRoots) {
        $prefix = [IO.Path]::GetFullPath((Join-Path $repoRoot $root)) + '\'
        if ($absolute.StartsWith($prefix, $comparison)) { $allowed = $true; break }
    }
    if (-not $allowed) { throw "Outside the allowed artifact directories: $absolute" }
    # Check ancestors without resolving/traversing a junction. The leaf may itself be a link.
    for ($parent = Split-Path -Parent $absolute; $parent; $parent = Split-Path -Parent $parent) {
        if (([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Ancestor is a junction or symbolic link: $parent"
        }
    }
    return $absolute
}

function Get-TreeSize([string]$Path) {
    [long]$bytes = 0
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    while ($pending.Count) {
        $current = $pending.Pop()
        $attributes = [IO.File]::GetAttributes($current)
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($attributes -band [IO.FileAttributes]::Directory) {
            foreach ($item in [IO.DirectoryInfo]::new($current).GetFileSystemInfos()) {
                $pending.Push($item.FullName)
            }
        } else { $bytes += [IO.FileInfo]::new($current).Length }
    }
    return $bytes
}

function Remove-ArtifactTree([string]$Path) {
    # Enumerate one level at a time; never follow links, including nested junctions.
    $safePath = Assert-SafePath $Path
    $attributes = [IO.File]::GetAttributes($safePath)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($attributes -band [IO.FileAttributes]::Directory) {
            [IO.Directory]::Delete($safePath, $false)
        } else { [IO.File]::Delete($safePath) }
    } elseif ($attributes -band [IO.FileAttributes]::Directory) {
        foreach ($item in [IO.DirectoryInfo]::new($safePath).GetFileSystemInfos()) {
            Remove-ArtifactTree $item.FullName
        }
        [IO.File]::SetAttributes($safePath, [IO.FileAttributes]::Directory)
        [IO.Directory]::Delete($safePath, $false)
    } else {
        [IO.File]::SetAttributes($safePath, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($safePath)
    }
}

# Reviewed test outputs, superseded builds and one-time investigations only.
$suites = @(
    @{Root = 'artifacts'; Names = @(
        'admin-completion', 'billing-integration', 'catalog-sync', 'chapter-imports',
        'classic-live', 'comicpash-validation', 'comix-chapter-6887743', 'comix-reader-6887743',
        'comix-validation', 'compute-v2', 'dm5-investigation', 'dm5-validation',
        'drive-mobi-import-fix', 'drive-mobi-performance', 'drive-oauth-deploy', 'drive-oauth-prompt-fix',
        'extension-download', 'firefox-permission-popup', 'git-delivery', 'guazimanhua',
        'history-validation', 'image-dedup-research', 'import-validation', 'inline-validation',
        'lettering-languages', 'mangacopy-http', 'mangacopy-validation', 'membership-updates',
        'mtu-live-login', 'naver', 'naver-validation', 'node-clean-02', 'node-rebuild',
        'paddle', 'perf-diagnosis', 'reader-retry-validation', 'reader-ui-validation',
        'reading-api-validation', 'reading-contract', 'reading-plans-validation',
        'reading-translations-validation', 'real-image-verification', 'release-0.2.0-mobi',
        'release-0.2.0-platforms', 'source-architecture', 'source-boundaries', 'source-covers',
        'translation-channel-host', 'translation-channel-live', 'translation-channels-validation',
        'vps-deploy-20260919', 'amd-probe.py', 'check-docs.py', 'check_current_docs.py',
        'clean_current_specs.py', 'debug-amd-render.py', 'direct-upload-live-acceptance.py',
        'direct-upload-live-report.json', 'direct-upload-r2-contract.json', 'finalize_docs.py',
        'migrate_engine_clients.py', 'mtu-live-login.mjs', 'pipeline-live-acceptance.py',
        'pipeline-live-before-ipv4.json', 'pipeline-live-report.json', 'pipeline-loopback-probe.json',
        'probe-pipeline.py', 'probe_amd_decoder_shadow.py', 'probe_amd_decoder_shadow_fixed.py',
        'probe_amd_full_gpu_fixed.py', 'probe_amd_full_gpu_warm.py', 'probe_amd_gpu_decoder.py',
        'probe_lama_crop_processes.py', 'probe_single_page.py', 'profile_amd_components.py',
        'profile_panels.py', 'shrink_engine.py', 'simplify_docs.py', 'simplify_module_docs.py'
    )},
    @{Root = 'services/classic-engine/artifacts'; Names = @(
        'lama-validation', 'managed-node-validation', 'task-tests', 'v2-smoke'
    )},
    @{Root = 'services/compute-node/artifacts'; Names = @(
        'acceptance-utf8', 'assets', 'clean-build', 'toolchain-research',
        'cleanup-old-builds.ps1', 'runtime-requirements.txt'
    )},
    @{Root = 'artifacts/firefox-release-2026-09-25'; Names = @(
        'source-rebuild', 'build.log', 'fetch-store.py', 'lint.json', 'nodelane-comics-0.1.0-signed.xpi',
        'package-checks.json', 'prepare-release.py', 'source-install.log', 'source-rebuild-check.json',
        'source-rebuild.log', 'store-package.json'
    )},
    @{Root = 'artifacts/marketing/2026-09-24'; Names = @(
        'deploy-aeca65a84993', 'deploy-website-aeca65a.py', 'deploy-website.py',
        'live-design-tokens.css', 'production-0.2.0.zip', 'public-release-0.1.1.zip',
        'public-deployment-checks.json', 'website-aeca65a84993.tar.gz',
        'website-build-publish.log', 'website-build.log', 'website-tests-publish.log', 'website-tests.log'
    )}
)
$candidates = [Collections.Generic.List[string]]::new()
foreach ($suite in $suites) {
    foreach ($name in $suite.Names) { $candidates.Add((Join-Path (Join-Path $repoRoot $suite.Root) $name)) }
}
# Preserve the final node release, removing its separate rebuild/test workspace.
$nodeRun = Join-Path $repoRoot 'artifacts/node-clean-03'
if (Test-Path -LiteralPath $nodeRun) {
    $null = Assert-SafePath $nodeRun
    if ([IO.File]::GetAttributes($nodeRun) -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The node rebuild directory must not be a link.'
    }
    foreach ($item in [IO.DirectoryInfo]::new($nodeRun).GetFileSystemInfos()) {
        if ($item.Name -ne 'release') { $candidates.Add($item.FullName) }
    }
}
$rootArtifacts = Join-Path $repoRoot 'artifacts'
if (Test-Path -LiteralPath $rootArtifacts) {
    $null = Assert-SafePath (Join-Path $rootArtifacts '_path_check')
    foreach ($item in [IO.DirectoryInfo]::new($rootArtifacts).GetFiles('*.log')) { $candidates.Add($item.FullName) }
}

# Inspect first, then delete. Tracked files and processes using a target block the entire plan.
$processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID })
$plan = @(
    foreach ($candidate in ($candidates | Sort-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $safePath = Assert-SafePath $candidate
        $relative = $safePath.Substring($repoRoot.Length + 1).Replace('\', '/')
        foreach ($tracked in $trackedFiles) {
            if ($tracked.Equals($relative, $comparison) -or $tracked.StartsWith($relative + '/', $comparison)) {
                throw "Refusing tracked content: $relative"
            }
        }
        foreach ($process in $processes) {
            $command = ([string]$process.CommandLine).Replace('/', '\')
            $absoluteUse = $command.IndexOf($safePath, $comparison) -ge 0
            $relativeUse = $command.IndexOf($repoRoot, $comparison) -ge 0 -and
                $command.IndexOf($relative.Replace('/', '\'), $comparison) -ge 0
            if ($absoluteUse -or $relativeUse) {
                throw "Close process $($process.ProcessId) ($($process.Name)) using $relative, then retry."
            }
        }
        $problem = ''
        [long]$bytes = 0
        try { $bytes = Get-TreeSize $safePath } catch { $problem = $_.Exception.Message }
        [pscustomobject]@{Path = $safePath; RelativePath = $relative; Bytes = $bytes; Problem = $problem}
    }
)
[long]$totalBytes = 0
foreach ($entry in $plan) { $totalBytes += $entry.Bytes }
$plan | Select-Object @{n='MiB';e={if ($_.Problem) {'unreadable'} else {[math]::Round($_.Bytes / 1MB, 1)}}}, RelativePath | Format-Table -AutoSize
Write-Host ('{0} targets, {1:N2} GiB known logical size (unreadable targets excluded). Hard links may reduce reclaimed space.' -f $plan.Count, ($totalBytes / 1GB))
Write-Host 'Preserved: current extension packages, node-clean-03/release, node distribution, production-node, marketing images, data/, models/, output/, and unlisted paths.'
$blocked = @($plan | Where-Object { $_.Problem })
foreach ($entry in $blocked) { Write-Warning "$($entry.RelativePath): $($entry.Problem)" }
if (-not $Apply) { Write-Host 'Preview only. Close tests/builds, then run with -Apply to delete this plan.'; return }
if ($blocked.Count) { throw 'No files deleted. Some targets could not be inspected; for access-denied errors, rerun in an Administrator PowerShell window.' }
foreach ($entry in $plan) {
    try {
        Remove-ArtifactTree $entry.Path
        Write-Host "Removed: $($entry.RelativePath)"
    } catch {
        throw "Cleanup stopped at $($entry.RelativePath). Earlier removals are complete; rerunning is safe. $($_.Exception.Message)"
    }
}
Write-Host 'Cleanup complete.'
