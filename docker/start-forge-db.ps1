#requires -Version 5.1
<#
.SYNOPSIS
    Starts the FORGE 2.0 self-hosted Supabase (Build Memory) stack.

.DESCRIPTION
    1. Ensures docker/.env exists (generates secure secrets via gen-secrets.cjs,
       or falls back to copying .env.example).
    2. Ensures Docker Desktop is running (launches and waits if not).
    3. Runs `docker compose up -d` from the docker/ directory.
    4. Waits for the Kong API gateway health endpoint on http://localhost:54321.
    5. Prints connection info and the keys FORGE needs in its .env.

.PARAMETER TimeoutSeconds
    Max seconds to wait for Docker Desktop and for the stack to become healthy.
    Default 180.

.EXAMPLE
    .\docker\start-forge-db.ps1
#>
[CmdletBinding()]
param(
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$DockerDir = $PSScriptRoot
$ApiUrl = 'http://localhost:54321'

function Write-Step  { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host "    $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0. Tooling
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found on PATH. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
}

# ---------------------------------------------------------------- 1. Secrets
$envFile = Join-Path $DockerDir '.env'
$envExample = Join-Path $DockerDir '.env.example'
$genScript = Join-Path $DockerDir 'gen-secrets.cjs'

if (-not (Test-Path $envFile)) {
    Write-Step 'No docker/.env found — generating secrets'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node -and (Test-Path $genScript)) {
        & $node.Source $genScript
        if ($LASTEXITCODE -ne 0) { throw "gen-secrets.cjs failed (exit $LASTEXITCODE)." }
        Write-Ok 'Generated secure secrets into docker/.env'
    }
    elseif (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Warn2 'node not found — copied .env.example (PUBLIC demo keys).'
        Write-Warn2 'Rotate later with: node docker/gen-secrets.cjs --force'
    }
    else {
        throw "Cannot create docker/.env: neither gen-secrets.cjs nor .env.example is available."
    }
}
else {
    Write-Step 'docker/.env present — using existing secrets'
}

# ---------------------------------------------------------------- 2. Docker Desktop
function Test-DockerRunning {
    try {
        docker info *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch { return $false }
}

if (Test-DockerRunning) {
    Write-Step 'Docker Desktop is already running'
}
else {
    Write-Step 'Docker Desktop is not running — starting it'
    $desktopPaths = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
    ) | Where-Object { $_ -and (Test-Path $_) }

    if (-not $desktopPaths) {
        throw "Docker Desktop executable not found. Start Docker Desktop manually, then re-run this script."
    }
    Start-Process -FilePath $desktopPaths[0] | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-DockerRunning)) {
        if ((Get-Date) -gt $deadline) {
            throw "Docker Desktop did not become ready within $TimeoutSeconds seconds."
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 3
    }
    Write-Host ''
    Write-Ok 'Docker Desktop is ready'
}

# ---------------------------------------------------------------- 3. Compose up
Write-Step 'Starting Supabase stack (docker compose up -d)'
Push-Location $DockerDir
try {
    docker compose up -d
    if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit $LASTEXITCODE)." }
}
finally {
    Pop-Location
}

# ---------------------------------------------------------------- 4. Health wait
Write-Step "Waiting for API gateway at $ApiUrl"
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$healthy = $false
while (-not $healthy) {
    try {
        # Kong returns 401 for /rest/v1/ without an apikey — that still proves
        # the gateway is up and routing, which is what we are waiting for.
        $resp = Invoke-WebRequest -Uri "$ApiUrl/rest/v1/" -Method Get -TimeoutSec 5 -UseBasicParsing
        if ($resp.StatusCode -ge 200) { $healthy = $true }
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        if ($status -ge 200 -and $status -lt 500) { $healthy = $true }
    }
    if (-not $healthy) {
        if ((Get-Date) -gt $deadline) {
            Write-Warn2 "Gateway not healthy after $TimeoutSeconds s. Check: docker compose -f `"$DockerDir\docker-compose.yml`" ps"
            break
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 3
    }
}
if ($healthy) {
    Write-Host ''
    Write-Ok 'API gateway is responding'
}

# ---------------------------------------------------------------- 5. Connection info
$envMap = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z0-9_]+)\s*=\s*(.+)$') { $envMap[$matches[1]] = $matches[2].Trim() }
}

Write-Host ''
Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host ' FORGE 2.0 — Supabase Build Memory is up' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host "  API gateway (FORGE_SUPABASE_URL) : $ApiUrl"
Write-Host "  Postgres (host)                  : postgresql://postgres:<POSTGRES_PASSWORD>@localhost:54322/postgres"
Write-Host "  Studio UI                        : http://localhost:54323"
Write-Host ''
Write-Host '  Add these to your project .env (root .env, not docker/.env):' -ForegroundColor Yellow
Write-Host "  FORGE_SUPABASE_URL=$ApiUrl"
Write-Host "  FORGE_SUPABASE_ANON_KEY=$($envMap['ANON_KEY'])"
Write-Host "  FORGE_SUPABASE_SERVICE_KEY=$($envMap['SERVICE_ROLE_KEY'])"
Write-Host ''
Write-Host '  Stop the stack with: .\docker\stop-forge-db.ps1' -ForegroundColor DarkGray
Write-Host '======================================================================' -ForegroundColor Cyan
