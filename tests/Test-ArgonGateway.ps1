# Test-ArgonGateway.ps1
# Targeted unit and integration tests for geminUp Argon Gateway Engine

$ErrorActionPreference = 'Stop'
Write-Host '=== Running Argon Gateway Targeted Tests ===' -ForegroundColor Cyan

$srcDir = Join-Path $PSScriptRoot '..\src\argon'
$nodeExe = (Get-Command 'node' -ErrorAction Stop).Source

# Test 1: Node syntax validation
Write-Host '[1/4] Checking Node.js syntax across all engine modules...' -ForegroundColor Yellow
$files = Get-ChildItem -LiteralPath $srcDir -Filter '*.js'
foreach ($f in $files) {
    & $nodeExe -c $f.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "Syntax error in file: $($f.Name)"
    }
}
Write-Host '  OK: All 6 JavaScript engine modules passed syntax check.' -ForegroundColor Green

# Test 2: Protobuf Agent Mode Quota (action: 12) & Wire format verification
Write-Host '[2/4] Verifying Protobuf field 49 = 12 (Antigravity Agent Mode)...' -ForegroundColor Yellow
$wireTestScript = @"
const assert = require('node:assert');
const { buildGenerateRequest, buildModelHeader, parseModelHeader } = require('$($srcDir.Replace('\', '/'))/wire-format.js');

const header = buildModelHeader('e6fa609c3fa255c0', 1, 12);
const parsedHeader = parseModelHeader(header);
assert.strictEqual(parsedHeader.modelId, 'e6fa609c3fa255c0');

const session = { accessToken: 'test_token', buildLabel: 'bl_123', sessionId: 'sid_456', language: 'en' };
const req = buildGenerateRequest('test prompt', header, session, 100000, { agentMode: true, action: 12 });

assert(req.params.has('hl'));
assert(req.headers['x-goog-ext-525001261-jspb']);

const bodyStr = req.body.get('f.req');
const bodyParsed = JSON.parse(bodyStr);
const requestArray = JSON.parse(bodyParsed[1]);
assert.strictEqual(requestArray[49], 12, 'request[49] must equal 12 for Antigravity Agent Mode');
console.log('AGENT_MODE_VERIFIED');
"@
$wireOutput = & $nodeExe -e $wireTestScript
if ($wireOutput -notmatch 'AGENT_MODE_VERIFIED') {
    throw 'Failed wire format verification'
}
Write-Host '  OK: Antigravity Agent Mode (action: 12) Protobuf serialization confirmed.' -ForegroundColor Green

# Test 3: Cookie input parsing (multi-format support)
Write-Host '[3/4] Verifying multi-format cookie parsing (string, JSON, object)...' -ForegroundColor Yellow
$cookieTestScript = @"
const assert = require('node:assert');
const { AccountPool } = require('$($srcDir.Replace('\', '/'))/account-pool.js');
const pool = new AccountPool({ storagePath: './test-accounts.json' });

// 1. Raw string
const raw = 'Cookie: __Secure-1PSID=val1; SAPISID=val2; SID=val3';
const c1 = pool.parseCookieInput(raw);
assert.strictEqual(c1.length, 3);

// 2. JSON string
const jsonStr = JSON.stringify({ cookies: [{ name: '__Secure-1PSID', value: 'val1' }, { name: 'SAPISID', value: 'val2' }] });
const c2 = pool.parseCookieInput(jsonStr);
assert.strictEqual(c2.length, 2);

// 3. Object
const obj = { cookies: [{ name: '__Secure-1PSID', value: 'val1' }] };
const c3 = pool.parseCookieInput(obj);
assert.strictEqual(c3.length, 1);

console.log('COOKIE_PARSER_VERIFIED');
"@
$cookieOutput = & $nodeExe -e $cookieTestScript
if ($cookieOutput -notmatch 'COOKIE_PARSER_VERIFIED') {
    throw 'Failed cookie parsing verification'
}
Write-Host '  OK: Cookie parsing for raw headers, JSON strings, and Playwright objects confirmed.' -ForegroundColor Green

# Test 4: Live HTTP Listener and Catalog Verification on test port 8991
Write-Host '[4/4] Verifying HTTP Server endpoints on loopback test port 8991...' -ForegroundColor Yellow
$testPort = 8991
$gatewayScript = Join-Path $srcDir 'gateway.js'
$testAccountsFile = Join-Path $env:TEMP 'test-argon-accounts.json'
if (Test-Path -LiteralPath $testAccountsFile) { Remove-Item -LiteralPath $testAccountsFile -Force }

$proc = Start-Process -FilePath $nodeExe -ArgumentList "`"$gatewayScript`" --port $testPort --host 127.0.0.1 --accounts `"$testAccountsFile`"" -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $h = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/health" -Method Get -TimeoutSec 1
            if ($h.status -eq 'ok') { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }

    if (-not $ready) {
        throw "Test gateway failed to bind port $testPort within 5 seconds."
    }

    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1/models" -Method Get -TimeoutSec 2
    $modelIds = @($models.data | Select-Object -ExpandProperty id)
    if ($modelIds -notcontains 'gemini-4-argon') {
        throw "gemini-4-argon model missing from catalog"
    }

    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/admin/api/status" -Method Get -TimeoutSec 2
    if ($status.totalAccounts -ne 0) {
        throw "Initial pool state mismatch"
    }

    # Verify Antigravity Cloud Code endpoints & Model Unlocking
    Write-Host '  Verifying Antigravity Cloud Code protocol endpoints...' -ForegroundColor DarkCyan
    $ccModels = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1internal:fetchAvailableModels" -Method Get -TimeoutSec 2
    if (-not $ccModels.models.'gemini-4-argon') {
        throw "gemini-4-argon missing from Cloud Code models catalog"
    }
    if ($ccModels.models.'gemini-4-argon'.disabled -ne $false) {
        throw "gemini-4-argon must be marked disabled: false"
    }
    if ($ccModels.models.'gemini-4-argon'.tagTitle -ne '') {
        throw "gemini-4-argon tagTitle must be empty (unlocked)"
    }

    $assist = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1internal:loadCodeAssist" -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 2
    if ($assist.ineligible -ne $false) {
        throw "loadCodeAssist must return ineligible: false"
    }

    $quota = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1internal:retrieveUserQuotaSummary" -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 2
    if ($quota.buckets.Count -eq 0) {
        throw "retrieveUserQuotaSummary returned no buckets"
    }

    $tokens = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1internal:countTokens" -Method Post -Body '{"prompt":"hello world"}' -ContentType 'application/json' -TimeoutSec 2
    if ($tokens.totalTokens -le 0) {
        throw "countTokens failed"
    }

    Write-Host "  OK: /health, /v1/models, Cloud Code endpoints (/v1internal:*), and /admin/api/status responded successfully." -ForegroundColor Green
    Write-Host "  Available Models: $($modelIds -join ', ')" -ForegroundColor DarkGray
    Write-Host "  Cloud Code Unlocked: gemini-4-argon (disabled=$($ccModels.models.'gemini-4-argon'.disabled), tagTitle='$($ccModels.models.'gemini-4-argon'.tagTitle)')" -ForegroundColor DarkGray
}
finally {
    $proc.Kill()
    $proc.WaitForExit(2000)
    if (Test-Path -LiteralPath $testAccountsFile) { Remove-Item -LiteralPath $testAccountsFile -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host '=== ALL ARGON GATEWAY TESTS PASSED SUCCESSFULLY ===' -ForegroundColor Green
