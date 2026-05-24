# Manually trigger the NewsPortal fetch+analyze cycle.
# Usage:   .\fetch-now.ps1
#          .\fetch-now.ps1 -ApiBase http://192.168.1.5:8000
#          .\fetch-now.ps1 -TimeoutMinutes 30

[CmdletBinding()]
param(
    [string]$ApiBase = 'http://127.0.0.1:8000',
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'
$ApiBase = $ApiBase.TrimEnd('/')

function Get-Status {
    try { Invoke-RestMethod -Uri "$ApiBase/sources/status" -TimeoutSec 5 } catch { $null }
}

# 1. Health check
Write-Host "NewsPortal fetch trigger" -ForegroundColor Cyan
Write-Host "  API: $ApiBase"
try {
    $h = Invoke-RestMethod -Uri "$ApiBase/health" -TimeoutSec 5
    if ($h.status -ne 'ok') { throw "health returned: $($h | ConvertTo-Json -Compress)" }
} catch {
    Write-Host "Backend is not reachable at $ApiBase" -ForegroundColor Red
    Write-Host "  -> Start it with start-backend.bat (or pass -ApiBase http://host:8000)"
    exit 1
}

# 2. Pre-fetch snapshot
$before = Get-Status
if ($before) {
    Write-Host ("  Before: {0} feeds enabled, last fetch {1}" -f `
        $before.enabled,
        $(if ($before.last_fetch_at) { $before.last_fetch_at } else { 'never' })) -ForegroundColor DarkGray
}

# 3. Trigger fetch (may take minutes — many feeds, dedup, optional auto-analyze)
Write-Host "Triggering fetch..." -ForegroundColor Yellow
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
    $result = Invoke-RestMethod -Uri "$ApiBase/articles/fetch-all" `
        -Method Post -TimeoutSec ($TimeoutMinutes * 60)
} catch {
    Write-Host "Fetch failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        Write-Host $_.ErrorDetails.Message -ForegroundColor Red
    }
    exit 1
}
$sw.Stop()

# 4. Report
$elapsed = '{0:N1}s' -f $sw.Elapsed.TotalSeconds
$count = if ($null -ne $result.fetched) { $result.fetched } else { 0 }
Write-Host ("Fetched {0} new article(s) in {1}" -f $count, $elapsed) -ForegroundColor Green

$after = Get-Status
if ($after) {
    Write-Host ("  After:  {0}/{1} feeds returning content ({2} empty, {3} error)" -f `
        $after.ok, $after.enabled, $after.empty, $after.error)
    if ($after.next_fetch_at) {
        Write-Host ("  Next scheduled fetch: {0}" -f $after.next_fetch_at) -ForegroundColor DarkGray
    }
}
