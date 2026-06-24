$root = "C:\Users\manag\Documents\forge-2"
$entries = @(); $current = $null
foreach ($line in (Get-Content "$root\projects\forge2\queue.yaml")) {
    if ($line -match '^- id:\s*(.+)') {
        if ($current) { $entries += $current }
        $current = @{ id = $Matches[1].Trim(); name = ""; description = "" }
    }
    elseif ($current -and $line -match '^\s+name:\s*"(.+)"') {
        $current.name = $Matches[1]
    }
}
if ($current) { $entries += $current }
Write-Host "Found $($entries.Count) prompts:"
$entries | ForEach-Object { Write-Host "  $($_.id) - $($_.name)" }
