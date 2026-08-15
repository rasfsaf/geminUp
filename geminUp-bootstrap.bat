@echo off
setlocal
title geminUp bootstrap

where powershell.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Windows PowerShell 5.1 is missing.
    echo geminUp supports standard Windows 10 and Windows 11 installations only.
    pause
    exit /b 1
)

echo [INFO] Downloading the latest verified geminUp release...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop';" ^
 "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
 "$base='https://github.com/rasfsaf/geminUp/releases/latest/download';" ^
 "$temp=Join-Path $env:TEMP ('geminUp-bootstrap-'+[Guid]::NewGuid().ToString('N'));" ^
 "$tempRoot=[IO.Path]::GetFullPath($env:TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;" ^
 "$resolved=[IO.Path]::GetFullPath($temp);" ^
 "if(-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe temporary directory path.'};" ^
 "New-Item -ItemType Directory -Path $resolved -Force|Out-Null;" ^
 "try{" ^
 "$zip=Join-Path $resolved 'geminUp.zip';$sum=Join-Path $resolved 'geminUp.zip.sha256';" ^
 "Invoke-WebRequest -Uri ($base+'/geminUp.zip') -OutFile $zip -UseBasicParsing -TimeoutSec 300;" ^
 "Invoke-WebRequest -Uri ($base+'/geminUp.zip.sha256') -OutFile $sum -UseBasicParsing -TimeoutSec 60;" ^
 "$expected=((Get-Content -LiteralPath $sum -Raw -Encoding ASCII).Trim() -split '\s+')[0];" ^
 "if($expected -notmatch '^[A-Fa-f0-9]{64}$'){throw 'Release checksum file is malformed.'};" ^
 "$actual=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash;" ^
 "if(-not $actual.Equals($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Release ZIP checksum mismatch.'};" ^
 "$releaseRoot=Join-Path $env:LOCALAPPDATA ('geminUp\releases\'+$actual.ToLowerInvariant());" ^
 "New-Item -ItemType Directory -Path $releaseRoot -Force|Out-Null;" ^
 "Expand-Archive -LiteralPath $zip -DestinationPath $releaseRoot -Force;" ^
 "$launcher=Get-ChildItem -LiteralPath $releaseRoot -Filter 'geminUp.bat' -File -Recurse|Select-Object -First 1;" ^
 "if($null -eq $launcher){throw 'geminUp.bat is missing from the verified release ZIP.'};" ^
 "Write-Host ('[OK] Verified release extracted to '+$releaseRoot) -ForegroundColor Green;" ^
 "Start-Process -FilePath $launcher.FullName -Wait;" ^
 "}finally{if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}}"

set "bootstrap_exit=%errorlevel%"
if not "%bootstrap_exit%"=="0" (
    echo.
    echo [ERROR] geminUp bootstrap failed with code %bootstrap_exit%.
    pause
)
exit /b %bootstrap_exit%
