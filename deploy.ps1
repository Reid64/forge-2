#requires -Version 5.1
<#
.SYNOPSIS
    FORGE 2.0 self-deploy script — gates, builds, and pushes FORGE itself to GitHub.

.DESCRIPTION
    Implements the CLAUDE.md DEPLOYMENT PROTOCOL for FORGE 2.0 (which is a Node.js CLI,
    not a Vercel web app — so there is no `vercel --prod` step). The sequence runs in
    strict order and ABORTS on the first failure (no force-push of broken code):

        1. pnpm tsc --noEmit      (Gate 1 — Compile: must be zero errors)
        2. pnpm run build         (Gate 2 — Build: tsc emit to dist/)
        3. pnpm test              (Gate 4 — Test: node --test; skipped if -SkipTests)
        4. git add -A
        5. git commit -m "[FORGE] <message>"   (skipped if there is nothing to commit)
        6. git push origin <branch>            (to the Reid64/forge-2 remote)

    The script is idempotent and safe to re-run. It NEVER force-pushes, NEVER skips a
    gate, and NEVER commits when a gate has failed (Iron Laws 2, 3, 7; DEPLOYMENT PROTOCOL).

.PARAMETER Message
    The commit message body (the "[FORGE] " prefix is added automatically).

.PARAMETER Remote
    Git remote name. Default: origin (expected to point at https://github.com/Reid64/forge-2).

.PARAMETER Branch
    Branch to push. Default: the current branch.

.PARAMETER SkipTests
    Skip Gate 4 (the test run). The compile + build gates always run.

.PARAMETER DryRun
    Run all gates but do NOT commit or push (prints what would happen).

.EXAMPLE
    .\deploy.ps1 -Message "s8-p04 integration test + deploy script"

.EXAMPLE
    .\deploy.ps1 -Message "docs refresh" -SkipTests -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Message,

    [string]$Remote = 'origin',

    [string]$Branch = '',

    [switch]$SkipTests,

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Always operate from the repository root (this script's directory).
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  PASS  $Text" -ForegroundColor Green }
function Write-Skip { param([string]$Text) Write-Host "  SKIP  $Text" -ForegroundColor DarkGray }

# Run a gate command; abort the whole deploy on a non-zero exit (DEPLOYMENT PROTOCOL).
function Invoke-Gate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$GateArgs
    )
    Write-Step "$Name : $Exe $($GateArgs -join ' ')"
    & $Exe @GateArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  FAIL  $Name (exit $LASTEXITCODE) — deploy ABORTED. No commit, no push." -ForegroundColor Red
        exit 1
    }
    Write-Ok $Name
}

# --- Preflight ------------------------------------------------------------------
Write-Step 'Preflight'

$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue)
if ($null -eq $pnpm) {
    Write-Host '  FAIL  pnpm is not on PATH. Install it (npm i -g pnpm) and re-run.' -ForegroundColor Red
    exit 1
}
$git = (Get-Command git -ErrorAction SilentlyContinue)
if ($null -eq $git) {
    Write-Host '  FAIL  git is not on PATH.' -ForegroundColor Red
    exit 1
}

# Resolve the branch (default: current).
if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = (git rev-parse --abbrev-ref HEAD).Trim()
}
Write-Host "  repo:   $RepoRoot"
Write-Host "  remote: $Remote"
Write-Host "  branch: $Branch"

# Verify the remote exists and warn if it is not the expected Reid64/forge-2 repo.
$remoteUrl = (git remote get-url $Remote 2>$null)
if ([string]::IsNullOrWhiteSpace($remoteUrl)) {
    Write-Host "  FAIL  git remote '$Remote' is not configured." -ForegroundColor Red
    Write-Host "        Add it:  git remote add $Remote https://github.com/Reid64/forge-2.git" -ForegroundColor Yellow
    exit 1
}
Write-Host "  url:    $remoteUrl"
if ($remoteUrl -notmatch 'Reid64/forge-2') {
    Write-Host "  WARN   remote '$Remote' does not look like Reid64/forge-2 — continuing anyway." -ForegroundColor Yellow
}

# --- Gate 1: Compile ------------------------------------------------------------
Invoke-Gate -Name 'Gate 1 — Compile (tsc --noEmit)' -Exe 'pnpm' -GateArgs @('tsc', '--noEmit')

# --- Gate 2: Build --------------------------------------------------------------
Invoke-Gate -Name 'Gate 2 — Build (tsc emit)' -Exe 'pnpm' -GateArgs @('run', 'build')

# --- Gate 4: Test ---------------------------------------------------------------
if ($SkipTests) {
    Write-Step 'Gate 4 — Test'
    Write-Skip 'tests skipped (-SkipTests)'
} else {
    Invoke-Gate -Name 'Gate 4 — Test (node --test)' -Exe 'pnpm' -GateArgs @('test')
}

# --- Git: add / commit / push ---------------------------------------------------
Write-Step 'Git — stage changes'
git add -A
if ($LASTEXITCODE -ne 0) { Write-Host '  FAIL  git add failed.' -ForegroundColor Red; exit 1 }

# Anything staged?
git diff --cached --quiet
$hasChanges = ($LASTEXITCODE -ne 0)

$testGateStatus = if ($SkipTests) { 'SKIP' } else { 'PASS' }
$commitMessage = @"
[FORGE] $Message

Gates: compile=PASS build=PASS test=$testGateStatus
Deployed-by: deploy.ps1
"@

if (-not $hasChanges) {
    Write-Skip 'no staged changes — nothing to commit.'
} elseif ($DryRun) {
    Write-Step 'Git — commit (DRY RUN)'
    Write-Host '  Would commit with message:' -ForegroundColor Yellow
    Write-Host $commitMessage -ForegroundColor DarkGray
} else {
    Write-Step 'Git — commit'
    # Use a temp file for the multi-line message to avoid shell-quoting issues.
    $tmp = New-TemporaryFile
    Set-Content -Path $tmp -Value $commitMessage -Encoding utf8
    git commit -F $tmp
    $commitExit = $LASTEXITCODE
    Remove-Item $tmp -Force
    if ($commitExit -ne 0) { Write-Host '  FAIL  git commit failed.' -ForegroundColor Red; exit 1 }
    Write-Ok 'commit created'
}

Write-Step "Git — push to $Remote/$Branch"
if ($DryRun) {
    Write-Host "  Would run: git push $Remote $Branch" -ForegroundColor Yellow
    Write-Host "`nDRY RUN complete — gates passed, nothing pushed." -ForegroundColor Cyan
    exit 0
}

git push $Remote $Branch
if ($LASTEXITCODE -ne 0) {
    Write-Host "  FAIL  git push failed (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host '        Resolve the remote/auth issue and re-run; nothing was force-pushed.' -ForegroundColor Yellow
    exit 1
}

Write-Host "`nDEPLOY COMPLETE — gates PASSED, pushed $Branch to $Remote." -ForegroundColor Green
exit 0
