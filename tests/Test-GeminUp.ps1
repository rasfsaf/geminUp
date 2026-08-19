[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
$sourcePath = Join-Path $projectRoot 'transport\GeminUp.cs'
$domainsPath = Join-Path $projectRoot 'transport\domains.txt'
$controllerPath = Join-Path $projectRoot 'geminUp.ps1'
$testRoot = Join-Path $env:TEMP ('geminUp-tests-' + [Guid]::NewGuid().ToString('N'))
$tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unsafe test directory path.'
}

$transportProcess = $null
$socksProcess = $null
$holdProcess = $null
$holdClients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Wait-TcpPort {
    param([int]$Port, [int]$Seconds = 15)

    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $result = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
            if ($result.AsyncWaitHandle.WaitOne(250)) {
                $client.EndConnect($result)
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 150
        }
        finally {
            $client.Close()
        }
    }
    throw "TCP port $Port did not become ready."
}

function Invoke-Configure {
    param([string]$Executable, [string]$ConfigPath, [int]$SocksPort)

    $testProxy = "127.0.0.1:${SocksPort}:test_user:test_password"
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = $testProxy | & $Executable configure --config $ConfigPath --domains $domainsPath 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    $testProxy = $null
    if ($exitCode -ne 0) {
        throw "Configuration failed: $($output -join [Environment]::NewLine)"
    }
    Write-Host ($output -join [Environment]::NewLine)
}

function Invoke-CurlCheck {
    param([string]$Uri, [int]$ProxyPort)

    $curl = (Get-Command curl.exe -ErrorAction Stop).Source
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $curl
    $start.Arguments = '--silent --show-error --max-time 30 --proxy "http://127.0.0.1:{0}" --noproxy "" --output NUL --write-out "%{{http_code}}" "{1}"' -f $ProxyPort, $Uri.Replace('"', '\"')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) {
        throw 'Cannot start curl.exe.'
    }
    $output = $process.StandardOutput.ReadToEnd().Trim()
    $errorOutput = $process.StandardError.ReadToEnd().Trim()
    $process.WaitForExit()
    $result = [PSCustomObject]@{
        Code = $output
        ExitCode = $process.ExitCode
        Error = $errorOutput
    }
    $process.Dispose()
    return $result
}

function Invoke-ConnectProbe {
    param([string]$HostName, [int]$ProxyPort)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.ReceiveTimeout = 30000
        $client.SendTimeout = 30000
        $client.Connect('127.0.0.1', $ProxyPort)
        $stream = $client.GetStream()
        $request = [Text.Encoding]::ASCII.GetBytes(
            "CONNECT ${HostName}:443 HTTP/1.1`r`nHost: ${HostName}:443`r`nConnection: close`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $buffer = [byte[]]::new(4096)
        try {
            $null = $stream.Read($buffer, 0, $buffer.Length)
        }
        catch [IO.IOException] {
            # The routing assertion below uses the SOCKS server's CONNECT record.
        }
    }
    finally {
        $client.Close()
    }
}

function Open-HoldTunnel {
    param([int]$TargetPort, [int]$ProxyPort)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.ReceiveTimeout = 10000
        $client.SendTimeout = 10000
        $client.Connect('127.0.0.1', $ProxyPort)
        $stream = $client.GetStream()
        $request = [Text.Encoding]::ASCII.GetBytes(
            "CONNECT 127.0.0.1:${TargetPort} HTTP/1.1`r`nHost: 127.0.0.1:${TargetPort}`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $response = [IO.MemoryStream]::new()
        $matched = 0
        $marker = [byte[]](13, 10, 13, 10)
        while ($response.Length -lt 4096 -and $matched -lt $marker.Length) {
            $value = $stream.ReadByte()
            if ($value -lt 0) { throw 'Transport closed a concurrency-test tunnel during setup.' }
            $response.WriteByte([byte]$value)
            if ($value -eq $marker[$matched]) { $matched++ }
            else { $matched = $(if ($value -eq $marker[0]) { 1 } else { 0 }) }
        }
        $status = [Text.Encoding]::ASCII.GetString($response.ToArray())
        $response.Dispose()
        if ($matched -ne $marker.Length -or -not $status.StartsWith('HTTP/1.1 200 ')) {
            throw "Transport rejected a concurrency-test tunnel: $status"
        }
        return $client
    }
    catch {
        $client.Close()
        throw
    }
}

