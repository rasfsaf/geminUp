[CmdletBinding()]
param(
    [ValidateSet('menu', 'enable', 'change', 'refresh', 'disable', 'status', 'watchdog')]
    [string]$Action = 'menu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TransportVersion = '1.4.1'
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
$script:InternetSettingsPath = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$script:InternetSettingsPolicyPath = 'HKLM:\Software\Policies\Microsoft\Windows\CurrentVersion\Internet Settings'
$script:FirefoxPolicyPath = 'HKLM:\Software\Policies\Mozilla\Firefox'
$script:FirefoxProxyPolicyPath = Join-Path $script:FirefoxPolicyPath 'Proxy'
$script:DotNet48InstallerUri = 'https://go.microsoft.com/fwlink/?linkid=2088631'

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
    Set-Acl -LiteralPath $script:InstallRoot -AclObject $security
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

function Show-Menu {
    while ($true) {
        Clear-Host
        Show-TransportStatus
        Write-Host ''
        Write-Host '  1. Enter SOCKS5 and enable'
        Write-Host '  2. Change SOCKS5'
        Write-Host '  3. Disable and remove from autostart'
        Write-Host '  4. Apply downloaded update and restart'
        $state = Read-JsonFile -Path $script:StatePath
        $youtubeAction = if (Test-YouTubeRoutingEnabled -State $state) { 'Disable' } else { 'Enable' }
        Write-Host ("  5. {0} YouTube routing" -f $youtubeAction)
        Write-Host ''
        $selection = Read-Host 'Select 1-5'
        try {
            switch ($selection) {
                '1' { Enable-Transport; break }
                '2' { Enable-Transport; break }
                '3' { Disable-Transport; break }
                '4' { Refresh-Transport; break }
                '5' { Switch-YouTubeRouting; break }
                default { Write-TransportLog WARN 'Enter 1, 2, 3, 4 or 5.'; Start-Sleep -Seconds 2; continue }
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
    }
}
catch {
    Write-TransportLog ERROR $_.Exception.Message
    exit 1
}
