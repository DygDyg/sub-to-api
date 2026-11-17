[CmdletBinding()]
param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

function Get-CurrentVersion {
    $package = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    return [string]$package.version
}

$currentVersion = Get-CurrentVersion
if (-not $Version) {
    if ($currentVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw "Cannot automatically increment non-stable version: $currentVersion"
    }
    $Version = '{0}.{1}.{2}' -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
}
if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Version must use stable MAJOR.MINOR.PATCH format: $Version"
}
if ([version]$Version -le [version]$currentVersion) {
    throw "New version must be greater than current version $currentVersion"
}
$tag = "v$Version"

$branch = (& git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not determine the current Git branch' }
if ($branch -ne 'main') { throw "Deploy from main only; current branch is $branch" }
& git diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Commit or stash tracked changes before deploying' }
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'Commit or unstage staged changes before deploying' }

Invoke-Checked git @('fetch', 'origin', 'main', '--tags')
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read HEAD' }
$remoteHead = (& git rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read origin/main' }
if ($head -ne $remoteHead) { throw 'Local main must match origin/main before deploying' }
$existingTag = (& git tag --list $tag | Out-String).Trim()
if ($existingTag) { throw "Git tag already exists: $tag" }

$oldPackage = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$lockVersions = Select-String -Path (Join-Path $repoRoot 'package-lock.json') -Pattern '^\s+"version": "([^"]+)"' | ForEach-Object { $_.Matches[0].Groups[1].Value }
if ($oldPackage.version -ne $currentVersion -or $lockVersions.Count -lt 2 -or $lockVersions[0] -ne $currentVersion -or $lockVersions[1] -ne $currentVersion) {
    throw 'package.json and package-lock.json versions must match before deployment'
}

$versionUpdated = $false
$commitCreated = $false
$tagCreated = $false
try {
    Invoke-Checked npm @('version', $Version, '--no-git-tag-version')
    $versionUpdated = $true
    Invoke-Checked npm @('run', 'check')
    Invoke-Checked npm @('run', 'package')

    $readme = Get-Content (Join-Path $repoRoot 'release/SubToAPI/README.txt') -TotalCount 1
    if ($readme -ne "SubToAPI $Version") { throw "Portable folder has unexpected version: $readme" }
    $exePath = Join-Path $repoRoot 'release/SubToAPI/sub-to-api.exe'
    if (-not (Test-Path $exePath)) { throw 'Portable executable was not created' }
    $archivePath = Join-Path $repoRoot "release/SubToAPI-$Version-win-x64.zip"
    if (-not (Test-Path $archivePath)) { throw 'Versioned release archive was not created' }
    if (-not (Test-Path (Join-Path $repoRoot 'release/SHA256SUMS.txt'))) { throw 'Archive checksum file was not created' }

    Invoke-Checked git @('add', 'package.json', 'package-lock.json')
    Invoke-Checked git @('commit', '-m', "Release $Version")
    $commitCreated = $true
    Invoke-Checked git @('tag', '-a', $tag, '-m', "Release $Version")
    $tagCreated = $true
    Invoke-Checked git @('push', 'origin', 'main')
    Invoke-Checked git @('push', 'origin', $tag)

    Write-Host "Release $Version pushed. GitHub Actions will build and publish the release."
    Write-Host "Local portable folder: $repoRoot\release\SubToAPI"
    Write-Host "Local archive: $archivePath"
}
catch {
    if (-not $commitCreated -and $versionUpdated) {
        try {
            Invoke-Checked npm @('version', $currentVersion, '--no-git-tag-version')
            if (Test-Path (Join-Path $repoRoot 'node_modules')) {
                Invoke-Checked npm @('ci')
            }
        }
        catch {
            Write-Warning "Could not restore version $currentVersion automatically. Restore package.json and package-lock.json before deploying again."
        }
    }
    if ($commitCreated) {
        Write-Warning "Release commit $tag was created. It was left intact so a failed push can be retried safely."
        if ($tagCreated) { Write-Warning "The local tag $tag was also left intact; inspect Git status before retrying." }
    }
    throw
}
