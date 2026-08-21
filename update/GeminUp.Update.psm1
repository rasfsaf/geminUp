Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-GeminUpControllerVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ControllerPath
    )

    if (-not (Test-Path -LiteralPath $ControllerPath -PathType Leaf)) {
        throw "geminUp controller is missing: $ControllerPath"
    }

    $controller = Get-Content -LiteralPath $ControllerPath -Raw -Encoding UTF8
    if ($controller -notmatch '(?m)^\$script:TransportVersion = ''([^'']+)''\r?$') {
        throw "Cannot read the geminUp version from: $ControllerPath"
    }

    $version = $null
    if (-not [Version]::TryParse($Matches[1], [ref]$version)) {
        throw "Invalid geminUp version '$($Matches[1])' in: $ControllerPath"
    }
    return $version
}

function Expand-GeminUpArchiveSafely {
    param(
        [string]$ArchivePath,
        [string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
    $destinationRoot = [IO.Path]::GetFullPath($DestinationPath).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $entryPath = [IO.Path]::GetFullPath((Join-Path $DestinationPath $entry.FullName))
            if (-not $entryPath.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Release ZIP contains an unsafe path: $($entry.FullName)"
            }

            if ([string]::IsNullOrEmpty($entry.Name)) {
                New-Item -ItemType Directory -Path $entryPath -Force | Out-Null
                continue
            }

            $entryDirectory = Split-Path -Parent $entryPath
            if (-not (Test-Path -LiteralPath $entryDirectory)) {
                New-Item -ItemType Directory -Path $entryDirectory -Force | Out-Null
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $entryPath, $true)
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Find-GeminUpReleaseController {
    param([string]$ReleaseRoot)

    $controllers = @(Get-ChildItem -LiteralPath $ReleaseRoot -Filter 'geminUp.ps1' -File -Recurse)
    if ($controllers.Count -ne 1) {
        throw "Release ZIP must contain exactly one geminUp.ps1; found $($controllers.Count)."
    }

    $controller = $controllers[0]
    $projectRoot = $controller.Directory.FullName
    foreach ($requiredPath in @(
            (Join-Path $projectRoot 'geminUp.bat'),
            (Join-Path $projectRoot 'transport\GeminUp.cs'),
            (Join-Path $projectRoot 'transport\domains.txt'),
            (Join-Path $projectRoot 'transport\youtube-domains.txt'))) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Release ZIP is incomplete; missing: $requiredPath"
        }
    }
    return $controller.FullName
}

function Install-GeminUpVerifiedRelease {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArchivePath,

        [Parameter(Mandatory = $true)]
        [string]$ChecksumPath,

        [Parameter(Mandatory = $true)]
        [string]$ReleaseCacheRoot
    )

    $expectedHash = ((Get-Content -LiteralPath $ChecksumPath -Raw -Encoding ASCII).Trim() -split '\s+')[0]
    if ($expectedHash -notmatch '^[A-Fa-f0-9]{64}$') {
        throw 'Release checksum file is malformed.'
    }

    $actualHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash
    if (-not $actualHash.Equals($expectedHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release ZIP checksum mismatch.'
    }

    $normalizedHash = $actualHash.ToLowerInvariant()
    $resolvedCacheRoot = [IO.Path]::GetFullPath($ReleaseCacheRoot)
    New-Item -ItemType Directory -Path $resolvedCacheRoot -Force | Out-Null
    $cachePrefix = $resolvedCacheRoot.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $releaseRoot = [IO.Path]::GetFullPath((Join-Path $resolvedCacheRoot $normalizedHash))
    $stagingRoot = [IO.Path]::GetFullPath((Join-Path $resolvedCacheRoot (
                '.{0}.{1}.tmp' -f $normalizedHash, [Guid]::NewGuid().ToString('N'))))
    foreach ($path in @($releaseRoot, $stagingRoot)) {
        if (-not $path.StartsWith($cachePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe release cache path: $path"
        }
    }

    # A bootstrap-launched controller can be running from this exact content-addressed
    # directory. Reuse a complete cached release instead of trying to delete files that
    # PowerShell or cmd.exe may still have open.
    if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
        $cachedController = Find-GeminUpReleaseController -ReleaseRoot $releaseRoot
        $cachedVersion = Get-GeminUpControllerVersion -ControllerPath $cachedController
        return [PSCustomObject]@{
            Version = $cachedVersion
            Sha256 = $normalizedHash
            ReleaseRoot = $releaseRoot
            ControllerPath = $cachedController
        }
    }

    try {
        Expand-GeminUpArchiveSafely -ArchivePath $ArchivePath -DestinationPath $stagingRoot
        $stagedController = Find-GeminUpReleaseController -ReleaseRoot $stagingRoot
        $version = Get-GeminUpControllerVersion -ControllerPath $stagedController
        $relativeController = $stagedController.Substring(
            $stagingRoot.TrimEnd([IO.Path]::DirectorySeparatorChar).Length).TrimStart(
            [IO.Path]::DirectorySeparatorChar)

        Move-Item -LiteralPath $stagingRoot -Destination $releaseRoot
        $controllerPath = Join-Path $releaseRoot $relativeController
        return [PSCustomObject]@{
            Version = $version
            Sha256 = $normalizedHash
            ReleaseRoot = $releaseRoot
            ControllerPath = $controllerPath
        }
    }
    finally {
        if (Test-Path -LiteralPath $stagingRoot) {
            Remove-Item -LiteralPath $stagingRoot -Recurse -Force
        }
    }
}

function Get-GeminUpLatestVerifiedRelease {
    [CmdletBinding()]
    param(
        [string]$ReleaseBaseUri = 'https://github.com/rasfsaf/geminUp/releases/latest/download',
        [string]$ReleaseCacheRoot = (Join-Path $env:LOCALAPPDATA 'geminUp\releases'),
        [string]$TemporaryRoot = $env:TEMP
    )

    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($TemporaryRoot)
    $temporaryPrefix = $resolvedTemporaryRoot.TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $downloadRoot = [IO.Path]::GetFullPath((Join-Path $resolvedTemporaryRoot (
                'geminUp-update-' + [Guid]::NewGuid().ToString('N'))))
    if (-not $downloadRoot.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe update temporary path: $downloadRoot"
    }

    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    $archivePath = Join-Path $downloadRoot 'geminUp.zip'
    $checksumPath = Join-Path $downloadRoot 'geminUp.zip.sha256'
    $previousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri ($ReleaseBaseUri.TrimEnd('/') + '/geminUp.zip') `
            -OutFile $archivePath -UseBasicParsing -TimeoutSec 300
        Invoke-WebRequest -Uri ($ReleaseBaseUri.TrimEnd('/') + '/geminUp.zip.sha256') `
            -OutFile $checksumPath -UseBasicParsing -TimeoutSec 60
        return Install-GeminUpVerifiedRelease -ArchivePath $archivePath `
            -ChecksumPath $checksumPath -ReleaseCacheRoot $ReleaseCacheRoot
    }
    finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousSecurityProtocol
        if (Test-Path -LiteralPath $downloadRoot) {
            Remove-Item -LiteralPath $downloadRoot -Recurse -Force
        }
    }
}

Export-ModuleMember -Function @(
    'Get-GeminUpControllerVersion',
    'Install-GeminUpVerifiedRelease',
    'Get-GeminUpLatestVerifiedRelease'
)
