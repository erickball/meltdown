<#
.SYNOPSIS
  Remove finished Claude worktrees for good, including the ones whose folders
  a leftover process keeps locked.

.DESCRIPTION
  Why folders get stuck: a dev server or test run started from a worktree
  (npx vite, npx tsx ...) runs as grandchildren of the shell that launched
  it. Stopping the task kills the shell, not node.exe / esbuild.exe, and those
  keep files in the worktree's node_modules open. `git worktree remove` then
  unregisters the worktree but cannot delete the locked files, and the folder
  is left behind with nothing pointing at it. Waiting does not help - the
  server never exits - so the cure is to stop whatever is running OUT OF the
  folder, then delete it (with a few retries for the brief locks antivirus or
  the indexer take).

  Safety:
  - A worktree git reports as LOCKED belongs to a live session and is never
    touched, not even with -Path.
  - Only processes whose executable path or command line names the folder are
    stopped.
  - Any junction/symlink directly inside the folder (a node_modules junction to
    the main checkout, say) is unlinked BEFORE the recursive delete, which would
    otherwise follow it and delete the target's contents.

.PARAMETER Path
  One worktree folder to remove (registered or orphaned).

.PARAMETER Sweep
  Remove every folder under .claude\worktrees that git no longer lists as a
  worktree (the orphans a failed removal leaves behind).

.PARAMETER WhatIf
  Report what would be stopped and deleted; change nothing.

.EXAMPLE
  powershell -File scripts\cleanup-worktrees.ps1 -Path .claude\worktrees\my-task
  powershell -File scripts\cleanup-worktrees.ps1 -Sweep -WhatIf
#>
param(
  [string]$Path,
  [switch]$Sweep,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$repo = (git rev-parse --path-format=absolute --git-common-dir).Trim() -replace '[\\/]\.git$', ''
$worktreesDir = Join-Path $repo '.claude\worktrees'

function Get-Worktrees {
  # git worktree list --porcelain: "worktree <path>" blocks, "locked" lines inside
  $list = @(); $cur = $null
  foreach ($line in (git -C $repo worktree list --porcelain)) {
    if ($line -like 'worktree *') {
      if ($cur) { $list += $cur }
      # (a -replace inside a method call's parentheses reads its comma as a
      # second argument in Windows PowerShell - keep it outside)
      $wtPath = $line.Substring(9) -replace '/', '\'
      $cur = [pscustomobject]@{ Path = [IO.Path]::GetFullPath($wtPath); Locked = $false }
    } elseif ($line -like 'locked*' -and $cur) { $cur.Locked = $true }
  }
  if ($cur) { $list += $cur }
  return $list
}

function Remove-WorktreeFolder([string]$dir) {
  $full = [IO.Path]::GetFullPath($dir).TrimEnd('\')
  $wt = Get-Worktrees | Where-Object { $_.Path.TrimEnd('\') -ieq $full }
  if ($wt -and $wt.Locked) {
    Write-Host "SKIP $full - git has it LOCKED (a live session is using it)"
    return
  }

  # 1. Stop what runs out of the folder. Never this script, the shell that
  #    started it, or another run of it: their command lines name the folder
  #    too (as the -Path argument), and stopping them aborts the cleanup.
  $all = Get-CimInstance Win32_Process
  $spare = @{}
  $walk = $PID
  while ($walk -and -not $spare.ContainsKey($walk)) {
    $spare[$walk] = $true
    $walk = ($all | Where-Object { $_.ProcessId -eq $walk }).ParentProcessId
  }
  $procs = $all | Where-Object {
    -not $spare.ContainsKey($_.ProcessId) -and
    -not ($_.CommandLine -and $_.CommandLine -like '*cleanup-worktrees.ps1*') -and (
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($full, [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and $_.CommandLine.IndexOf($full, [StringComparison]::OrdinalIgnoreCase) -ge 0))
  }
  foreach ($p in $procs) {
    $cmd = "$($p.CommandLine)" -replace '\s+', ' '
    if ($cmd.Length -gt 140) { $cmd = $cmd.Substring(0, 140) }
    Write-Host ("  stop {0} {1}: {2}" -f $p.Name, $p.ProcessId, $cmd)
    if (-not $WhatIf) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }

  # 2. Unregister it if git still knows it
  if ($wt -and -not $WhatIf) {
    git -C $repo worktree remove --force $full 2>$null | Out-Null
  }

  # 3. Unlink junctions/symlinks near the top so the delete cannot follow them
  if (Test-Path $full) {
    $links = Get-ChildItem -LiteralPath $full -Force -Directory -Recurse -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    foreach ($l in $links) {
      Write-Host "  unlink $($l.FullName) -> $($l.Target)"
      if (-not $WhatIf) { [IO.Directory]::Delete($l.FullName, $false) }
    }
  }

  # 4. Delete, retrying briefly for transient (antivirus / indexer) locks
  if ($WhatIf) { Write-Host "  would delete $full"; return }
  for ($i = 1; $i -le 6 -and (Test-Path $full); $i++) {
    try { Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop }
    catch { if ($i -lt 6) { Start-Sleep -Seconds 2 } else { Write-Host "  FAILED: $($_.Exception.Message)" } }
  }
  if (Test-Path $full) { Write-Host "LEFT $full (still locked - see the message above)" }
  else { Write-Host "removed $full" }
}

if ($Path) {
  Remove-WorktreeFolder (Resolve-Path $Path).Path
} elseif ($Sweep) {
  if (-not (Test-Path $worktreesDir)) { Write-Host "no $worktreesDir"; exit 0 }
  $registered = Get-Worktrees | ForEach-Object { $_.Path.TrimEnd('\').ToLowerInvariant() }
  foreach ($d in Get-ChildItem -LiteralPath $worktreesDir -Directory -Force) {
    if ($registered -contains $d.FullName.TrimEnd('\').ToLowerInvariant()) { continue }
    Write-Host "orphan $($d.FullName)"
    Remove-WorktreeFolder $d.FullName
  }
} else {
  Write-Host 'Give -Path <worktree folder> or -Sweep (add -WhatIf to preview).'
  exit 2
}
