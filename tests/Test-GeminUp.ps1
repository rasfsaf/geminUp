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

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -eq $python) {
        $python = Get-Command python -ErrorAction SilentlyContinue
    }
    if ($null -eq $python) {
        throw 'Python 3 is required for integration tests only.'
    }

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
    $transportPort = Get-FreeTcpPort
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
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
            ($routes -match '^CONNECT antigravity\.google:443$')) {
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

    Write-Host 'SUCCESS: compile, routing and fail-closed integration checks passed.' -ForegroundColor Green
}
finally {
    if ($null -ne $transportProcess -and -not $transportProcess.HasExited) {
        Stop-Process -Id $transportProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $socksProcess -and -not $socksProcess.HasExited) {
        Stop-Process -Id $socksProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) {
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
