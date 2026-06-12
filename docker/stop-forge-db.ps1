#requires -Version 5.1
<#
.SYNOPSIS
    Stops the FORGE 2.0 self-hosted Supabase (Build Memory) stack.

.DESCRIPTION
    Runs `docker compose down` from the docker/ directory. By default the named
    data volumes (forge-db-data, forge-storage-data) are PRESERVED so Build
    Memory survives a restart. Pass -Volumes to also delete them (full reset —
    this wipes the database).

.PARAMETER Volumes
    Also remove the named data volumes. WARNING: destroys all Build Memory.

.EXAMPLE
    .\docker\stop-forge-db.ps1
    .\docker\stop-forge-db.ps1 -Volumes
#>
[CmdletBinding()]
param(
    [switch]$Volumes
)

$ErrorActionPreference = 'Stop'
$DockerDir = $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI not found on PATH."
}

Push-Location $DockerDir
try {
    if ($Volumes) {
        Write-Host "==> Stopping Supabase stack and REMOVING data volumes" -ForegroundColor Yellow
        Write-Host "    This permanently deletes Build Memory." -ForegroundColor Yellow
        docker compose down -v
    }
    else {
        Write-Host "==> Stopping Supabase stack (data volumes preserved)" -ForegroundColor Cyan
        docker compose down
    }
    if ($LASTEXITCODE -ne 0) { throw "docker compose down failed (exit $LASTEXITCODE)." }
    Write-Host "    Stopped." -ForegroundColor Green
}
finally {
    Pop-Location
}
