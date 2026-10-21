[CmdletBinding()]
param(
    [ValidateSet('menu', 'enable', 'change', 'refresh', 'disable', 'status', 'watchdog', 'antigravity-patch', 'antigravity-rollback', 'argon-menu', 'argon-enable', 'argon-disable', 'argon-status', 'argon-cookie', 'argon-test')]
    [string]$Action = 'menu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TransportVersion = '1.5.3'
$script:TaskName = 'geminUp'
$script:WatchdogTaskName = 'geminUp Watchdog'
$script:ListenPort = 8877
$script:InstallRoot = Join-Path $env:ProgramData 'geminUp'
$script:ExecutablePath = Join-Path $script:InstallRoot 'geminUp.exe'
$script:ControllerPath = Join-Path $script:InstallRoot 'geminUp-controller.ps1'
$script:ConfigPath = Join-Path $script:InstallRoot 'config.json'
$script:StatePath = Join-Path $script:InstallRoot 'state.json'
$script:PidPath = Join-Path $script:InstallRoot 'transport.pid'
$script:LogPath = Join-Path $script:InstallRoot 'transport.log'
$script:WatchdogStatePath = Join-Path $script:InstallRoot 'watchdog-state.json'
$script:SourcePath = Join-Path $PSScriptRoot 'transport\GeminUp.cs'
$script:DomainPath = Join-Path $PSScriptRoot 'transport\domains.txt'
$script:YouTubeDomainPath = Join-Path $PSScriptRoot 'transport\youtube-domains.txt'
$script:UpdateModulePath = Join-Path $PSScriptRoot 'update\GeminUp.Update.psm1'
$script:InternetSettingsPath = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$script:InternetSettingsPolicyPath = 'HKLM:\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings'
$script:FirefoxPolicyPath = 'HKLM:\Software\Policies\Mozilla\Firefox'
$script:FirefoxProxyPolicyPath = Join-Path $script:FirefoxPolicyPath 'Proxy'
$script:DotNet48InstallerUri = 'https://go.microsoft.com/fwlink/?linkid=2088631'
$script:AntigravityPatchFrom = [Text.Encoding]::ASCII.GetBytes('ineligible')
$script:AntigravityPatchTo = [Text.Encoding]::ASCII.GetBytes('inexigible')
$script:AntigravityPatchFileNames = @(
    'agy.exe',
    'language_server.exe',
    'language_server_windows_x64.exe'
)
$script:ArgonTaskName = 'geminUp Argon Bridge'
$script:ArgonListenPort = 8083
$script:ArgonDir = Join-Path $script:InstallRoot 'argon'
$script:ArgonExecutablePath = Join-Path $script:ArgonDir 'gemini-web2api.exe'
$script:ArgonConfigPath = Join-Path $script:ArgonDir 'argon-config.json'
$script:ArgonDbPath = Join-Path $script:ArgonDir 'gemini.db'
$script:ArgonPidPath = Join-Path $script:ArgonDir 'argon.pid'
$script:ArgonLogPath = Join-Path $script:ArgonDir 'argon.log'
$script:ArgonCookieFilePath = Join-Path $script:ArgonDir 'cookie.txt'
$script:ArgonFixedApiKey = 'sk-geminup-argon-local-access-key'
$script:ArgonVersion = 'v4.23.0'
$script:ArgonDownloadUri = "https://github.com/zexadev/gemini-web2api-go/releases/download/$($script:ArgonVersion)/gemini-web2api-go_$($script:ArgonVersion)_windows_amd64.exe"
$script:ArgonSha256 = 'c26d00b3bd0d85f3808455d316423d5ace135b3e20a0106e240415c62ae877a1'

function Write-TransportLog {
    param(
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR')]
        [string]$Level,
        [string]$Message
    )

    $color = switch ($Level) {
        'OK' { 'Green' }
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        default { 'Cyan' }
    }
    Write-Host ('[{0}] {1}' -f $Level, $Message) -ForegroundColor $color
}

function Write-TransportFileLog {
    param(
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR')]
        [string]$Level,
        [string]$Message
    )

    try {
        Initialize-InstallDirectory
        $line = '{0:o} [{1}] {2}{3}' -f [DateTime]::UtcNow, $Level, $Message, [Environment]::NewLine
        [IO.File]::AppendAllText($script:LogPath, $line, [Text.UTF8Encoding]::new($false))
    }
    catch {
        Write-Warning "Cannot append to transport.log: $($_.Exception.Message)"
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (-not (Test-IsAdministrator)) {
        throw 'Run geminUp.bat and approve the administrator prompt.'
    }
}

function Assert-SupportedWindows {
    $version = [Environment]::OSVersion.Version
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $version.Major -lt 10) {
        throw 'geminUp supports standard desktop editions of Windows 10 and Windows 11 only.'
    }
}

function Initialize-InstallDirectory {
    if (-not (Test-Path -LiteralPath $script:InstallRoot)) {
        New-Item -ItemType Directory -Path $script:InstallRoot -Force | Out-Null
    }

    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagation = [Security.AccessControl.PropagationFlags]::None
    foreach ($sidValue in @('S-1-5-18', 'S-1-5-32-544')) {
        $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }

    $usersSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $usersRule = [Security.AccessControl.FileSystemAccessRule]::new(
        $usersSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
        $inheritance, $propagation, [Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($usersRule)

    Set-Acl -LiteralPath $script:InstallRoot -AclObject $security

    Get-ChildItem -LiteralPath $script:InstallRoot -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $fileAcl = Get-Acl -LiteralPath $_.FullName
            $fileAcl.SetAccessRuleProtection($false, $false)
            Set-Acl -LiteralPath $_.FullName -AclObject $fileAcl
        }
        catch {
            # Ignore transient locks
        }
    }
}

function Save-JsonFile {
    param(
        [string]$Path,
        [object]$Value
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $json = $Value | ConvertTo-Json -Depth 10
    Set-Content -LiteralPath $Path -Value $json -Encoding utf8
}

function Read-JsonFile {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    }
    catch {
        throw "Cannot read '$Path': $($_.Exception.Message)"
    }
}

function Find-CSharpCompiler {
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

function Install-DotNetFramework48 {
    Write-TransportLog WARN '.NET Framework 4.8 compiler is missing.'
    $confirmation = Read-Host 'Download and install the official Microsoft .NET Framework 4.8 package? [y/N]'
    if ($confirmation -notmatch '^(?i:y|yes)$') {
        throw '.NET Framework installation was declined.'
    }

    $installerPath = Join-Path $env:TEMP 'geminUp-dotnet48-installer.exe'
    try {
        Write-TransportLog INFO 'Downloading .NET Framework 4.8 from Microsoft...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $script:DotNet48InstallerUri -OutFile $installerPath `
            -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
        $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
        if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
            $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
            throw 'Downloaded .NET installer does not have a valid Microsoft digital signature.'
        }

        Write-TransportLog INFO 'Installing .NET Framework 4.8...'
        $installer = Start-Process -FilePath $installerPath -ArgumentList '/q', '/norestart' `
            -Wait -PassThru -WindowStyle Hidden
        if ($installer.ExitCode -eq 3010) {
            throw '.NET Framework 4.8 was installed. Restart Windows, then run geminUp.bat again.'
        }
        if ($installer.ExitCode -ne 0) {
            throw ".NET Framework installer exited with code $($installer.ExitCode)."
        }
        Write-TransportLog OK '.NET Framework 4.8 installation completed.'
    }
    finally {
        if (Test-Path -LiteralPath $installerPath) {
            Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-CSharpCompiler {
    $compiler = Find-CSharpCompiler
    if ($null -ne $compiler) {
        return $compiler
    }
    Install-DotNetFramework48
    $compiler = Find-CSharpCompiler
    if ($null -eq $compiler) {
        throw 'The .NET Framework compiler is still missing. Repair the Windows .NET Framework component and retry.'
    }
    return $compiler
}

function Build-TransportExecutable {
    param([switch]$Force)

    if (-not (Test-Path -LiteralPath $script:SourcePath)) {
        throw "Transport source is missing: $script:SourcePath"
    }
    Initialize-InstallDirectory

    $requiresBuild = $Force -or -not (Test-Path -LiteralPath $script:ExecutablePath)
    if (-not $requiresBuild) {
        $requiresBuild = (Get-Item -LiteralPath $script:SourcePath).LastWriteTimeUtc -gt
            (Get-Item -LiteralPath $script:ExecutablePath).LastWriteTimeUtc
    }
    if (-not $requiresBuild) {
        return
    }

    $compiler = Get-CSharpCompiler
    $temporaryExe = Join-Path $script:InstallRoot 'geminUp.build.exe'
    if (Test-Path -LiteralPath $temporaryExe) {
        Remove-Item -LiteralPath $temporaryExe -Force
    }
    Write-TransportLog INFO 'Building the self-contained Windows transport...'
    & $compiler /nologo /target:exe /optimize+ /platform:anycpu "/out:$temporaryExe" `
        /reference:System.Web.Extensions.dll /reference:System.Security.dll $script:SourcePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporaryExe)) {
        throw "C# compiler failed with exit code $LASTEXITCODE."
    }
    if (Test-Path -LiteralPath $script:ExecutablePath) {
        Unregister-TransportTask
        Stop-TransportProcess
        Remove-Item -LiteralPath $script:ExecutablePath -Force
    }
    Move-Item -LiteralPath $temporaryExe -Destination $script:ExecutablePath
    Write-TransportLog OK "Transport built: $script:ExecutablePath"
}

function Test-YouTubeRoutingEnabled {
    param([AllowNull()][object]$State)

    return $null -ne $State -and
        $State.PSObject.Properties.Name -contains 'YouTubeEnabled' -and
        [bool]$State.YouTubeEnabled
}

