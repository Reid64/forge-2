<#
.SYNOPSIS
    Applies all FORGE 2.0 SQL migrations, in numeric order, to the local
    self-hosted Supabase Postgres database.

.DESCRIPTION
    Runs every migrations\NNN_*.sql file (sorted by the leading number) against
    Postgres. Each file is executed inside a single transaction with
    ON_ERROR_STOP=1, so a failure in one statement rolls that file back and halts
    the run (no partial migrations).

    Connection strategy (auto-detected, in order):
      1. docker exec into the running 'forge-supabase-db' container and pipe SQL
         to its bundled psql (preferred — no host psql install required).
      2. Host 'psql' on PATH, connecting to localhost:54322 (the db port mapped
         by docker\docker-compose.yml).

    The Postgres password is read from docker\.env (POSTGRES_PASSWORD). If
    docker\.env is absent, falls back to the value in docker\.env.example and
    warns (demo credentials).

.PARAMETER DbContainer
    Name of the Postgres container. Default: forge-supabase-db.

.PARAMETER DbHost
    Host for the psql fallback path. Default: localhost.

.PARAMETER DbPort
    Host port for the psql fallback path. Default: 54322.

.PARAMETER DbUser
    Postgres superuser. Default: postgres.

.PARAMETER DbName
    Target database. Default: postgres.

.PARAMETER UsePsql
    Force the host-psql path even if the container is running.

.EXAMPLE
    .\migrations\apply-migrations.ps1

.EXAMPLE
    .\migrations\apply-migrations.ps1 -UsePsql
#>
[CmdletBinding()]
param(
    [string] $DbContainer = 'forge-supabase-db',
    [string] $DbHost      = 'localhost',
    [int]    $DbPort      = 54322,
    [string] $DbUser      = 'postgres',
    [string] $DbName      = 'postgres',
    [switch] $UsePsql
)

$ErrorActionPreference = 'Stop'
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$dockerDir   = Join-Path (Split-Path -Parent $scriptDir) 'docker'

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    [OK]   $msg" -ForegroundColor Green }
function Write-Fail($msg)  { Write-Host "    [FAIL] $msg" -ForegroundColor Red }
function Write-Note($msg)  { Write-Host "    $msg" -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# 1. Resolve the Postgres password from docker\.env (fallback: .env.example)
# ---------------------------------------------------------------------------
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

$envFile     = Join-Path $dockerDir '.env'
$envExample  = Join-Path $dockerDir '.env.example'
$pgPassword  = Get-EnvValue -File $envFile -Key 'POSTGRES_PASSWORD'

if ([string]::IsNullOrWhiteSpace($pgPassword)) {
    $pgPassword = Get-EnvValue -File $envExample -Key 'POSTGRES_PASSWORD'
    if ([string]::IsNullOrWhiteSpace($pgPassword)) {
        throw "Could not read POSTGRES_PASSWORD from $envFile or $envExample. Launch the DB first (docker\start-forge-db.ps1) so docker\.env exists."
    }
    Write-Warning "docker\.env not found; using DEMO POSTGRES_PASSWORD from .env.example. Run docker\start-forge-db.ps1 to generate secure secrets."
}

# ---------------------------------------------------------------------------
# 2. Gather migration files in numeric order
# ---------------------------------------------------------------------------
$migrationFiles = Get-ChildItem -LiteralPath $scriptDir -Filter '*.sql' |
    Sort-Object {
        if ($_.Name -match '^(\d+)_') { [int]$matches[1] } else { [int]::MaxValue }
    }, Name

if (-not $migrationFiles) {
    throw "No .sql migration files found in $scriptDir."
}

Write-Step "Found $($migrationFiles.Count) migration file(s):"
foreach ($f in $migrationFiles) { Write-Note $f.Name }

# ---------------------------------------------------------------------------
# 3. Pick a connection method
# ---------------------------------------------------------------------------
function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

$dockerAvailable    = Test-Command 'docker'
$containerIsRunning = $false
if ($dockerAvailable -and -not $UsePsql) {
    $running = & docker ps --filter "name=^/$DbContainer$" --format '{{.Names}}'
    if ($LASTEXITCODE -eq 0 -and $running -contains $DbContainer) {
        $containerIsRunning = $true
    }
}

$psqlAvailable = Test-Command 'psql'

if (-not $UsePsql -and $containerIsRunning) {
    $method = 'docker'
} elseif ($psqlAvailable) {
    $method = 'psql'
} elseif ($containerIsRunning) {
    $method = 'docker'
} else {
    throw @"
No way to reach Postgres.
 - Container '$DbContainer' is not running (start it with docker\start-forge-db.ps1), and
 - 'psql' is not on PATH for a direct localhost:$DbPort connection.
Start the database, or install the Postgres client, then re-run.
"@
}

Write-Step "Connection method: $method"
if ($method -eq 'docker') {
    Write-Note "docker exec -> $DbContainer (db=$DbName user=$DbUser)"
} else {
    Write-Note "psql -> ${DbHost}:${DbPort} (db=$DbName user=$DbUser)"
}

# ---------------------------------------------------------------------------
# 4. Run each migration in order; halt on first failure
# ---------------------------------------------------------------------------
function Invoke-Migration {
    param([System.IO.FileInfo] $File)

    $sql = Get-Content -LiteralPath $File.FullName -Raw

    if ($method -eq 'docker') {
        # ON_ERROR_STOP + single-transaction so a bad file rolls back cleanly.
        $sql | & docker exec -i `
            -e "PGPASSWORD=$pgPassword" `
            $DbContainer `
            psql -v ON_ERROR_STOP=1 --single-transaction `
                 -U $DbUser -d $DbName -h 127.0.0.1 -p 5432
    } else {
        $prevPw = $env:PGPASSWORD
        $env:PGPASSWORD = $pgPassword
        try {
            $sql | & psql -v ON_ERROR_STOP=1 --single-transaction `
                          -h $DbHost -p $DbPort -U $DbUser -d $DbName
        } finally {
            $env:PGPASSWORD = $prevPw
        }
    }
    return $LASTEXITCODE
}

$applied = 0
foreach ($file in $migrationFiles) {
    Write-Step "Applying $($file.Name) ..."
    $exit = Invoke-Migration -File $file
    if ($exit -ne 0) {
        Write-Fail "$($file.Name) failed (psql exit $exit). Halting — no further migrations applied."
        exit 1
    }
    Write-Ok "$($file.Name)"
    $applied++
}

Write-Host ""
Write-Host "All $applied migration(s) applied successfully." -ForegroundColor Green
Write-Note "Verify with:  docker exec -e PGPASSWORD=*** $DbContainer psql -U $DbUser -d $DbName -c '\dt public.*'"
exit 0
