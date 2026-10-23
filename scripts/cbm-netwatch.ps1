$seen = @{}
$end = (Get-Date).AddSeconds(150)
$polls = 0; $procs = @{}
while ((Get-Date) -lt $end) {
  $ps = Get-Process -Name "codebase-memory-mcp" -ErrorAction SilentlyContinue
  foreach ($p in $ps) {
    $procs[$p.Id] = 1
    Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue | ForEach-Object { $k = "$($_.State) $($_.LocalAddress):$($_.LocalPort) -> $($_.RemoteAddress):$($_.RemotePort)"; $seen[$k] = 1 }
    Get-NetUDPEndpoint -OwningProcess $p.Id -ErrorAction SilentlyContinue | ForEach-Object { $seen["UDP $($_.LocalAddress):$($_.LocalPort)"] = 1 }
  }
  $polls++
  if ($ps.Count -eq 0 -and $procs.Count -gt 0) { break }
  Start-Sleep -Milliseconds 150
}
"polls=$polls cbm_pids_seen=$($procs.Count)"
"connections:"
$seen.Keys | Sort-Object
"(end)"
