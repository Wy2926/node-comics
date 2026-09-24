# Preview by default. Pass -Apply to remove only regenerable popup-test files.
[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoPrefix = $repoRoot + [IO.Path]::DirectorySeparatorChar
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'apps/extension/wxt.config.ts'))) {
    throw 'Run this script from its original scripts directory in node-comics.'
}

function Assert-WorkspacePath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the repository: $absolute"
    }
    # A junction in any parent could redirect an otherwise local-looking path.
    for ($current = $absolute; $current -ne $repoRoot; $current = Split-Path -Parent $current) {
        if ((Test-Path -LiteralPath $current) -and
            ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a symbolic link or junction: $current"
        }
    }
    return $absolute
}

$targets = @(
    foreach ($suite in @(
        @{Root = 'artifacts/login-popup'; Children = @('profile')},
        @{Root = 'artifacts/source-architecture/drive'; Children = @('profile', 'extension')}
    )) {
        $suitePath = Assert-WorkspacePath (Join-Path $repoRoot $suite.Root)
        if (-not (Test-Path -LiteralPath $suitePath)) { continue }
        foreach ($run in Get-ChildItem -LiteralPath $suitePath -Directory -Filter 'run-*') {
            foreach ($child in $suite.Children) {
                $candidate = Assert-WorkspacePath (Join-Path $run.FullName $child)
                if (Test-Path -LiteralPath $candidate) { $candidate }
            }
        }
    }
    $buildLog = Assert-WorkspacePath (Join-Path $repoRoot 'artifacts/login-popup-build.log')
    if (Test-Path -LiteralPath $buildLog) { $buildLog }
)

foreach ($target in $targets) {
    # Validate every final absolute deletion target immediately before use.
    $safeTarget = Assert-WorkspacePath $target
    if ($Apply) {
        if (Get-ChildItem -LiteralPath $safeTarget -Recurse -Force |
            Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
            Select-Object -First 1) {
            throw "Refusing a directory containing symbolic links or junctions: $safeTarget"
        }
        Remove-Item -LiteralPath $safeTarget -Recurse -Force
    }
    [pscustomobject]@{Action = $(if ($Apply) {'Removed'} else {'Would remove'}); Path = $safeTarget}
}
if (-not $Apply) { Write-Host 'Preview only. Use -Apply to remove the listed files. Screenshots, reports, source files and output/ are retained.' }
