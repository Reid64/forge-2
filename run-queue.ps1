param([int]$StartFrom = 0)
$root = "C:\Users\manag\Documents\forge-2"
$QueuePath = "$root\projects\forge2\queue.yaml"
Set-Location $root

$entries = @(); $current = $null
foreach ($line in (Get-Content $QueuePath)) {
    if ($line -match '^- id:\s*(.+)') {
        if ($current) { $entries += $current }
        $current = @{ id = $Matches[1].Trim(); name = ""; description = "" }
    }
    elseif ($current -and $line -match '^\s+name:\s*"(.+)"') {
        $current.name = $Matches[1]
    }
    elseif ($current -and $line -match '^\s+description:\s*\|') {
        $current._collecting = $true
        $current.description = ""
    }
    elseif ($current -and $current._collecting) {
        if ($line -match '^- id:' -or $line -match '^$') {
            $current._collecting = $false
        } elseif ($line -match '^\s') {
            $current.description += $line.TrimStart() + "`n"
        } else {
            $current._collecting = $false
        }
    }
}
if ($current) { $entries += $current }

New-Item -ItemType Directory -Path "$root\.forge" -Force | Out-Null

Write-Host "=== FORGE Queue Runner ===" -ForegroundColor Cyan
Write-Host "Prompts: $($entries.Count)" -ForegroundColor Gray
Write-Host ""

for ($i = $StartFrom; $i -lt $entries.Count; $i++) {
    $entry = $entries[$i]
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] [$($i+1)/$($entries.Count)] $($entry.id) - $($entry.name)" -ForegroundColor Cyan

    $start = Get-Date
    $entry.description | claude -p --dangerously-skip-permissions 2>&1 | Tee-Object -Variable output
    $dur = [Math]::Round(((Get-Date) - $start).TotalMinutes, 1)
    $code = $LASTEXITCODE

    if ($code -eq 0) {
        Write-Host "[$($entry.id)] PASS ($dur min)" -ForegroundColor Green
    } else {
        Write-Host "[$($entry.id)] FAIL (exit $code, $dur min)" -ForegroundColor Red
    }

    $log = "$(Get-Date -Format 'o') | $($entry.id) | $(if($code -eq 0){'PASS'}else{'FAIL'}) | $dur min"
    Add-Content -Path "$root\.forge\run-log.txt" -Value $log
    Write-Host ""
}

Write-Host "=== Run Complete ===" -ForegroundColor Green