function New-EffectiveDomainFile {
    param([bool]$YouTubeEnabled)

    if (-not $YouTubeEnabled) {
        return $script:DomainPath
    }
    if (-not (Test-Path -LiteralPath $script:YouTubeDomainPath)) {
        throw "YouTube routing file is missing: $script:YouTubeDomainPath"
    }

    Initialize-InstallDirectory
    $temporaryPath = Join-Path $script:InstallRoot ('domains-{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    try {
        $lines = @(
            Get-Content -LiteralPath $script:DomainPath -Encoding utf8
            Get-Content -LiteralPath $script:YouTubeDomainPath -Encoding utf8
        )
        [IO.File]::WriteAllLines($temporaryPath, [string[]]$lines, [Text.UTF8Encoding]::new($false))
        return $temporaryPath
    }
    catch {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Invoke-SecureProxyConfiguration {
    param([bool]$YouTubeEnabled = $false)

    $secureProxy = Read-Host 'SOCKS5 (host:port:user:password)' -AsSecureString
    $pointer = [IntPtr]::Zero
    $plainProxy = $null
    $inputBytes = $null
    $effectiveDomainPath = $null
    try {
        $effectiveDomainPath = New-EffectiveDomainFile -YouTubeEnabled $YouTubeEnabled
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureProxy)
        $plainProxy = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $script:ExecutablePath
        $startInfo.Arguments = 'configure --config "{0}" --domains "{1}"' -f `
            $script:ConfigPath.Replace('"', '\"'), $effectiveDomainPath.Replace('"', '\"')
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        if ($startInfo.PSObject.Properties.Name -contains 'StandardOutputEncoding') {
            $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        }
        if ($startInfo.PSObject.Properties.Name -contains 'StandardErrorEncoding') {
            $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) {
            throw 'Cannot start the transport configurator.'
        }
        $inputBytes = [Text.UTF8Encoding]::new($false).GetBytes($plainProxy + "`n")
        $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEnd()
        $errorOutput = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            $message = if ([string]::IsNullOrWhiteSpace($errorOutput)) { 'Unknown SOCKS5 validation error.' } else { $errorOutput.Trim() }
            if ($message.StartsWith('ERROR: ', [StringComparison]::OrdinalIgnoreCase)) {
                $message = $message.Substring(7).Trim()
            }
            throw $message
        }
        Write-TransportLog OK $output.Trim()
    }
    finally {
        $plainProxy = $null
        if ($null -ne $inputBytes) {
            [Array]::Clear($inputBytes, 0, $inputBytes.Length)
        }
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        if ($null -ne $effectiveDomainPath -and
            -not [string]::Equals($effectiveDomainPath, $script:DomainPath, [StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $effectiveDomainPath)) {
            Remove-Item -LiteralPath $effectiveDomainPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-DomainConfigurationRefresh {
    param([bool]$YouTubeEnabled = $false)

    $effectiveDomainPath = New-EffectiveDomainFile -YouTubeEnabled $YouTubeEnabled
    try {
        $output = & $script:ExecutablePath refresh-domains --config $script:ConfigPath --domains $effectiveDomainPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Cannot refresh protected domains: $($output -join [Environment]::NewLine)"
        }
        Write-TransportLog OK ($output -join ' ')
    }
    finally {
        if (-not [string]::Equals($effectiveDomainPath, $script:DomainPath, [StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $effectiveDomainPath)) {
            Remove-Item -LiteralPath $effectiveDomainPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-RegistryValueBackup {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return [PSCustomObject]@{ Path = $Path; Name = $Name; Exists = $false; Kind = ''; Value = $null }
    }
    $key = Get-Item -LiteralPath $Path
    if ($key.GetValueNames() -notcontains $Name) {
        return [PSCustomObject]@{ Path = $Path; Name = $Name; Exists = $false; Kind = ''; Value = $null }
    }
    return [PSCustomObject]@{
        Path = $Path
        Name = $Name
        Exists = $true
        Kind = $key.GetValueKind($Name).ToString()
        Value = $key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    }
}

function Restore-RegistryValue {
    param([object]$Backup)

    if ($Backup.Exists) {
        if (-not (Test-Path -LiteralPath $Backup.Path)) {
            New-Item -Path $Backup.Path -Force | Out-Null
        }
        $propertyType = switch ([string]$Backup.Kind) {
            'DWord' { 'DWord' }
            'QWord' { 'QWord' }
            'ExpandString' { 'ExpandString' }
            'MultiString' { 'MultiString' }
            'Binary' { 'Binary' }
            default { 'String' }
        }
        New-ItemProperty -LiteralPath $Backup.Path -Name $Backup.Name -Value $Backup.Value `
            -PropertyType $propertyType -Force | Out-Null
    }
    elseif (Test-Path -LiteralPath $Backup.Path) {
        Remove-ItemProperty -LiteralPath $Backup.Path -Name $Backup.Name -ErrorAction SilentlyContinue
    }
}

function Set-FirefoxMachinePolicies {
    param([object]$PreferencesBackup)

    foreach ($path in @($script:FirefoxPolicyPath, $script:FirefoxProxyPolicyPath)) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force | Out-Null
        }
    }
    New-ItemProperty -LiteralPath $script:FirefoxProxyPolicyPath -Name 'Mode' `
        -Value 'system' -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $script:FirefoxProxyPolicyPath -Name 'Locked' `
        -Value 1 -PropertyType DWord -Force | Out-Null

    $preferences = [PSCustomObject]@{}
    if ($PreferencesBackup.Exists) {
        $raw = if ($PreferencesBackup.Value -is [array]) {
            [string]::Join([Environment]::NewLine, [string[]]$PreferencesBackup.Value)
        }
        else {
            [string]$PreferencesBackup.Value
        }
        try {
            $preferences = $raw | ConvertFrom-Json
            if ($null -eq $preferences) {
                throw 'JSON value is empty.'
            }
        }
        catch {
            throw "Existing Firefox Preferences policy is not valid JSON: $($_.Exception.Message)"
        }
    }
    $webrtcPolicy = [PSCustomObject]@{ Value = $false; Status = 'locked' }
    $preferences | Add-Member -NotePropertyName 'media.peerconnection.enabled' `
        -NotePropertyValue $webrtcPolicy -Force
    $json = $preferences | ConvertTo-Json -Depth 20
    New-ItemProperty -LiteralPath $script:FirefoxPolicyPath -Name 'Preferences' `
        -Value ([string[]]($json -split "`r?`n")) -PropertyType MultiString -Force | Out-Null
}

function New-TransportState {
    $registryBackups = @()
    foreach ($name in @('ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL')) {
        $registryBackups += Get-RegistryValueBackup -Path $script:InternetSettingsPath -Name $name
    }
    $registryBackups += Get-RegistryValueBackup -Path $script:InternetSettingsPolicyPath -Name 'ProxySettingsPerUser'

    $policyBackups = @()
    $policyPaths = @(
        'HKLM:\Software\Policies\Google\Chrome',
        'HKLM:\Software\Policies\Microsoft\Edge',
        'HKLM:\Software\Policies\BraveSoftware\Brave'
    )
    foreach ($path in $policyPaths) {
        foreach ($name in @('WebRtcIPHandlingPolicy', 'QuicAllowed')) {
            $policyBackups += Get-RegistryValueBackup -Path $path -Name $name
        }
    }
    $policyBackups += Get-RegistryValueBackup -Path $script:FirefoxProxyPolicyPath -Name 'Mode'
    $policyBackups += Get-RegistryValueBackup -Path $script:FirefoxProxyPolicyPath -Name 'Locked'
    $policyBackups += Get-RegistryValueBackup -Path $script:FirefoxPolicyPath -Name 'Preferences'

    return [PSCustomObject]@{
        Version = 4
        InstalledAtUtc = [DateTime]::UtcNow.ToString('o')
        YouTubeEnabled = $false
        RegistryBackups = $registryBackups
        PolicyBackups = $policyBackups
        ShortcutOwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        AntigravityShortcutBackups = @()
    }
}

function Notify-InternetSettingsChanged {
    if (-not ('GeminUp.NativeMethods' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace GeminUp {
    public static class NativeMethods {
        [DllImport("wininet.dll", SetLastError=true)]
        public static extern bool InternetSetOption(IntPtr hInternet, int option, IntPtr buffer, int length);
    }
}
"@
    }
    [GeminUp.NativeMethods]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
    [GeminUp.NativeMethods]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
}

function Set-SystemProxyAndPolicies {
    param([object]$State)

    foreach ($path in @($script:InternetSettingsPath, $script:InternetSettingsPolicyPath)) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force | Out-Null
        }
    }
    New-ItemProperty -LiteralPath $script:InternetSettingsPolicyPath -Name 'ProxySettingsPerUser' `
        -Value 0 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -LiteralPath $script:InternetSettingsPath -Name 'ProxyEnable' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -LiteralPath $script:InternetSettingsPath -Name 'ProxyServer' `
        -Value ('127.0.0.1:{0}' -f $script:ListenPort) -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $script:InternetSettingsPath -Name 'ProxyOverride' `
        -Value '<local>;localhost;127.*' -PropertyType String -Force | Out-Null
    Remove-ItemProperty -LiteralPath $script:InternetSettingsPath -Name 'AutoConfigURL' -ErrorAction SilentlyContinue

    foreach ($path in @(
            'HKLM:\Software\Policies\Google\Chrome',
            'HKLM:\Software\Policies\Microsoft\Edge',
            'HKLM:\Software\Policies\BraveSoftware\Brave')) {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force | Out-Null
        }
        New-ItemProperty -LiteralPath $path -Name 'WebRtcIPHandlingPolicy' `
            -Value 'disable_non_proxied_udp' -PropertyType String -Force | Out-Null
        New-ItemProperty -LiteralPath $path -Name 'QuicAllowed' -Value 0 -PropertyType DWord -Force | Out-Null
    }

    $preferencesBackup = @($State.PolicyBackups | Where-Object {
            $_.Path -eq $script:FirefoxPolicyPath -and $_.Name -eq 'Preferences'
        })
    if ($preferencesBackup.Count -ne 1) {
        throw 'Firefox Preferences policy backup is missing from install state.'
    }
    Set-FirefoxMachinePolicies -PreferencesBackup $preferencesBackup[0]
    Notify-InternetSettingsChanged
    Write-TransportLog OK "Machine proxy points to 127.0.0.1:$script:ListenPort; non-proxied WebRTC and QUIC are disabled."
}

function Restore-SystemProxyAndPolicies {
    param([object]$State)

    foreach ($backup in @($State.RegistryBackups)) {
        Restore-RegistryValue -Backup $backup
    }
    foreach ($backup in @($State.PolicyBackups)) {
        Restore-RegistryValue -Backup $backup
    }
    Notify-InternetSettingsChanged
    Write-TransportLog OK 'Previous machine proxy and browser policy settings restored.'
}

function Get-AntigravityExecutablePath {
    $candidates = @()
    $running = Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $running -and -not [string]::IsNullOrWhiteSpace($running.ExecutablePath)) {
        $candidates += [string]$running.ExecutablePath
    }
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe'

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            continue
        }
        $file = Get-Item -LiteralPath $candidate
        if ($file.Name -ne 'Antigravity.exe' -or $file.VersionInfo.CompanyName -ne 'Google') {
            Write-TransportLog WARN "Ignoring unexpected Antigravity candidate: $candidate"
            continue
        }
        return $file.FullName
    }
    return $null
}

function Get-AntigravityShortcutBackups {
    param([string]$AntigravityPath)

    $roots = @(
        [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
        [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) } |
        Select-Object -Unique

    $shell = New-Object -ComObject WScript.Shell
    try {
        $backups = @()
        foreach ($shortcutPath in @($roots | ForEach-Object {
                    Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
                } | Select-Object -ExpandProperty FullName -Unique)) {
            $shortcut = $shell.CreateShortcut($shortcutPath)
            if (-not [string]::Equals($shortcut.TargetPath, $AntigravityPath,
                    [StringComparison]::OrdinalIgnoreCase)) {
                continue
            }
            $backups += [PSCustomObject]@{
                Path = $shortcutPath
                Exists = $true
                TargetPath = [string]$shortcut.TargetPath
                Arguments = [string]$shortcut.Arguments
                WorkingDirectory = [string]$shortcut.WorkingDirectory
                IconLocation = [string]$shortcut.IconLocation
                Description = [string]$shortcut.Description
                WindowStyle = [int]$shortcut.WindowStyle
                Hotkey = [string]$shortcut.Hotkey
            }
        }

        if ($backups.Count -eq 0) {
            $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
            if ([string]::IsNullOrWhiteSpace($programs)) {
                throw 'Cannot locate the current user Start Menu Programs directory.'
            }
            $backups += [PSCustomObject]@{
                Path = Join-Path $programs 'Antigravity (geminUp).lnk'
                Exists = $false
                TargetPath = $AntigravityPath
                Arguments = ''
                WorkingDirectory = Split-Path -Parent $AntigravityPath
                IconLocation = "$AntigravityPath,0"
                Description = 'Google Antigravity through geminUp'
                WindowStyle = 1
                Hotkey = ''
            }
        }
        return $backups
    }
    finally {
        if ($null -ne $shell) {
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
        }
    }
}

function Get-AntigravityPatchRoots {
    $roots = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'USERPROFILE')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { [void]$roots.Add($value) }
    }
    return @($roots | Select-Object -Unique)
}

function Get-AntigravityFastCandidates {
    param([string[]]$Roots = (Get-AntigravityPatchRoots))

    $relative = @(
        'Programs\antigravity\resources\bin\language_server.exe',
        'Programs\antigravity\resources\bin\language_server_windows_x64.exe',
        'Programs\antigravity\resources\bin\agy.exe',
        'Programs\Antigravity\resources\bin\language_server.exe',
        'Programs\Antigravity IDE\resources\bin\language_server.exe',
        'antigravity\resources\bin\language_server.exe',
        'Antigravity\resources\bin\language_server.exe',
        'agy\bin\agy.exe',
        'agy\bin\language_server.exe',
        'Antigravity\agy.exe',
        'Antigravity\language_server.exe',
        'Antigravity IDE\language_server.exe',
        'antigravity\language_server.exe',
        'scoop\apps\antigravity\current\resources\bin\language_server.exe',
        'scoop\apps\antigravity\current\agy.exe'
    )
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($root in @($Roots)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        foreach ($tail in $relative) {
            [void]$paths.Add((Join-Path $root $tail))
        }
    }
    return @($paths | Select-Object -Unique)
}

function Get-AntigravityInstallDirs {
    $roots = New-Object System.Collections.Generic.List[string]
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    $programFiles = [Environment]::GetEnvironmentVariable('PROGRAMFILES')
    $programFilesX86 = [Environment]::GetEnvironmentVariable('PROGRAMFILES(X86)')
    $userProfile = [Environment]::GetEnvironmentVariable('USERPROFILE')

    foreach ($candidate in @(
            (Join-Path $localAppData 'Programs\antigravity'),
            (Join-Path $localAppData 'Programs\Antigravity'),
            (Join-Path $localAppData 'Programs\Antigravity IDE'),
            (Join-Path $localAppData 'antigravity'),
            (Join-Path $localAppData 'Antigravity'),
            (Join-Path $localAppData 'Antigravity IDE'),
            (Join-Path $localAppData 'agy'),
            (Join-Path $localAppData 'agy\bin'),
            (Join-Path $programFiles 'Antigravity'),
            (Join-Path $programFiles 'Antigravity IDE'),
            (Join-Path $programFiles 'antigravity'),
            (Join-Path $programFilesX86 'Antigravity'),
            (Join-Path $programFilesX86 'Antigravity IDE'),
            (Join-Path $programFilesX86 'antigravity'),
            (Join-Path $userProfile 'scoop\apps\antigravity\current'),
            (Join-Path $userProfile 'scoop\apps\antigravity')
        )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) {
            [void]$roots.Add($candidate)
        }
    }

    foreach ($parent in @($localAppData, $programFiles, $programFilesX86, (Join-Path $userProfile 'scoop\apps'))) {
        if (-not $parent -or -not (Test-Path -LiteralPath $parent)) { continue }
        try {
            Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Name -match '(?i)antigravity|^agy$') {
                    [void]$roots.Add($_.FullName)
                }
            }
        } catch {
            Write-Warning "Could not list '$parent': $($_.Exception.Message)"
        }
    }

    $programs = Join-Path $localAppData 'Programs'
    if ($programs -and (Test-Path -LiteralPath $programs)) {
        try {
            Get-ChildItem -LiteralPath $programs -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.Name -match '(?i)antigravity|^agy$') {
                    [void]$roots.Add($_.FullName)
                }
            }
        } catch {
            Write-Warning "Could not list '$programs': $($_.Exception.Message)"
        }
    }

    return @($roots | Select-Object -Unique)
}

function Resolve-AntigravityPatchTargets {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [switch]$Shallow
    )

    $cleaned = $InputPath.Trim().Trim('"').Trim("'")
    if ([string]::IsNullOrWhiteSpace($cleaned)) { return @() }
    if (-not (Test-Path -LiteralPath $cleaned)) {
        Write-Warning "Path does not exist: $cleaned"
        return @()
    }

    $item = Get-Item -LiteralPath $cleaned -Force
    $targets = New-Object System.Collections.Generic.List[System.IO.FileInfo]
    if (-not $item.PSIsContainer) {
        if ($script:AntigravityPatchFileNames -contains $item.Name) {
            [void]$targets.Add($item)
        } else {
            Write-Warning "Not an Antigravity patch target: $($item.Name). Expected agy.exe or language_server*.exe."
        }
        return @($targets)
    }

    if ($Shallow) {
        foreach ($relative in @(
                'resources\bin\language_server.exe',
                'resources\bin\language_server_windows_x64.exe',
                'resources\bin\agy.exe',
                'bin\language_server.exe',
                'bin\agy.exe',
                'language_server.exe',
                'language_server_windows_x64.exe',
                'agy.exe'
            )) {
            $candidate = Join-Path $item.FullName $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                [void]$targets.Add((Get-Item -LiteralPath $candidate -Force))
            }
        }
        return @($targets)
    }

    Write-Host "  scanning $($item.FullName)" -ForegroundColor DarkCyan
    $pending = New-Object System.Collections.Generic.Queue[string]
    $pending.Enqueue($item.FullName)
    $listed = 0
    while ($pending.Count -gt 0) {
        $dir = $pending.Dequeue()
        $listed++
        if (($listed % 25) -eq 0) {
            Write-Host "  scanned folders: $listed" -ForegroundColor DarkGray
        }
        try {
            foreach ($child in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
                if ($child.PSIsContainer) {
                    if ($child.Name -match '^(?i)(node_modules|\.git)$') { continue }
                    $pending.Enqueue($child.FullName)
                } elseif ($script:AntigravityPatchFileNames -contains $child.Name) {
                    [void]$targets.Add($child)
                }
            }
        } catch {
            Write-Warning "Could not list '$dir': $($_.Exception.Message)"
        }
    }
    return @($targets)
}

function Get-AntigravityPatchTargets {
    $targets = New-Object System.Collections.Generic.List[System.IO.FileInfo]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

    Write-Host 'Looking for Antigravity binaries...' -ForegroundColor Cyan
    foreach ($path in @(Get-AntigravityFastCandidates)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        if ($seen.Add($path)) {
            [void]$targets.Add((Get-Item -LiteralPath $path -Force))
        }
    }
    if ($targets.Count -gt 0) { return @($targets) }

    foreach ($dir in @(Get-AntigravityInstallDirs)) {
        foreach ($file in @(Resolve-AntigravityPatchTargets -InputPath $dir -Shallow)) {
            if ($seen.Add($file.FullName)) {
                [void]$targets.Add($file)
            }
        }
    }
    return @($targets)
}

function Read-AntigravityPatchTargets {
    while ($true) {
        Write-Host ''
        Write-Host 'Fast path: type the full path to agy.exe or language_server*.exe.' -ForegroundColor Yellow
        Write-Host 'Or type an install folder. Empty input cancels. Type scan <folder> to search it.' -ForegroundColor Yellow
        $answer = Read-Host 'Path'
        if ([string]::IsNullOrWhiteSpace($answer)) {
            Write-Warning 'Antigravity patch cancelled.'
            return @()
        }
        $scan = $answer.Trim() -match '^(?i)scan\s+(.+)$'
        $path = if ($scan) { $Matches[1] } else { $answer }
        $targets = @(Resolve-AntigravityPatchTargets -InputPath $path -Shallow:(-not $scan))
        if ($targets.Count -gt 0) { return $targets }
        Write-Warning 'No agy.exe or language_server*.exe found at that path.'
    }
}

function Find-AntigravityMarkerOffsets {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Haystack,
        [Parameter(Mandatory = $true)][byte[]]$Needle
    )
    $found = New-Object System.Collections.Generic.List[int]
    if ($Needle.Length -eq 0 -or $Haystack.Length -lt $Needle.Length) { return @($found) }
    $offset = 0
    while ($offset -le ($Haystack.Length - $Needle.Length)) {
        $hit = [Array]::IndexOf($Haystack, $Needle[0], $offset)
        if ($hit -lt 0 -or $hit -gt ($Haystack.Length - $Needle.Length)) { break }
        $matched = $true
        for ($j = 1; $j -lt $Needle.Length; $j++) {
            if ($Haystack[$hit + $j] -ne $Needle[$j]) {
                $matched = $false
                break
            }
        }
        if ($matched) {
            [void]$found.Add($hit)
            $offset = $hit + $Needle.Length
        } else {
            $offset = $hit + 1
        }
    }
    return @($found)
}

function Set-AntigravityBinaryPatch {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$From,
        [Parameter(Mandatory = $true)][byte[]]$To
    )
    if ($From.Length -ne $To.Length) {
        throw "Antigravity patch markers have different lengths: $($From.Length) and $($To.Length)."
    }

    Write-Host "  reading $([IO.Path]::GetFileName($Path))..." -ForegroundColor DarkCyan
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $originalLength = $bytes.LongLength
    $hits = @(Find-AntigravityMarkerOffsets -Haystack $bytes -Needle $From)
    foreach ($hit in $hits) {
        [Buffer]::BlockCopy($To, 0, $bytes, $hit, $To.Length)
    }

    if ($hits.Count -eq 0) { return 0 }
    if ($bytes.LongLength -ne $originalLength) {
        throw "Patch would change the size of '$Path'. Write cancelled."
    }

    $backup = "$Path.bak"
    if (-not (Test-Path -LiteralPath $backup)) {
        Write-Host '  writing backup...' -ForegroundColor DarkCyan
        Copy-Item -LiteralPath $Path -Destination $backup -ErrorAction Stop
    }
    Write-Host '  writing patched file...' -ForegroundColor DarkCyan
    [System.IO.File]::WriteAllBytes($Path, $bytes)
    return $hits.Count
}

function Stop-AntigravityProcesses {
    $processNames = @('Antigravity', 'language_server', 'language_server_windows_x64', 'agy')
    $running = @(Get-Process -Name $processNames -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Host "Closing $($running.Count) running Antigravity process(es) to release binary locks..." -ForegroundColor Cyan
        foreach ($proc in $running) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                $proc.WaitForExit(3000) | Out-Null
            }
            catch {
                # Ignore processes that have already terminated
            }
        }
        Start-Sleep -Milliseconds 500
    }
}

function Invoke-AntigravityBinaryPatch {
    param([ValidateSet('Apply', 'Rollback')][string]$Direction = 'Apply')

    if ($script:AntigravityPatchFrom.Length -ne $script:AntigravityPatchTo.Length) {
        throw 'Antigravity patch markers must be the same length.'
    }
    # Assignment from an if-expression enumerates byte[] into Object[] on Windows PowerShell 5.1,
    # and Buffer.BlockCopy then rejects the source as a non-primitive array.
    $from = $script:AntigravityPatchTo
    $to = $script:AntigravityPatchFrom
    if ($Direction -eq 'Apply') {
        $from = $script:AntigravityPatchFrom
        $to = $script:AntigravityPatchTo
    }
    $label = if ($Direction -eq 'Apply') { 'Patch' } else { 'Rollback' }

    $targets = @(Get-AntigravityPatchTargets)
    if ($targets.Count -eq 0) {
        $targets = @(Read-AntigravityPatchTargets)
    }
    if ($targets.Count -eq 0) {
        return $false
    }

    Stop-AntigravityProcesses

    $changed = 0
    $index = 0
    foreach ($file in $targets) {
        $index++
        try {
            Write-Host ("[{0}/{1}] {2}" -f $index, $targets.Count, $file.FullName) -ForegroundColor Cyan
            Write-Host "  reading $($file.Name)..." -ForegroundColor DarkCyan
            $current = [System.IO.File]::ReadAllBytes($file.FullName)
            $already = @(Find-AntigravityMarkerOffsets -Haystack $current -Needle $to)
            if ($already.Count -gt 0) {
                Write-Host "  [OK] $($file.Name) is already in the requested state" -ForegroundColor Green
                continue
            }
            $pending = @(Find-AntigravityMarkerOffsets -Haystack $current -Needle $from)
            if ($pending.Count -eq 0) {
                Write-Warning "  $($file.FullName): marker not found, file skipped."
                continue
            }

            if ($from.Length -ne $to.Length) {
                throw 'Antigravity patch markers must be the same length.'
            }
            foreach ($hit in $pending) {
                [Buffer]::BlockCopy($to, 0, $current, $hit, $to.Length)
            }
            $backup = "$($file.FullName).bak"
            if (-not (Test-Path -LiteralPath $backup)) {
                Write-Host '  writing backup...' -ForegroundColor DarkCyan
                Copy-Item -LiteralPath $file.FullName -Destination $backup -ErrorAction Stop
            }
            Write-Host '  writing patched file...' -ForegroundColor DarkCyan
            $written = $false
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                try {
                    [System.IO.File]::WriteAllBytes($file.FullName, $current)
                    $written = $true
                    break
                }
                catch [System.IO.IOException] {
                    if ($attempt -lt 3) {
                        Stop-AntigravityProcesses
                        Start-Sleep -Milliseconds 500
                    }
                    else {
                        throw
                    }
                }
            }
            if ($written) {
                $changed++
                Write-Host "  [OK] $($file.Name): replacements=$($pending.Count)" -ForegroundColor Green
            }
        } catch {
            Write-Warning "  $($file.FullName): $($_.Exception.Message)"
        }
    }

    if ($changed -eq 0) {
        Write-Host "$label did not change files (already applied, or the marker is missing)." -ForegroundColor DarkYellow
    } else {
        Write-Host "$label applied to $changed Antigravity file(s). File sizes were not changed." -ForegroundColor Green
    }
    return ($changed -gt 0)
}

function Set-AntigravityShortcutRouting {

    param([object]$State)

    $antigravityPath = Get-AntigravityExecutablePath
    if ([string]::IsNullOrWhiteSpace($antigravityPath)) {
        Write-TransportLog WARN 'Antigravity is not installed for the current user; no Antigravity shortcut was changed.'
        return
    }

    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not ($State.PSObject.Properties.Name -contains 'ShortcutOwnerSid')) {
        $State | Add-Member -NotePropertyName ShortcutOwnerSid -NotePropertyValue $ownerSid
    }
    if (-not [string]::Equals([string]$State.ShortcutOwnerSid, $ownerSid, [StringComparison]::Ordinal)) {
        throw 'Antigravity shortcut state belongs to another Windows user.'
    }
    if (-not ($State.PSObject.Properties.Name -contains 'AntigravityShortcutBackups') -or
        @($State.AntigravityShortcutBackups).Count -eq 0) {
        $backups = @(Get-AntigravityShortcutBackups -AntigravityPath $antigravityPath)
        $State | Add-Member -NotePropertyName AntigravityShortcutBackups -NotePropertyValue $backups -Force
        $State.Version = 4
        Save-JsonFile -Path $script:StatePath -Value $State
    }

    $shell = New-Object -ComObject WScript.Shell
    $changed = @()
    try {
        foreach ($backup in @($State.AntigravityShortcutBackups)) {
            $shortcutDirectory = Split-Path -Parent ([string]$backup.Path)
            if (-not (Test-Path -LiteralPath $shortcutDirectory)) {
                New-Item -ItemType Directory -Path $shortcutDirectory -Force | Out-Null
            }
            $argumentBytes = [Text.UTF8Encoding]::new($false).GetBytes([string]$backup.Arguments)
            try {
                $encodedArguments = [Convert]::ToBase64String($argumentBytes)
            }
            finally {
                [Array]::Clear($argumentBytes, 0, $argumentBytes.Length)
            }
            $shortcut = $shell.CreateShortcut([string]$backup.Path)
            $shortcut.TargetPath = $script:ExecutablePath
            $shortcut.Arguments = 'launch-antigravity --config "{0}" --target "{1}" --original-arguments "{2}"' -f `
                $script:ConfigPath.Replace('"', '\"'), ([string]$backup.TargetPath).Replace('"', '\"'), $encodedArguments
            $shortcut.WorkingDirectory = Split-Path -Parent ([string]$backup.TargetPath)
            $shortcut.IconLocation = if ([string]::IsNullOrWhiteSpace([string]$backup.IconLocation)) {
                "{0},0" -f [string]$backup.TargetPath
            } else { [string]$backup.IconLocation }
            $shortcut.Description = 'Google Antigravity through geminUp'
            $shortcut.WindowStyle = [int]$backup.WindowStyle
            if (-not [string]::IsNullOrWhiteSpace([string]$backup.Hotkey)) {
                $shortcut.Hotkey = [string]$backup.Hotkey
            }
            $shortcut.Save()
            $changed += [string]$backup.Path
        }
    }
    catch {
        Restore-AntigravityShortcuts -State $State -Paths $changed
        throw "Cannot configure Antigravity shortcuts: $($_.Exception.Message)"
    }
    finally {
        if ($null -ne $shell) {
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
        }
    }
    Write-TransportLog OK "Antigravity launcher configured for $($changed.Count) shortcut(s); only its process tree receives proxy variables."
}

function Restore-AntigravityShortcuts {
    param(
        [object]$State,
        [string[]]$Paths = @()
    )

    if (-not ($State.PSObject.Properties.Name -contains 'AntigravityShortcutBackups')) {
        return
    }
    $pathFilter = @($Paths)
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($backup in @($State.AntigravityShortcutBackups)) {
            if ($pathFilter.Count -gt 0 -and $pathFilter -notcontains [string]$backup.Path) {
                continue
            }
            if (-not [bool]$backup.Exists) {
                if (Test-Path -LiteralPath ([string]$backup.Path)) {
                    $current = $shell.CreateShortcut([string]$backup.Path)
                    if ([string]::Equals($current.TargetPath, $script:ExecutablePath,
                            [StringComparison]::OrdinalIgnoreCase)) {
                        Remove-Item -LiteralPath ([string]$backup.Path) -Force
                    }
                }
                continue
            }
            if (Test-Path -LiteralPath ([string]$backup.Path)) {
                $current = $shell.CreateShortcut([string]$backup.Path)
                if (-not [string]::Equals($current.TargetPath, $script:ExecutablePath,
                        [StringComparison]::OrdinalIgnoreCase)) {
                    Write-TransportLog WARN "Shortcut changed after geminUp setup; leaving it untouched: $($backup.Path)"
                    continue
                }
            }
            $shortcut = $shell.CreateShortcut([string]$backup.Path)
            $shortcut.TargetPath = [string]$backup.TargetPath
            $shortcut.Arguments = [string]$backup.Arguments
            $shortcut.WorkingDirectory = [string]$backup.WorkingDirectory
            $shortcut.IconLocation = [string]$backup.IconLocation
            $shortcut.Description = [string]$backup.Description
            $shortcut.WindowStyle = [int]$backup.WindowStyle
            $shortcut.Hotkey = [string]$backup.Hotkey
            $shortcut.Save()
        }
    }
    finally {
        if ($null -ne $shell) {
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
        }
    }
}

function Stop-TransportProcess {
    if (-not (Test-Path -LiteralPath $script:PidPath)) {
        return
    }
    try {
        $rawPid = Get-Content -LiteralPath $script:PidPath -Raw -Encoding utf8
        $transportPid = 0
        if (-not [int]::TryParse($rawPid.Trim(), [ref]$transportPid)) {
            throw 'PID file is malformed.'
        }
        $process = Get-Process -Id $transportPid -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            $actualPath = $process.Path
            if (-not [string]::Equals($actualPath, $script:ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
                Write-TransportLog WARN "Stale PID file points to another executable; PID $transportPid was not stopped."
                return
            }
            Stop-Process -Id $transportPid -Force -ErrorAction Stop
            $process.WaitForExit(5000) | Out-Null
            Write-TransportLog OK 'Background transport stopped.'
        }
    }
    finally {
        if (Test-Path -LiteralPath $script:PidPath) {
            Remove-Item -LiteralPath $script:PidPath -Force
        }
    }
}

function Start-TransportProcess {
    Stop-TransportProcess
    $arguments = @(
        'run', '--config', ('"{0}"' -f $script:ConfigPath),
        '--pid', ('"{0}"' -f $script:PidPath),
        '--log', ('"{0}"' -f $script:LogPath)
    )
    Start-Process -FilePath $script:ExecutablePath -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $client = [Net.Sockets.TcpClient]::new()
            $async = $client.BeginConnect('127.0.0.1', $script:ListenPort, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne(250)) {
                $client.EndConnect($async)
                $async.AsyncWaitHandle.Close()
                $client.Close()
                Write-TransportLog OK 'Background transport is accepting local connections.'
                return
            }
            $async.AsyncWaitHandle.Close()
            $client.Close()
        }
        catch {
            Start-Sleep -Milliseconds 200
        }
    }
    throw 'Background transport did not start within 10 seconds. Check transport.log.'
}

function Test-TransportListener {
    param([int]$TimeoutMilliseconds = 500)

    $client = [Net.Sockets.TcpClient]::new()
    $async = $null
    try {
        $async = $client.BeginConnect('127.0.0.1', $script:ListenPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $async) {
            $async.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Show-FailOpenNotification {
    $message = 'geminUp stopped after an error. Previous Windows proxy settings were restored, so normal internet access remains available. Gemini proxy protection is OFF. Open geminUp to repair it.'
    $msgPath = Join-Path $env:WINDIR 'System32\msg.exe'
    if (-not (Test-Path -LiteralPath $msgPath -PathType Leaf)) {
        Write-TransportFileLog WARN 'Cannot notify the signed-in user because msg.exe is unavailable.'
        return
    }
    try {
        $notification = Start-Process -FilePath $msgPath -ArgumentList @('*', '/TIME:120', $message) `
            -WindowStyle Hidden -Wait -PassThru
        if ($notification.ExitCode -ne 0) {
            Write-TransportFileLog WARN "User notification exited with code $($notification.ExitCode)."
        }
    }
    catch {
        Write-TransportFileLog WARN "Cannot notify the signed-in user: $($_.Exception.Message)"
    }
}

function Invoke-TransportWatchdog {
    if (-not (Test-Path -LiteralPath $script:StatePath) -or
        -not (Test-Path -LiteralPath $script:ConfigPath) -or
        -not (Test-Path -LiteralPath $script:ExecutablePath)) {
        return
    }

    try {
        $settings = Get-Item -LiteralPath $script:InternetSettingsPath
        $proxyEnabled = [bool]$settings.GetValue('ProxyEnable', 0)
        $proxyServer = [string]$settings.GetValue('ProxyServer', '')
    }
    catch {
        Write-TransportFileLog ERROR "Watchdog cannot read Windows proxy settings: $($_.Exception.Message)"
        return
    }
    if (-not $proxyEnabled -or
        -not [string]::Equals($proxyServer, "127.0.0.1:$script:ListenPort", [StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    if (Test-TransportListener) {
        Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
        return
    }

    $previousFailures = 0
    if (Test-Path -LiteralPath $script:WatchdogStatePath) {
        try {
            $watchdogState = Read-JsonFile -Path $script:WatchdogStatePath
            if ($null -ne $watchdogState -and $watchdogState.PSObject.Properties.Name -contains 'ConsecutiveFailures') {
                $previousFailures = [Math]::Max(0, [int]$watchdogState.ConsecutiveFailures)
            }
        }
        catch {
            Write-TransportFileLog WARN "Ignoring damaged watchdog state: $($_.Exception.Message)"
        }
    }
    $failureCount = $previousFailures + 1
    Write-TransportFileLog WARN "Watchdog found no listener on 127.0.0.1:$script:ListenPort; recovery attempt $failureCount of 3."

    try {
        $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
        }
        Stop-TransportProcess
        Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
    }
    catch {
        Write-TransportFileLog ERROR "Watchdog could not restart transport: $($_.Exception.Message)"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-TransportListener -TimeoutMilliseconds 250) {
            Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
            Write-TransportFileLog OK 'Watchdog restarted the local transport successfully.'
            return
        }
        Start-Sleep -Milliseconds 250
    }

    Save-JsonFile -Path $script:WatchdogStatePath -Value ([PSCustomObject]@{
            ConsecutiveFailures = $failureCount
            FailOpen = $false
            UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
        })
    if ($failureCount -lt 3) {
        return
    }

    try {
        Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        Stop-TransportProcess
        $state = Read-JsonFile -Path $script:StatePath
        if ($null -eq $state) {
            throw 'Install state is missing.'
        }
        Restore-AntigravityShortcuts -State $state
        Restore-SystemProxyAndPolicies -State $state
    }
    catch {
        Write-TransportFileLog ERROR "Cannot restore all previous proxy settings: $($_.Exception.Message)"
        try {
            New-ItemProperty -LiteralPath $script:InternetSettingsPath -Name 'ProxyEnable' `
                -Value 0 -PropertyType DWord -Force | Out-Null
            Notify-InternetSettingsChanged
        }
        catch {
            Write-TransportFileLog ERROR "Emergency proxy disable also failed: $($_.Exception.Message)"
            return
        }
    }

    Save-JsonFile -Path $script:WatchdogStatePath -Value ([PSCustomObject]@{
            ConsecutiveFailures = $failureCount
            FailOpen = $true
            UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
        })
    Write-TransportFileLog ERROR 'Transport recovery failed three times. Previous Windows proxy settings were restored; Gemini proxy protection is OFF.'
    Show-FailOpenNotification
}

function Register-TransportTask {
    Copy-Item -LiteralPath $PSCommandPath -Destination $script:ControllerPath -Force
    $taskAction = New-ScheduledTaskAction -Execute $script:ExecutablePath -Argument (
        'run --config "{0}" --pid "{1}" --log "{2}"' -f $script:ConfigPath, $script:PidPath, $script:LogPath)
    $triggers = @(
        New-ScheduledTaskTrigger -AtStartup
        New-ScheduledTaskTrigger -AtLogOn
    )
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $script:TaskName -Action $taskAction -Trigger $triggers `
        -Principal $principal -Settings $settings -Description 'Routes Gemini and Antigravity dependencies through a user-provided SOCKS5 proxy.' `
        -Force | Out-Null

    $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $watchdogAction = New-ScheduledTaskAction -Execute $powershellPath -Argument (
        '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action watchdog' -f $script:ControllerPath)
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $watchdogSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $script:WatchdogTaskName -Action $watchdogAction -Trigger $watchdogTrigger `
        -Principal $principal -Settings $watchdogSettings -Description 'Restarts geminUp or restores Windows proxy settings after repeated local transport failures.' `
        -Force | Out-Null
    Write-TransportLog OK 'Machine-wide startup, logon recovery and watchdog tasks registered under SYSTEM.'
}

function Unregister-TransportTask {
    foreach ($taskName in @($script:TaskName, $script:WatchdogTaskName)) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
    Write-TransportLog OK 'Autostart and watchdog tasks removed.'
}

function Test-LocalTransport {
    param([bool]$YouTubeEnabled = $false)

    $proxyUrl = 'http://127.0.0.1:{0}' -f $script:ListenPort
    $checks = @(
        [PSCustomObject]@{ Name = 'Direct route'; Uri = 'https://example.com/' },
        [PSCustomObject]@{ Name = 'Gemini SOCKS route'; Uri = 'https://gemini.google.com/' }
    )
    if ($YouTubeEnabled) {
        $checks += [PSCustomObject]@{ Name = 'YouTube SOCKS route'; Uri = 'https://www.youtube.com/' }
    }
    foreach ($check in $checks) {
        try {
            $response = Invoke-WebRequest -Uri $check.Uri -Proxy $proxyUrl -Method Head -TimeoutSec 20 `
                -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
            Write-TransportLog OK "$($check.Name) answered with HTTP $([int]$response.StatusCode)."
        }
        catch {
            $status = $null
            if ($_.Exception.Response) {
                $status = [int]$_.Exception.Response.StatusCode
            }
            if ($status -ge 300 -and $status -lt 500) {
                Write-TransportLog OK "$($check.Name) answered with HTTP $status."
            }
            else {
                throw "$($check.Name) failed: $($_.Exception.Message)"
            }
        }
    }
}

function Get-TransportProcess {
    if (-not (Test-Path -LiteralPath $script:PidPath)) {
        return $null
    }
    $rawPid = Get-Content -LiteralPath $script:PidPath -Raw -Encoding utf8
    $transportPid = 0
    if (-not [int]::TryParse($rawPid.Trim(), [ref]$transportPid)) {
        return $null
    }
    $process = Get-Process -Id $transportPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    try {
        if (-not [string]::Equals($process.Path, $script:ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
            return $null
        }
    }
    catch {
        return $null
    }
    return $process
}

function Show-TransportStatus {
    $installed = Test-Path -LiteralPath $script:StatePath
    $configured = Test-Path -LiteralPath $script:ConfigPath
    $process = Get-TransportProcess
    $proxyEnabled = $false
    $proxyServer = ''
    try {
        $settings = Get-Item -LiteralPath $script:InternetSettingsPath
        $proxyEnabled = [bool]$settings.GetValue('ProxyEnable', 0)
        $proxyServer = [string]$settings.GetValue('ProxyServer', '')
    }
    catch {
        Write-TransportLog WARN "Cannot read machine proxy state: $($_.Exception.Message)"
    }

    Write-Host ''
    Write-Host 'geminUp' -ForegroundColor Green
    Write-Host ('  Version:       {0}' -f $script:TransportVersion)
    Write-Host ('  Installed:     {0}' -f $installed)
    Write-Host ('  SOCKS stored:  {0}' -f $configured)
    Write-Host ('  Process:       {0}' -f $(if ($null -ne $process) { "running (PID $($process.Id))" } else { 'stopped' }))
    Write-Host ('  Machine proxy: {0} {1}' -f $proxyEnabled, $proxyServer)
    $failOpen = $false
    if (Test-Path -LiteralPath $script:WatchdogStatePath) {
        try {
            $watchdogState = Read-JsonFile -Path $script:WatchdogStatePath
            $failOpen = $null -ne $watchdogState -and
                $watchdogState.PSObject.Properties.Name -contains 'FailOpen' -and [bool]$watchdogState.FailOpen
        }
        catch {
            Write-TransportLog WARN "Cannot read watchdog state: $($_.Exception.Message)"
        }
    }
    Write-Host ('  Fail-safe:     {0}' -f $(if ($failOpen) { 'OPEN - proxy protection is OFF' } else { 'armed' }))
    $state = Read-JsonFile -Path $script:StatePath
    $youtubeEnabled = Test-YouTubeRoutingEnabled -State $state
    $shortcutCount = if ($null -ne $state -and
        $state.PSObject.Properties.Name -contains 'AntigravityShortcutBackups') {
        @($state.AntigravityShortcutBackups).Count
    } else { 0 }
    Write-Host ('  Antigravity:   {0}' -f $(if ($shortcutCount -gt 0) { "$shortcutCount managed shortcut(s)" } else { 'not process-routed' }))
    Write-Host ('  YouTube:       {0}' -f $(if ($youtubeEnabled) { 'enabled' } else { 'disabled' }))
    $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    Write-Host ('  Autostart:     {0}' -f ($null -ne $task))
    $argonStatus = Get-ArgonBridgeStatus
    if ($argonStatus.Installed -or $argonStatus.Listening) {
        $argonLabel = if ($argonStatus.Listening) { "running (PID $($argonStatus.Pid))" } else { 'stopped' }
        Write-Host ('  Argon bridge:  {0} on port {1}' -f $argonLabel, $script:ArgonListenPort)
    }
}

function Enable-Transport {
    Assert-SupportedWindows
    Assert-Administrator
    $hadConfig = Test-Path -LiteralPath $script:ConfigPath
    $oldConfigBytes = if ($hadConfig) { [IO.File]::ReadAllBytes($script:ConfigPath) } else { $null }
    $state = Read-JsonFile -Path $script:StatePath
    $youtubeEnabled = Test-YouTubeRoutingEnabled -State $state
    try {
        Build-TransportExecutable
        Invoke-SecureProxyConfiguration -YouTubeEnabled $youtubeEnabled
        if ($null -eq $state) {
            $state = New-TransportState
            Save-JsonFile -Path $script:StatePath -Value $state
        }
        Set-SystemProxyAndPolicies -State $state
        Register-TransportTask
        Start-TransportProcess
        Test-LocalTransport -YouTubeEnabled $youtubeEnabled
        Set-AntigravityShortcutRouting -State $state
        Invoke-AntigravityBinaryPatch -Direction Apply | Out-Null
        Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
        Write-Host ''
        Write-Host '========================================' -ForegroundColor Green
        Write-Host '  SUCCESSFUL: geminUp is enabled' -ForegroundColor Green
        Write-Host '========================================' -ForegroundColor Green
        Write-TransportLog OK 'Restart open browsers and fully exit/reopen Antigravity to drop old direct connections.'
    }
    catch {
        $failure = $_.Exception.Message
        try {
            Stop-TransportProcess
            if ($hadConfig -and $null -ne $oldConfigBytes) {
                [IO.File]::WriteAllBytes($script:ConfigPath, $oldConfigBytes)
                $state = Read-JsonFile -Path $script:StatePath
                if ($null -ne $state) {
                    Set-SystemProxyAndPolicies -State $state
                    Register-TransportTask
                    Start-TransportProcess
                    Write-TransportLog WARN 'Previous working proxy configuration restored.'
                }
            }
            else {
                $state = Read-JsonFile -Path $script:StatePath
                if ($null -ne $state) {
                    Restore-SystemProxyAndPolicies -State $state
                    Unregister-TransportTask
                    Remove-Item -LiteralPath $script:StatePath -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath $script:ConfigPath -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            Write-TransportLog ERROR "Rollback also failed: $($_.Exception.Message)"
        }
        throw $failure
    }
}

function Refresh-Transport {
    Assert-SupportedWindows
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $script:ConfigPath) -or
        -not (Test-Path -LiteralPath $script:StatePath)) {
        throw 'geminUp is not configured yet. Use menu option 1 first.'
    }

    $state = Read-JsonFile -Path $script:StatePath
    $youtubeEnabled = Test-YouTubeRoutingEnabled -State $state
    try {
        Build-TransportExecutable -Force
        Invoke-DomainConfigurationRefresh -YouTubeEnabled $youtubeEnabled
        Set-SystemProxyAndPolicies -State $state
        Register-TransportTask
        Start-TransportProcess
        Test-LocalTransport -YouTubeEnabled $youtubeEnabled
        Set-AntigravityShortcutRouting -State $state
        Invoke-AntigravityBinaryPatch -Direction Apply | Out-Null
        Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
        Write-Host ''
        Write-Host '========================================' -ForegroundColor Green
        Write-Host '  SUCCESSFUL: geminUp was refreshed' -ForegroundColor Green
        Write-Host '========================================' -ForegroundColor Green
        Write-TransportLog OK 'Fully exit and reopen Antigravity and open browsers to use the refreshed transport.'
    }
    catch {
        $failure = $_.Exception.Message
        try {
            if ((Test-Path -LiteralPath $script:ExecutablePath) -and
                (Test-Path -LiteralPath $script:ConfigPath)) {
                Register-TransportTask
                Start-TransportProcess
                Write-TransportLog WARN 'Transport was restarted after the refresh failure.'
            }
        }
        catch {
            Write-TransportLog ERROR "Refresh recovery also failed: $($_.Exception.Message)"
        }
        throw $failure
    }
}

function Update-AndRefreshTransport {
    Assert-SupportedWindows
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $script:ConfigPath) -or
        -not (Test-Path -LiteralPath $script:StatePath)) {
        throw 'geminUp is not configured yet. Use menu option 1 first.'
    }

    try {
        if (-not (Test-Path -LiteralPath $script:UpdateModulePath -PathType Leaf)) {
            throw "Update module is missing: $script:UpdateModulePath"
        }
        Import-Module -Name $script:UpdateModulePath -Force
        Write-TransportLog INFO 'Checking GitHub for the latest verified geminUp release...'
        $release = Get-GeminUpLatestVerifiedRelease
    }
    catch {
        Write-TransportLog WARN "GitHub update was not applied: $($_.Exception.Message)"
        Write-TransportLog WARN 'Rebuilding and restarting geminUp from the current local files.'
        Refresh-Transport
        return
    }

    $currentVersion = [Version]$script:TransportVersion
    if ($release.Version -le $currentVersion) {
        if ($release.Version -lt $currentVersion) {
            Write-TransportLog WARN (
                "Latest GitHub release $($release.Version) is older than local version $currentVersion; downgrade blocked.")
        }
        else {
            Write-TransportLog INFO "geminUp $currentVersion is already the latest release."
        }
        Refresh-Transport
        return
    }

    Write-TransportLog OK (
        "Verified geminUp $($release.Version) downloaded to $($release.ReleaseRoot)")
    $powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powershellPath -NoLogo -NoProfile -ExecutionPolicy Bypass `
        -File $release.ControllerPath -Action refresh
    if ($LASTEXITCODE -ne 0) {
        throw "Downloaded geminUp $($release.Version) failed to apply (exit code $LASTEXITCODE)."
    }
}

function Switch-YouTubeRouting {
    Assert-SupportedWindows
    Assert-Administrator
    if (-not (Test-Path -LiteralPath $script:ConfigPath) -or
        -not (Test-Path -LiteralPath $script:StatePath)) {
        throw 'geminUp is not configured yet. Use menu option 1 first.'
    }

    $state = Read-JsonFile -Path $script:StatePath
    $wasEnabled = Test-YouTubeRoutingEnabled -State $state
    $enable = -not $wasEnabled
    $oldConfigBytes = [IO.File]::ReadAllBytes($script:ConfigPath)
    $oldStateBytes = [IO.File]::ReadAllBytes($script:StatePath)
    try {
        $state.Version = 4
        $state | Add-Member -NotePropertyName 'YouTubeEnabled' -NotePropertyValue $enable -Force
        Invoke-DomainConfigurationRefresh -YouTubeEnabled $enable
        Start-TransportProcess
        Test-LocalTransport -YouTubeEnabled $enable
        Save-JsonFile -Path $script:StatePath -Value $state
        Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
        Write-TransportLog OK ('YouTube routing is now {0}. Restart open browsers to drop old connections.' -f `
            $(if ($enable) { 'enabled' } else { 'disabled' }))
    }
    catch {
        $failure = $_.Exception.Message
        try {
            [IO.File]::WriteAllBytes($script:ConfigPath, $oldConfigBytes)
            [IO.File]::WriteAllBytes($script:StatePath, $oldStateBytes)
            Start-TransportProcess
            Write-TransportLog WARN 'Previous YouTube routing state restored.'
        }
        catch {
            Write-TransportLog ERROR "YouTube routing rollback also failed: $($_.Exception.Message)"
        }
        throw $failure
    }
}

function Disable-Transport {
    Assert-SupportedWindows
    Assert-Administrator
    Stop-TransportProcess
    Unregister-TransportTask
    $state = Read-JsonFile -Path $script:StatePath
    if ($null -ne $state) {
        Restore-AntigravityShortcuts -State $state
        Restore-SystemProxyAndPolicies -State $state
        Remove-Item -LiteralPath $script:StatePath -Force
    }
    else {
        Write-TransportLog WARN 'Install state is missing; existing Windows proxy settings were not modified.'
    }
    if (Test-Path -LiteralPath $script:ConfigPath) {
        Remove-Item -LiteralPath $script:ConfigPath -Force
    }
    Remove-Item -LiteralPath $script:WatchdogStatePath -Force -ErrorAction SilentlyContinue
    Write-TransportLog OK 'geminUp disabled. Encrypted SOCKS5 credentials removed.'
}

function Initialize-ArgonDirectory {
    if (-not (Test-Path -LiteralPath $script:ArgonDir)) {
        New-Item -ItemType Directory -Path $script:ArgonDir -Force | Out-Null
    }
}

function Test-ArgonListener {
    param([int]$TimeoutMilliseconds = 500)

    $client = [Net.Sockets.TcpClient]::new()
    $async = $null
    try {
        $async = $client.BeginConnect('127.0.0.1', $script:ArgonListenPort, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $async) {
            $async.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Get-ArgonBridgeStatus {
    $installed = Test-Path -LiteralPath $script:ArgonExecutablePath -PathType Leaf
    $listening = Test-ArgonListener -TimeoutMilliseconds 300
    $running = $false
    $pidValue = 0

    if (Test-Path -LiteralPath $script:ArgonPidPath) {
        $rawPid = Get-Content -LiteralPath $script:ArgonPidPath -Raw -Encoding utf8 -ErrorAction SilentlyContinue
        if (-not [string]::IsNullOrWhiteSpace($rawPid) -and [int]::TryParse($rawPid.Trim(), [ref]$pidValue)) {
            $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            if ($null -ne $proc -and -not $proc.HasExited) {
                $running = $true
            }
        }
    }

    if (-not $running -and $listening) {
        $procs = @(Get-Process -Name 'gemini-web2api' -ErrorAction SilentlyContinue)
        if ($procs.Count -gt 0) {
            $running = $true
            $pidValue = $procs[0].Id
        }
    }

    $cookieConfigured = $false
    if ($listening) {
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:ArgonListenPort)/admin/api/cookies" -Method Get -TimeoutSec 2 -ErrorAction Stop
            if ($null -ne $resp -and ($resp.PSObject.Properties.Name -contains 'total') -and [int]$resp.total -gt 0) {
                $cookieConfigured = $true
            }
        }
        catch { }
    }

    return [PSCustomObject]@{
        Installed = $installed
        Running = $running
        Listening = $listening
        Pid = $pidValue
        CookieConfigured = $cookieConfigured
    }
}

function Install-ArgonBinary {
    Initialize-ArgonDirectory

    if (Test-Path -LiteralPath $script:ArgonExecutablePath -PathType Leaf) {
        try {
            $hash = (Get-FileHash -LiteralPath $script:ArgonExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($hash -eq $script:ArgonSha256.ToLowerInvariant()) {
                Write-TransportLog OK 'Native Argon bridge executable is verified and ready.'
                return
            }
            Write-TransportLog WARN 'Existing binary hash mismatch; re-downloading official release...'
        }
        catch {
            Write-TransportLog WARN "Could not verify existing binary hash: $($_.Exception.Message)"
        }
    }

    Write-TransportLog INFO "Downloading official native Argon bridge ($($script:ArgonVersion))..."
    $tempFile = Join-Path $script:ArgonDir ("gemini-web2api-download-" + [Guid]::NewGuid().ToString('N') + ".exe")

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
        $webClient = [Net.WebClient]::new()
        try {
            $webClient.DownloadFile($script:ArgonDownloadUri, $tempFile)
        }
        finally {
            $webClient.Dispose()
        }

        $downloadedHash = (Get-FileHash -LiteralPath $tempFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($downloadedHash -ne $script:ArgonSha256.ToLowerInvariant()) {
            throw "Downloaded binary SHA-256 hash mismatch: expected $($script:ArgonSha256), got $downloadedHash."
        }

        Stop-ArgonBridge -Silent
        Move-Item -LiteralPath $tempFile -Destination $script:ArgonExecutablePath -Force
        Write-TransportLog OK "Argon binary installed and verified: $script:ArgonExecutablePath"
    }
    catch {
        if (Test-Path -LiteralPath $tempFile) {
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        }
        throw "Failed to download native Argon bridge: $($_.Exception.Message)"
    }
}

function Save-ArgonConfigFile {
    Initialize-ArgonDirectory
    $cfg = @{
        port = $script:ArgonListenPort
        host = '127.0.0.1'
        default_model = 'gemini-4-argon'
        log_requests = $true
        db_path = $script:ArgonDbPath
        admin_token = ''
        admin_enabled = $true
        temporary_chat = $true
        multi_turn = $false
        gemini_bl_auto = $true
        impersonate = 'chrome_146'
    }
    $json = ConvertTo-Json -InputObject $cfg -Depth 4
    [IO.File]::WriteAllText($script:ArgonConfigPath, $json, [Text.UTF8Encoding]::new($false))
}

function Start-ArgonBridge {
    Assert-SupportedWindows
    Assert-Administrator

    Install-ArgonBinary
    Save-ArgonConfigFile

    $status = Get-ArgonBridgeStatus
    if ($status.Running -and $status.Listening) {
        Write-TransportLog OK "Argon bridge is already running (PID: $($status.Pid))."
        return
    }

    Stop-ArgonBridge -Silent

    $arguments = @(
        '--config', ('"{0}"' -f $script:ArgonConfigPath),
        '--port', $script:ArgonListenPort
    )

    if (Test-Path -LiteralPath $script:ArgonCookieFilePath) {
        $arguments += @('--cookie-file', ('"{0}"' -f $script:ArgonCookieFilePath))
    }

    if (Test-TransportListener -TimeoutMilliseconds 300) {
        $arguments += @('--proxy', ("socks5://127.0.0.1:$script:ListenPort"))
        Write-TransportLog INFO "Routing Argon bridge upstream via local geminUp SOCKS5 (127.0.0.1:$script:ListenPort)."
    }
    else {
        Write-TransportLog INFO 'geminUp SOCKS5 is not running; Argon bridge will connect directly.'
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $script:ArgonExecutablePath
    $startInfo.Arguments = ($arguments -join ' ')
    $startInfo.WorkingDirectory = $script:ArgonDir
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.CreateNoWindow = $true
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $false
    $startInfo.RedirectStandardError = $false

    $proc = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $proc) {
        throw 'Failed to start Argon bridge process.'
    }

    [IO.File]::WriteAllText($script:ArgonPidPath, $proc.Id.ToString(), [Text.UTF8Encoding]::new($false))

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-ArgonListener -TimeoutMilliseconds 300) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 300
    }

    if (-not $ready) {
        Stop-ArgonBridge -Silent
        throw 'Argon bridge started, but listener did not respond on port 8083 within 10 seconds.'
    }

    try {
        $taskAction = New-ScheduledTaskAction -Execute $script:ArgonExecutablePath -Argument ($arguments -join ' ') -WorkingDirectory $script:ArgonDir
        $triggers = @(
            New-ScheduledTaskTrigger -AtStartup
            New-ScheduledTaskTrigger -AtLogOn
        )
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -MultipleInstances IgnoreNew -StartWhenAvailable
        Register-ScheduledTask -TaskName $script:ArgonTaskName -Action $taskAction -Trigger $triggers `
            -Principal $principal -Settings $settings -Description 'geminUp native Gemini 4 Argon bridge daemon.' `
            -Force | Out-Null
    }
    catch {
        Write-TransportLog WARN "Could not register scheduled task: $($_.Exception.Message)"
    }

    Write-TransportLog OK "Argon bridge started successfully on http://127.0.0.1:$($script:ArgonListenPort)/v1 (PID: $($proc.Id))."
}

function Stop-ArgonBridge {
    param([switch]$Silent)

    try {
        Unregister-ScheduledTask -TaskName $script:ArgonTaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
    } catch { }

    $stoppedAny = $false
    if (Test-Path -LiteralPath $script:ArgonPidPath) {
        try {
            $rawPid = Get-Content -LiteralPath $script:ArgonPidPath -Raw -Encoding utf8
            $pidValue = 0
            if ([int]::TryParse($rawPid.Trim(), [ref]$pidValue)) {
                $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
                if ($null -ne $proc -and -not $proc.HasExited) {
                    $proc.Kill()
                    $proc.WaitForExit(3000) | Out-Null
                    $stoppedAny = $true
                }
            }
        }
        catch { }
        finally {
            Remove-Item -LiteralPath $script:ArgonPidPath -Force -ErrorAction SilentlyContinue
        }
    }

    $lingering = @(Get-Process -Name 'gemini-web2api' -ErrorAction SilentlyContinue)
    foreach ($p in $lingering) {
        try {
            $p.Kill()
            $p.WaitForExit(2000) | Out-Null
            $stoppedAny = $true
        } catch { }
    }

    if (-not $Silent) {
        if ($stoppedAny) {
            Write-TransportLog OK 'Argon bridge process stopped.'
        } else {
            Write-TransportLog INFO 'Argon bridge is not running.'
        }
    }
}

function Set-ArgonCookie {
    Assert-SupportedWindows
    Assert-Administrator

    Write-Host ''
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host '  Connect Google Account Cookie for Gemini 4 Argon' -ForegroundColor Cyan
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host '1. In browser, log in to gemini.google.com with your Pro/paid Google account.' -ForegroundColor Yellow
    Write-Host '2. Press F12 -> Network tab -> F5 -> find any request (e.g. batchexecute).' -ForegroundColor Yellow
    Write-Host '3. Copy Request Headers -> "Cookie" (or copy via Cookie-Editor extension).' -ForegroundColor Yellow
    Write-Host '   (Required items: SAPISID, SID, HSID, SSID, APISID, __Secure-1PSID, etc.)' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host 'How would you like to provide the cookie?' -ForegroundColor Cyan
    Write-Host '  1. Read directly from Windows Clipboard (Recommended - avoids console length limits)'
    Write-Host '  2. Read from file (e.g. cookie.txt)'
    Write-Host '  3. Paste manually'
    Write-Host ''

    $choice = Read-Host 'Select 1-3 [Default: 1]'
    if ([string]::IsNullOrWhiteSpace($choice)) { $choice = '1' }

    $cookie = ''
    switch ($choice) {
        '1' {
            try {
                $cookie = Get-Clipboard -Raw -ErrorAction Stop
            } catch {
                Write-TransportLog ERROR "Cannot read clipboard: $($_.Exception.Message)"
                return
            }
            if ([string]::IsNullOrWhiteSpace($cookie)) {
                Write-TransportLog WARN 'Clipboard is empty. Copy the cookie first and try again.'
                return
            }
            Write-TransportLog OK "Read $($cookie.Length) characters from clipboard."
            break
        }
        '2' {
            $filePath = Read-Host 'Enter full path to cookie file'
            if ([string]::IsNullOrWhiteSpace($filePath) -or -not (Test-Path -LiteralPath $filePath)) {
                Write-TransportLog WARN 'File not found. Operation cancelled.'
                return
            }
            $cookie = Get-Content -LiteralPath $filePath -Raw -Encoding utf8
            break
        }
        '3' {
            $cookie = Read-Host 'Paste Cookie'
            break
        }
        default {
            Write-TransportLog WARN 'Invalid choice.'
            return
        }
    }

    if ([string]::IsNullOrWhiteSpace($cookie)) {
        Write-TransportLog WARN 'Cookie content is empty. Operation cancelled.'
        return
    }

    # Clean up common header prefixes, whitespace, or enclosing quotes
    $cookie = $cookie.Trim()
    $cookie = $cookie -replace '^(?i)cookie:\s*', ''
    $cookie = $cookie.Trim().Trim('"').Trim("'")

    if ($cookie -notmatch '(?i)SAPISID') {
        Write-TransportLog WARN 'Warning: "SAPISID" was not found in the cookie string.'
        Write-TransportLog WARN 'Make sure you copied the full Request Header "Cookie" from gemini.google.com.'
        $proceed = Read-Host 'Proceed anyway? (y/N)'
        if ($proceed -notmatch '^(?i)y') {
            Write-TransportLog WARN 'Cancelled.'
            return
        }
    }

    # Ensure bridge directory exists and save cookie file
    Initialize-ArgonDirectory
    [IO.File]::WriteAllText($script:ArgonCookieFilePath, $cookie, [Text.UTF8Encoding]::new($false))
    Write-TransportLog OK "Saved cookie to local file: $script:ArgonCookieFilePath"

    # Ensure bridge is running
    $status = Get-ArgonBridgeStatus
    if (-not $status.Listening) {
        Write-TransportLog INFO 'Starting Argon bridge daemon...'
        Start-ArgonBridge
    }

    # Post cookie to bridge API as UTF-8 bytes to prevent encoding corruption on non-English locales
    $bodyObj = @{
        label = 'GoogleProAccount'
        cookie = $cookie
        note = ('Added via geminUp on ' + (Get-Date).ToString('yyyy-MM-dd HH:mm'))
    }
    $json = ConvertTo-Json -InputObject $bodyObj -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)

    try {
        $addResp = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:ArgonListenPort)/admin/api/cookies" `
            -Method Post -Body $bytes -ContentType 'application/json' -TimeoutSec 10 -ErrorAction Stop

        $acctId = $addResp.id
        Write-TransportLog OK "Account cookie saved into bridge pool (Account ID: $acctId)."

        Write-TransportLog INFO 'Checking cookie health with Google servers...'
        $checkResp = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:ArgonListenPort)/admin/api/cookies/$acctId/check" `
            -Method Post -TimeoutSec 15 -ErrorAction Stop

        if ($null -ne $checkResp -and ($checkResp.PSObject.Properties.Name -contains 'ok') -and $checkResp.ok -eq $true) {
            Write-TransportLog OK 'Cookie verified successfully! Gemini 4 Argon is unlocked and active.'
        }
        else {
            $msg = if ($null -ne $checkResp -and ($checkResp.PSObject.Properties.Name -contains 'detail')) { $checkResp.detail } else { 'Validation error' }
            Write-TransportLog WARN "Cookie check response: $msg (Check if your account has Gemini Pro/Argon access on gemini.google.com)."
        }
    }
    catch {
        $serverDetail = ''
        if ($_.Exception.Response) {
            try {
                $sr = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
                $serverDetail = $sr.ReadToEnd()
            } catch { }
        }
        $msg = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($serverDetail)) {
            $msg += " | Server details: $serverDetail"
        }
        Write-TransportLog ERROR "Failed to configure cookie via bridge API: $msg"
    }
}

function Test-ArgonPipeline {
    $status = Get-ArgonBridgeStatus
    if (-not $status.Listening) {
        Write-TransportLog WARN 'Argon bridge is not running. Select option 1 to start it first.'
        return
    }

    Write-TransportLog INFO "Checking available models on http://127.0.0.1:$($script:ArgonListenPort)/v1/models..."
    try {
        $modelsResp = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:ArgonListenPort)/v1/models" -Method Get -TimeoutSec 5 -ErrorAction Stop
        $modelIds = @()
        if ($null -ne $modelsResp -and ($modelsResp.PSObject.Properties.Name -contains 'data')) {
            $modelIds = @($modelsResp.data | Select-Object -ExpandProperty id)
        }
        Write-TransportLog OK "Available models: $($modelIds -join ', ')"

        if ($modelIds -contains 'gemini-4-argon' -or $modelIds -contains 'gemini-4-argon-thinking-medium') {
            Write-TransportLog OK 'gemini-4-argon is present in model catalog!'
        }
        else {
            Write-TransportLog WARN 'gemini-4-argon is not listed yet (make sure a valid Google Pro cookie is imported).'
        }

        Write-TransportLog INFO 'Sending test prompt to gemini-4-argon...'
        $payloadObj = @{
            model = 'gemini-4-argon'
            messages = @(
                @{ role = 'user'; content = 'Respond with the single word: OK' }
            )
            max_tokens = 10
        }
        $payloadJson = ConvertTo-Json -InputObject $payloadObj -Compress
        $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payloadJson)

        $chatResp = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:ArgonListenPort)/v1/chat/completions" `
            -Method Post -Body $payloadBytes -ContentType 'application/json' -TimeoutSec 25 -ErrorAction Stop

        $reply = ''
        $actualModel = ''
        if ($null -ne $chatResp -and ($chatResp.PSObject.Properties.Name -contains 'choices') -and $chatResp.choices.Count -gt 0) {
            $reply = $chatResp.choices[0].message.content
        }
        if ($null -ne $chatResp -and ($chatResp.PSObject.Properties.Name -contains 'model')) {
            $actualModel = $chatResp.model
        }

        Write-Host ''
        Write-Host '--- Argon Test Response ---' -ForegroundColor Green
        Write-Host "Model used: $actualModel" -ForegroundColor Cyan
        Write-Host "Reply:      $reply" -ForegroundColor White
        Write-Host '---------------------------' -ForegroundColor Green

        if ($actualModel -eq 'gemini-4-argon') {
            Write-TransportLog OK 'SUCCESS: Gemini 4 Argon is working natively without downgrade!'
        }
        elseif ($actualModel -match 'flash-lite') {
            Write-TransportLog WARN "Response was silently downgraded to $actualModel. Verify that the configured Google account has Pro/Ultra access with Gemini 4 Argon visible on gemini.google.com."
        }
    }
    catch {
        $serverDetail = ''
        if ($_.Exception.Response) {
            try {
                $sr = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
                $serverDetail = $sr.ReadToEnd()
            } catch { }
        }
        $msg = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace($serverDetail)) {
            $msg += " | Server details: $serverDetail"
        }
        Write-TransportLog ERROR "Test failed: $msg"
    }
}

function Show-ArgonConnectionInfo {
    Write-Host ''
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host '  How to Use Gemini 4 Argon in Antigravity / IDE' -ForegroundColor Cyan
    Write-Host '==================================================' -ForegroundColor Cyan
    Write-Host 'The bridge provides a standard OpenAI-compatible API on:' -ForegroundColor White
    Write-Host "  Endpoint: http://127.0.0.1:$($script:ArgonListenPort)/v1" -ForegroundColor Green
    Write-Host '  API Key:  (any string, e.g. "geminup")' -ForegroundColor Green
    Write-Host '  Models:   gemini-4-argon' -ForegroundColor Green
    Write-Host '            gemini-4-argon-thinking-medium' -ForegroundColor Green
    Write-Host '            gemini-3.8-flash' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Connecting in Roo Code / Cline / Continue / Cursor / OpenCode:' -ForegroundColor Yellow
    Write-Host '  1. Open Extensions -> Settings (Roo Code / Cline / etc.)'
    Write-Host '  2. Provider: OpenAI Compatible'
    Write-Host "  3. Base URL: http://127.0.0.1:$($script:ArgonListenPort)/v1"
    Write-Host '  4. API Key: geminup'
    Write-Host '  5. Model ID: gemini-4-argon'
    Write-Host ''
    Write-Host 'Admin Dashboard (Web UI):' -ForegroundColor Yellow
    Write-Host "  http://127.0.0.1:$($script:ArgonListenPort)/admin" -ForegroundColor Cyan
    Write-Host ''
}

function Show-ArgonMenu {
    while ($true) {
        Clear-Host
        $status = Get-ArgonBridgeStatus
        $statusLabel = if ($status.Listening) { "RUNNING (PID: $($status.Pid))" } else { 'STOPPED' }
        $statusColor = if ($status.Listening) { 'Green' } else { 'Yellow' }
        $cookieLabel = if ($status.CookieConfigured) { 'CONFIGURED' } else { 'NOT SET' }
        $cookieColor = if ($status.CookieConfigured) { 'Green' } else { 'Yellow' }
        $transportRoute = if (Test-TransportListener -TimeoutMilliseconds 250) { "SOCKS5 (127.0.0.1:$script:ListenPort)" } else { 'Direct' }

        Write-Host '==================================================' -ForegroundColor Cyan
        Write-Host '  Gemini 4 Argon Pipeline (Native Windows Bridge)' -ForegroundColor Cyan
        Write-Host '==================================================' -ForegroundColor Cyan
        Write-Host -NoNewline '  Bridge Status: '
        Write-Host $statusLabel -ForegroundColor $statusColor
        Write-Host -NoNewline '  Google Cookie: '
        Write-Host $cookieLabel -ForegroundColor $cookieColor
        Write-Host "  Upstream:      $transportRoute" -ForegroundColor White
        Write-Host "  Local URL:     http://127.0.0.1:$($script:ArgonListenPort)/v1" -ForegroundColor DarkGray
        Write-Host ''
        Write-Host '  1. Enable / Start Argon Bridge'
        Write-Host '  2. Connect / Update Gemini Web Cookie'
        Write-Host '  3. Test Argon Model Status & Ping'
        Write-Host '  4. Stop Argon Bridge'
        Write-Host '  5. Connection Instructions for IDE'
        Write-Host '  6. Return to main menu'
        Write-Host ''

        $sub = Read-Host 'Select 1-6'
        try {
            switch ($sub) {
                '1' { Start-ArgonBridge; Start-Sleep -Seconds 2; break }
                '2' { Set-ArgonCookie; Start-Sleep -Seconds 2; break }
                '3' { Test-ArgonPipeline; Read-Host 'Press Enter to continue'; break }
                '4' { Stop-ArgonBridge; Start-Sleep -Seconds 1; break }
                '5' { Show-ArgonConnectionInfo; Read-Host 'Press Enter to continue'; break }
                '6' { return }
                default { Write-TransportLog WARN 'Enter 1, 2, 3, 4, 5 or 6.'; Start-Sleep -Seconds 2; continue }
            }
        }
        catch {
            Write-TransportLog ERROR $_.Exception.Message
            Start-Sleep -Seconds 2
        }
    }
}

function Show-Menu {
    while ($true) {
        Clear-Host
        Show-TransportStatus
        Write-Host ''
        Write-Host '  1. Enter SOCKS5 and enable'
        Write-Host '  2. Change SOCKS5'
        Write-Host '  3. Disable and remove from autostart'
        Write-Host '  4. Download/apply latest update and restart'
        $state = Read-JsonFile -Path $script:StatePath
        $youtubeAction = if (Test-YouTubeRoutingEnabled -State $state) { 'Disable' } else { 'Enable' }
        Write-Host '  5. Enable/disable YouTube routing'
        Write-Host '  6. Patch Antigravity binaries'
        Write-Host '  7. Roll back Antigravity binary patch'
        Write-Host '  8. Gemini 4 Argon pipeline (Native bridge)'
        Write-Host ''
        $selection = Read-Host 'Select 1-8'
        try {
            switch ($selection) {
                '1' { Enable-Transport; break }
                '2' { Enable-Transport; break }
                '3' { Disable-Transport; break }
                '4' { Update-AndRefreshTransport; break }
                '5' { Switch-YouTubeRouting; break }
                '6' { Invoke-AntigravityBinaryPatch -Direction Apply | Out-Null; break }
                '7' { Invoke-AntigravityBinaryPatch -Direction Rollback | Out-Null; break }
                '8' { Show-ArgonMenu; break }
                default { Write-TransportLog WARN 'Enter 1, 2, 3, 4, 5, 6, 7 or 8.'; Start-Sleep -Seconds 2; continue }
            }
        }
        catch {
            Write-TransportLog ERROR $_.Exception.Message
        }
        return
    }
}

try {
    switch ($Action) {
        'menu' { Show-Menu }
        'enable' { Enable-Transport }
        'change' { Enable-Transport }
        'refresh' { Refresh-Transport }
        'disable' { Disable-Transport }
        'status' { Show-TransportStatus }
        'watchdog' { Invoke-TransportWatchdog }
        'antigravity-patch' { Invoke-AntigravityBinaryPatch -Direction Apply | Out-Null }
        'antigravity-rollback' { Invoke-AntigravityBinaryPatch -Direction Rollback | Out-Null }
        'argon-menu' { Show-ArgonMenu }
        'argon-enable' { Start-ArgonBridge }
        'argon-disable' { Stop-ArgonBridge }
        'argon-status' { Get-ArgonBridgeStatus }
        'argon-cookie' { Set-ArgonCookie }
        'argon-test' { Test-ArgonPipeline }
    }
}
catch {
    Write-TransportLog ERROR $_.Exception.Message
    exit 1
}
