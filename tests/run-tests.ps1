#requires -Version 5.1
<#
.SYNOPSIS
    FORGE 2.0 — Build Memory test runner (Sprint 1, s1-p05).

.DESCRIPTION
    Drives the Build Memory integration test (tests/memory.test.ts) against the
    live local self-hosted Supabase. In order:

      1. Verifies the Docker Supabase stack is running (Docker CLI present, the
         forge-supabase-db container up, and the Kong gateway answering on
         http://localhost:54321).
      2. Loads FORGE_SUPABASE_URL / FORGE_SUPABASE_SERVICE_KEY for the test
         process — from the project .env if present, otherwise from docker/.env
         (SERVICE_ROLE_KEY), matching how migrations/apply-migrations.ps1 reads
         credentials.
      3. Runs the TypeScript compile gate:  pnpm tsc --noEmit
      4. Runs the test:  node --import tsx --test tests/memory.test.ts
         (Node 20 has no native TypeScript execution and src/ uses NodeNext `.js`
         specifiers; the tsx loader handles both. tsx is in devDependencies — run
         `pnpm install` once if it is missing.)
      5. Reports an overall PASS/FAIL and exits non-zero on any failure.

    Prerequisites the operator does once (this script checks #1 and warns clearly
    if a step is missing):
      .\docker\start-forge-db.ps1          # stack up + docker/.env secrets
      .\migrations\apply-migrations.ps1    # schema + 10 seed error patterns
      pnpm install                         # installs tsx

.EXAMPLE
    .\tests\run-tests.ps1
#>
[CmdletBinding()]
param(
    [string] $DbContainer = 'forge-supabase-db',
    [string] $ApiUrl      = 'http://localhost:54321'
)

$ErrorActionPreference = 'Stop'

# Resolve key paths relative to this script (tests/ -> repo root).
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$dockerDir = Join-Path $repoRoot 'docker'
$testFile  = Join-Path $scriptDir 'memory.test.ts'

function Write-Step { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "    [OK]   $m" -ForegroundColor Green }
function Write-Fail { param($m) Write-Host "    [FAIL] $m" -ForegroundColor Red }
function Write-Note { param($m) Write-Host "    $m" -ForegroundColor DarkGray }

function Get-EnvValue {
    param([string] $File, [string] $Key)
    if (-not (Test-Path $File)) { return $null }
    foreach ($line in Get-Content -LiteralPath $File) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }
        $k = $trimmed.Substring(0, $idx).Trim()
        if ($k -eq $Key) {
            return $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host ' FORGE 2.0 — Build Memory test runner (s1-p05)' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. Verify the Docker Supabase stack is running
# ---------------------------------------------------------------------------
Write-Step 'Step 1/4 — verifying Docker Supabase is running'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail 'Docker CLI not found on PATH. Install Docker Desktop and run .\docker\start-forge-db.ps1.'
    exit 1
}

# Is the Docker daemon up?
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Fail 'Docker daemon is not responding. Start Docker Desktop, then .\docker\start-forge-db.ps1.'
    exit 1
}

# Is the Postgres container running?
$running = & docker ps --filter "name=^/$DbContainer$" --format '{{.Names}}'
if (-not ($running -contains $DbContainer)) {
    Write-Fail "Container '$DbContainer' is not running. Start the stack: .\docker\start-forge-db.ps1"
    exit 1
}
Write-Ok "Container '$DbContainer' is running"