try {
    New-Item -ItemType Directory -Path $resolvedTestRoot -Force | Out-Null

    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($controllerPath, [ref]$null, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) {
        throw "PowerShell parser errors: $($parseErrors.Message -join '; ')"
    }

    $compiler = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($null -eq $compiler) {
        throw '.NET Framework C# compiler is missing.'
    }

    $executable = Join-Path $resolvedTestRoot 'geminUp.test.exe'
    & $compiler /nologo /target:exe /optimize+ /platform:anycpu "/out:$executable" `
        /reference:System.Web.Extensions.dll /reference:System.Security.dll $sourcePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $executable)) {
        throw 'C# compilation failed.'
    }

    $probeSource = Join-Path $resolvedTestRoot 'AntigravityProbe.cs'
    $probeExecutable = Join-Path $resolvedTestRoot 'Antigravity.exe'
    $probeCode = @'
using System;
using System.IO;
using System.Text;

internal static class AntigravityProbe
{
    private static int Main(string[] args)
    {
        if (args.Length == 0) return 2;
        string[] names = new[]
        {
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GRPC_PROXY",
            "NO_PROXY", "GEMINUP_ANTIGRAVITY"
        };
        StringBuilder output = new StringBuilder();
        foreach (string name in names)
            output.AppendLine(name + "=" + (Environment.GetEnvironmentVariable(name) ?? string.Empty));
        output.AppendLine("ARGS=" + string.Join(" ", args));
        File.WriteAllText(args[0], output.ToString(), new UTF8Encoding(false));
        return 0;
    }
}
'@
    [IO.File]::WriteAllText($probeSource, $probeCode, [Text.UTF8Encoding]::new($false))
    & $compiler /nologo /target:exe /optimize+ /platform:anycpu "/out:$probeExecutable" $probeSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $probeExecutable)) {
        throw 'Antigravity launcher probe compilation failed.'
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -eq $python) {
        $python = Get-Command python -ErrorAction SilentlyContinue
    }
    if ($null -eq $python) {
        throw 'Python 3 is required for integration tests only.'
    }

    $holdPort = Get-FreeTcpPort
    $holdStdout = Join-Path $resolvedTestRoot 'hold-stdout.log'
    $holdStderr = Join-Path $resolvedTestRoot 'hold-stderr.log'
    $holdProcess = Start-Process -FilePath $python.Source -ArgumentList @(
        $([char]34 + (Join-Path $PSScriptRoot 'hold_open_server.py') + [char]34),
        '--port', $holdPort
    ) -RedirectStandardOutput $holdStdout -RedirectStandardError $holdStderr `
        -WindowStyle Hidden -PassThru
    Wait-TcpPort -Port $holdPort

    $socksPort = Get-FreeTcpPort
    $socksStdout = Join-Path $resolvedTestRoot 'socks-stdout.log'
    $socksStderr = Join-Path $resolvedTestRoot 'socks-stderr.log'
    $socksProcess = Start-Process -FilePath $python.Source -ArgumentList @(
        $([char]34 + (Join-Path $PSScriptRoot 'fake_socks5.py') + [char]34),
        '--port', $socksPort, '--username', 'test_user', '--password', 'test_password'
    ) -RedirectStandardOutput $socksStdout -RedirectStandardError $socksStderr `
        -WindowStyle Hidden -PassThru
    Wait-TcpPort -Port $socksPort

    $configPath = Join-Path $resolvedTestRoot 'config.json'
    Invoke-Configure -Executable $executable -ConfigPath $configPath -SocksPort $socksPort
    $refreshOutput = & $executable refresh-domains --config $configPath --domains $domainsPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Domain refresh failed: $($refreshOutput -join [Environment]::NewLine)"
    }
    $transportPort = Get-FreeTcpPort
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (@($config.ProxyPatterns) -notcontains 'antigravity.google.com') {
        throw 'Domain refresh did not store the Antigravity endpoint.'
    }
    $config.ListenPort = $transportPort
    [IO.File]::WriteAllText(
        $configPath,
        ($config | ConvertTo-Json -Compress),
        [Text.UTF8Encoding]::new($false))

    $pidPath = Join-Path $resolvedTestRoot 'transport.pid'
    $transportLog = Join-Path $resolvedTestRoot 'transport.log'
    $testMutex = 'Local\geminUp_Test_' + [Guid]::NewGuid().ToString('N')
    $transportProcess = Start-Process -FilePath $executable -ArgumentList @(
        'run', '--config', $([char]34 + $configPath + [char]34),
        '--pid', $([char]34 + $pidPath + [char]34),
        '--log', $([char]34 + $transportLog + [char]34),
        '--mutex', $testMutex
    ) -WindowStyle Hidden -PassThru
    Wait-TcpPort -Port $transportPort

    $direct = Invoke-CurlCheck -Uri 'https://example.com/' -ProxyPort $transportPort
    $gemini = Invoke-CurlCheck -Uri 'https://gemini.google.com/' -ProxyPort $transportPort
    Invoke-ConnectProbe -HostName 'antigravity.google' -ProxyPort $transportPort
    Invoke-ConnectProbe -HostName 'daily-cloudcode-pa.googleapis.com' -ProxyPort $transportPort
    if ($direct.ExitCode -ne 0 -or $direct.Code -ne '200') {
        throw "Direct route failed: curl=$($direct.ExitCode), HTTP=$($direct.Code), error=$($direct.Error)."
    }
    if ($gemini.ExitCode -ne 0 -or $gemini.Code -eq '000') {
        throw "Gemini route failed: curl=$($gemini.ExitCode), HTTP=$($gemini.Code), error=$($gemini.Error)."
    }
    $routeDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $routes = @(Get-Content -LiteralPath $socksStdout -Encoding UTF8 -ErrorAction SilentlyContinue)
        if (($routes -match '^CONNECT gemini\.google\.com:443$') -and
            ($routes -match '^CONNECT antigravity\.google:443$') -and
            ($routes -match '^CONNECT daily-cloudcode-pa\.googleapis\.com:443$')) {
            break
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $routeDeadline)
    if ($routes -match '^CONNECT example\.com:') { throw 'Direct destination entered SOCKS route.' }
    if (-not ($routes -match '^CONNECT gemini\.google\.com:443$')) {
        throw "Gemini did not enter SOCKS route. SOCKS output: $($routes -join '; ')"
    }
    if (-not ($routes -match '^CONNECT antigravity\.google:443$')) {
        $transportOutput = @(Get-Content -LiteralPath $transportLog -Encoding UTF8 -ErrorAction SilentlyContinue)
        throw "Antigravity did not enter SOCKS route. Routes: $($routes -join '; '). Transport log: $($transportOutput -join '; ')"
    }
    if (-not ($routes -match '^CONNECT daily-cloudcode-pa\.googleapis\.com:443$')) {
        throw "Antigravity language-server endpoint did not enter SOCKS route. Routes: $($routes -join '; ')"
    }

    $baselineThreads = (Get-Process -Id $transportProcess.Id).Threads.Count
    foreach ($index in 1..96) {
        $holdClients.Add((Open-HoldTunnel -TargetPort $holdPort -ProxyPort $transportPort))
    }
    Start-Sleep -Seconds 2
    $loadedProcess = Get-Process -Id $transportProcess.Id
    if ($loadedProcess.Threads.Count -gt ($baselineThreads + 16)) {
        throw "Async concurrency regression: 96 idle tunnels increased transport threads from $baselineThreads to $($loadedProcess.Threads.Count)."
    }
    Write-Host "OK: 96 concurrent idle tunnels used $($loadedProcess.Threads.Count) transport threads (baseline $baselineThreads)."
    foreach ($holdClient in $holdClients) { $holdClient.Close() }
    $holdClients.Clear()

    $probeOutput = Join-Path $resolvedTestRoot 'antigravity-launcher-probe.txt'
    $originalArguments = '"{0}" --original-flag' -f $probeOutput.Replace('"', '\"')
    $argumentBytes = [Text.UTF8Encoding]::new($false).GetBytes($originalArguments)
    try {
        $encodedArguments = [Convert]::ToBase64String($argumentBytes)
    }
    finally {
        [Array]::Clear($argumentBytes, 0, $argumentBytes.Length)
    }
    $parentHttpProxy = $env:HTTP_PROXY
    & $executable launch-antigravity --config $configPath --target $probeExecutable `
        --original-arguments $encodedArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Antigravity launcher exited with code $LASTEXITCODE."
    }
    $probeDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $probeOutput) -and [DateTime]::UtcNow -lt $probeDeadline) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $probeOutput)) {
        throw 'Antigravity launcher probe did not produce output.'
    }
    $probeText = Get-Content -LiteralPath $probeOutput -Raw -Encoding UTF8
    $expectedLocalProxy = "http://127.0.0.1:$transportPort"
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'GRPC_PROXY')) {
        if ($probeText -notmatch "(?m)^${name}=$([regex]::Escape($expectedLocalProxy))\r?$") {
            throw "Antigravity child environment is missing ${name}=${expectedLocalProxy}. Probe: $probeText"
        }
    }
    if ($probeText -notmatch '(?m)^NO_PROXY=.*(?:localhost|127\.0\.0\.1)') {
        throw "Antigravity child NO_PROXY does not protect loopback. Probe: $probeText"
    }
    if ($probeText -notmatch '(?m)^GEMINUP_ANTIGRAVITY=1\r?$' -or
        $probeText -notmatch "--proxy-server=$([regex]::Escape($expectedLocalProxy))" -or
        $probeText -notmatch '--disable-quic' -or $probeText -notmatch '--original-flag') {
        throw "Antigravity launcher flags are incomplete. Probe: $probeText"
    }
    if ($env:HTTP_PROXY -ne $parentHttpProxy) {
        throw 'Antigravity launcher modified the parent/global HTTP_PROXY value.'
    }

    Stop-Process -Id $socksProcess.Id -Force
    $socksProcess.WaitForExit(5000) | Out-Null
    $socksProcess = $null
    Start-Sleep -Milliseconds 300

    $directOffline = Invoke-CurlCheck -Uri 'https://example.com/' -ProxyPort $transportPort
    $geminiOffline = Invoke-CurlCheck -Uri 'https://gemini.google.com/' -ProxyPort $transportPort
    if ($directOffline.ExitCode -ne 0 -or $directOffline.Code -ne '200') {
        throw "Direct route stopped when SOCKS5 went offline: curl=$($directOffline.ExitCode), HTTP=$($directOffline.Code)."
    }
    if ($geminiOffline.ExitCode -eq 0 -or $geminiOffline.Code -ne '000') {
        throw "Gemini did not fail closed when SOCKS5 went offline: curl=$($geminiOffline.ExitCode), HTTP=$($geminiOffline.Code)."
    }

    Write-Host 'SUCCESS: compile, async concurrency, routing, process-scoped Antigravity launcher and fail-closed checks passed.' -ForegroundColor Green
}
finally {
    foreach ($holdClient in $holdClients) { $holdClient.Close() }
    if ($null -ne $transportProcess -and -not $transportProcess.HasExited) {
        Stop-Process -Id $transportProcess.Id -Force -ErrorAction SilentlyContinue
        $transportProcess.WaitForExit(5000) | Out-Null
    }
    if ($null -ne $socksProcess -and -not $socksProcess.HasExited) {
        Stop-Process -Id $socksProcess.Id -Force -ErrorAction SilentlyContinue
        $socksProcess.WaitForExit(5000) | Out-Null
    }
    if ($null -ne $holdProcess -and -not $holdProcess.HasExited) {
        Stop-Process -Id $holdProcess.Id -Force -ErrorAction SilentlyContinue
        $holdProcess.WaitForExit(5000) | Out-Null
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
