[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $projectRoot 'update\GeminUp.Update.psm1'
$controllerPath = Join-Path $projectRoot 'geminUp.ps1'
$testRoot = Join-Path $env:TEMP ('geminUp-update-tests-' + [Guid]::NewGuid().ToString('N'))
$temporaryPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe updater test directory path.'
}

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw $Message
    }
}

function Write-Utf8File {
    param([string]$Path, [string]$Value)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Write-ChecksumFile {
    param([string]$ArchivePath, [string]$ChecksumPath)

    $hash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(
        $ChecksumPath,
        "$hash  geminUp.zip`n",
        [Text.Encoding]::ASCII)
}

try {
    New-Item -ItemType Directory -Path $resolvedTestRoot -Force | Out-Null
    Import-Module -Name $modulePath -Force

    $controllerText = Get-Content -LiteralPath $controllerPath -Raw -Encoding UTF8
    Assert-True ($controllerText -match "'4'\s*\{\s*Update-AndRefreshTransport") `
        'Menu option 4 does not invoke the automatic updater.'
    Assert-True ($controllerText -match '(?s)catch\s*\{.{0,800}GitHub update was not applied:.{0,800}Refresh-Transport') `
        'Automatic updater does not fall back to a local refresh after download failure.'

    $packageRoot = Join-Path $resolvedTestRoot 'package\geminUp'
    Write-Utf8File -Path (Join-Path $packageRoot 'geminUp.ps1') `
        -Value "`$script:TransportVersion = '9.8.7'`r`n"
    Write-Utf8File -Path (Join-Path $packageRoot 'geminUp.bat') -Value "@echo off`r`n"
    Write-Utf8File -Path (Join-Path $packageRoot 'transport\GeminUp.cs') -Value "// test`r`n"
    Write-Utf8File -Path (Join-Path $packageRoot 'transport\domains.txt') -Value "example.com`r`n"
    Write-Utf8File -Path (Join-Path $packageRoot 'transport\youtube-domains.txt') -Value "youtube.com`r`n"

    $archivePath = Join-Path $resolvedTestRoot 'geminUp.zip'
    $checksumPath = Join-Path $resolvedTestRoot 'geminUp.zip.sha256'
    Compress-Archive -Path $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
    Write-ChecksumFile -ArchivePath $archivePath -ChecksumPath $checksumPath

    $releaseCache = Join-Path $resolvedTestRoot 'releases'
    $release = Install-GeminUpVerifiedRelease -ArchivePath $archivePath `
        -ChecksumPath $checksumPath -ReleaseCacheRoot $releaseCache
    Assert-True ($release.Version -eq [Version]'9.8.7') 'Verified release version was parsed incorrectly.'
    Assert-True (Test-Path -LiteralPath $release.ControllerPath -PathType Leaf) `
        'Verified release controller was not installed in the cache.'
    Assert-True ($release.ReleaseRoot -eq (Join-Path $releaseCache $release.Sha256)) `
        'Verified release is not stored in its content-addressed cache directory.'

    $lockedController = [IO.File]::Open(
        $release.ControllerPath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read)
    try {
        $cachedRelease = Install-GeminUpVerifiedRelease -ArchivePath $archivePath `
            -ChecksumPath $checksumPath -ReleaseCacheRoot $releaseCache
        Assert-True ($cachedRelease.ControllerPath -eq $release.ControllerPath) `
            'A complete content-addressed release was not reused from cache.'
    }
    finally {
        $lockedController.Dispose()
    }

    $badChecksumPath = Join-Path $resolvedTestRoot 'bad.sha256'
    [IO.File]::WriteAllText(
        $badChecksumPath,
        (('0' * 64) + "  geminUp.zip`n"),
        [Text.Encoding]::ASCII)
    $checksumRejected = $false
    try {
        Install-GeminUpVerifiedRelease -ArchivePath $archivePath `
            -ChecksumPath $badChecksumPath -ReleaseCacheRoot $releaseCache | Out-Null
    }
    catch {
        $checksumRejected = $_.Exception.Message -match 'checksum mismatch'
    }
    Assert-True $checksumRejected 'Updater accepted a release ZIP with the wrong checksum.'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $unsafeArchivePath = Join-Path $resolvedTestRoot 'unsafe.zip'
    $unsafeArchive = [IO.Compression.ZipFile]::Open(
        $unsafeArchivePath,
        [IO.Compression.ZipArchiveMode]::Create)
    try {
        $entry = $unsafeArchive.CreateEntry('../escaped.txt')
        $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
        try {
            $writer.Write('must not escape')
        }
        finally {
            $writer.Dispose()
        }
    }
    finally {
        $unsafeArchive.Dispose()
    }
    $unsafeChecksumPath = Join-Path $resolvedTestRoot 'unsafe.zip.sha256'
    Write-ChecksumFile -ArchivePath $unsafeArchivePath -ChecksumPath $unsafeChecksumPath
    $unsafePathRejected = $false
    try {
        Install-GeminUpVerifiedRelease -ArchivePath $unsafeArchivePath `
            -ChecksumPath $unsafeChecksumPath -ReleaseCacheRoot $releaseCache | Out-Null
    }
    catch {
        $unsafePathRejected = $_.Exception.Message -match 'unsafe path'
    }
    Assert-True $unsafePathRejected 'Updater accepted a ZIP path that escapes the release directory.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $resolvedTestRoot 'escaped.txt'))) `
        'Unsafe ZIP entry was written outside the release directory.'

    Write-Host 'SUCCESS: updater checksum, version, cache, fallback wiring and ZIP path checks passed.' `
        -ForegroundColor Green
}
finally {
    Remove-Module GeminUp.Update -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