# Is the Kong API gateway answering? (401/404 still proves it is up and routing.)
$gatewayUp = $false
try {
    $resp = Invoke-WebRequest -Uri "$ApiUrl/rest/v1/" -Method Get -TimeoutSec 5 -UseBasicParsing
    if ($resp.StatusCode -ge 200) { $gatewayUp = $true }
}
catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -ge 200 -and $status -lt 500) { $gatewayUp = $true }
}
if (-not $gatewayUp) {
    Write-Fail "API gateway at $ApiUrl is not responding. Check: docker compose -f `"$dockerDir\docker-compose.yml`" ps"
    exit 1
}
Write-Ok "API gateway is responding at $ApiUrl"

# ---------------------------------------------------------------------------
# 2. Load Supabase credentials for the test process
# ---------------------------------------------------------------------------
Write-Step 'Step 2/4 — loading Supabase credentials'

$rootEnv = Join-Path $repoRoot '.env'
$dockerEnv = Join-Path $dockerDir '.env'

# URL: prefer project .env, else default to the documented gateway URL.
$supaUrl = Get-EnvValue -File $rootEnv -Key 'FORGE_SUPABASE_URL'
if ([string]::IsNullOrWhiteSpace($supaUrl)) { $supaUrl = $ApiUrl }

# Service key: prefer project .env (FORGE_SUPABASE_SERVICE_KEY), else docker/.env
# (SERVICE_ROLE_KEY — the same secret start-forge-db.ps1 prints for the project .env).
$serviceKey = Get-EnvValue -File $rootEnv -Key 'FORGE_SUPABASE_SERVICE_KEY'
if ([string]::IsNullOrWhiteSpace($serviceKey)) {
    $serviceKey = Get-EnvValue -File $dockerEnv -Key 'SERVICE_ROLE_KEY'
    if (-not [string]::IsNullOrWhiteSpace($serviceKey)) {
        Write-Note 'Using SERVICE_ROLE_KEY from docker/.env (no project .env found).'
    }
}

if ([string]::IsNullOrWhiteSpace($serviceKey)) {
    Write-Fail 'No service key found. Run .\docker\start-forge-db.ps1 (creates docker/.env), or set FORGE_SUPABASE_SERVICE_KEY in .env.'
    exit 1
}

$env:FORGE_SUPABASE_URL = $supaUrl
$env:FORGE_SUPABASE_SERVICE_KEY = $serviceKey
Write-Ok "FORGE_SUPABASE_URL = $supaUrl"
Write-Ok 'FORGE_SUPABASE_SERVICE_KEY = (loaded)'

# tsx availability check (clearer message than a raw node loader error).
$tsxPresent = (Test-Path (Join-Path $repoRoot 'node_modules\tsx')) -or
              (Test-Path (Join-Path $repoRoot 'node_modules\.bin\tsx.cmd'))
if (-not $tsxPresent) {
    Write-Fail 'tsx is not installed. Run `pnpm install` (tsx is in devDependencies) and re-run.'
    exit 1
}

# ---------------------------------------------------------------------------
# 3. TypeScript compile gate
# ---------------------------------------------------------------------------
Write-Step 'Step 3/4 — pnpm tsc --noEmit (compile gate)'
& pnpm tsc --noEmit
$tscExit = $LASTEXITCODE
if ($tscExit -ne 0) {
    Write-Fail "tsc reported errors (exit $tscExit). Fix them before the test gate."
    Write-Host ''
    Write-Host 'OVERALL: FAIL (compile gate)' -ForegroundColor Red
    exit 1
}
Write-Ok 'tsc --noEmit: zero errors'

# ---------------------------------------------------------------------------
# 4. Run the integration test
# ---------------------------------------------------------------------------
Write-Step 'Step 4/4 — node --import tsx --test tests/memory.test.ts'
& node --import tsx --test $testFile
$testExit = $LASTEXITCODE

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Cyan
if ($testExit -eq 0) {
    Write-Host ' OVERALL: PASS — compile gate clean, Build Memory tests green' -ForegroundColor Green
    Write-Host '======================================================================' -ForegroundColor Cyan
    exit 0
}
else {
    Write-Host " OVERALL: FAIL — tests exited $testExit (see node test output above)" -ForegroundColor Red
    Write-Host '======================================================================' -ForegroundColor Cyan
    exit 1
}
