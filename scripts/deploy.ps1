<#
.SYNOPSIS
  Deploy what is on origin/master to Firebase: hosting always, functions when
  they changed since the last functions deploy.

.DESCRIPTION
  Always works in the MAIN checkout (not the worktree it is run from), which
  must be on master with no modified tracked files. Untracked files are fine -
  the build only bundles what the code imports, and every import on master is
  tracked.

  Steps, stopping at the first failure:
  1. Fetch origin and fast-forward local master to origin/master. Refuses if
     local master has commits origin does not: the deployed site should be
     exactly what is on origin.
  2. Decide whether functions need deploying: yes if anything under
     functions\ differs from the commit the `deployed-functions` tag marks
     (or there is no tag yet). Tags live on origin, so any machine agrees.
  3. Optionally run npm test (-Test).
  4. npm run build, so a type error stops everything before anything ships.
  5. Functions first (with the 60 s discovery timeout the default 10 s trips
     on), because a new client can depend on a new function but not the other
     way round. A failure here stops before hosting, leaving the old pair.
  6. Hosting, with the commit in the release message.
  Each successful deploy moves its `deployed-hosting` / `deployed-functions`
  tag to the commit and pushes the tag.

.PARAMETER Functions
  Deploy functions even if functions\ looks unchanged.

.PARAMETER SkipFunctions
  Never deploy functions (hosting only).

.PARAMETER SkipHosting
  Do not deploy hosting (functions only, if they are due or -Functions).

.PARAMETER Test
  Run npm test before building.

.PARAMETER DryRun
  Report what would be deployed; change nothing (no fast-forward, build, deploy
  or tag).

.EXAMPLE
  npm run deploy
  npm run deploy -- -DryRun
  npm run deploy -- -Functions -Test
  powershell -File scripts\deploy.ps1 -SkipFunctions
#>
param(
  [switch]$Functions,
  [switch]$SkipFunctions,
  [switch]$SkipHosting,
  [switch]$Test,
  [switch]$DryRun
)

# Native tools (git, npm, firebase) report failure through exit codes and
# write progress to stderr; each call is checked explicitly instead of letting
# Windows PowerShell turn stderr lines into errors.
$ErrorActionPreference = 'Continue'

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "DEPLOY ABORTED: $msg" -ForegroundColor Red
  exit 1
}

function Step([string]$label) {
  Write-Host ""
  Write-Host "==> $label" -ForegroundColor Cyan
}

function Check([string]$what) {
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)" }
}

if ($Functions -and $SkipFunctions) { Fail "-Functions and -SkipFunctions contradict each other" }

$repo = (git rev-parse --path-format=absolute --git-common-dir).Trim() -replace '[\\/]\.git$', ''
$repo = $repo -replace '/', '\'
Check "locating the repository"
Write-Host "Main checkout: $repo"

# --- 1. master, clean, in step with origin --------------------------------
Step "Checking the main checkout"
$branch = (git -C $repo symbolic-ref --short HEAD 2>$null)
if ("$branch".Trim() -ne 'master') { Fail "the main checkout is on '$branch', not master" }

$modified = @(git -C $repo status --porcelain --untracked-files=no)
if ($modified.Count -gt 0) {
  Write-Host ($modified -join "`n")
  Fail "the main checkout has modified tracked files (above); the build would ship them and stamp the commit '-dirty'"
}

git -C $repo fetch --quiet origin master "+refs/tags/deployed-*:refs/tags/deployed-*"
Check "git fetch"
$counts = (git -C $repo rev-list --left-right --count master...origin/master).Trim() -split '\s+'
Check "comparing master with origin/master"
$ahead = [int]$counts[0]; $behind = [int]$counts[1]
if ($ahead -gt 0) {
  Fail "local master has $ahead commit(s) not on origin/master - push them first, so the deployed site is what origin has"
}
if ($behind -gt 0) {
  if ($DryRun) {
    Write-Host "master is $behind commit(s) behind origin/master (would fast-forward)"
  } else {
    Write-Host "Fast-forwarding master by $behind commit(s)"
    git -C $repo merge --ff-only --quiet origin/master
    Check "fast-forwarding master"
  }
}
$sha = (git -C $repo rev-parse origin/master).Trim()
$short = $sha.Substring(0, 12)
$subject = (git -C $repo log -1 --format=%s $sha).Trim()
Write-Host "Deploying $short  $subject"

# --- 2. do the functions need deploying? ----------------------------------
$deployFunctions = $false
$fnReason = ''
if ($SkipFunctions) {
  $fnReason = 'skipped (-SkipFunctions)'
} elseif ($Functions) {
  $deployFunctions = $true; $fnReason = 'forced (-Functions)'
} else {
  $lastFn = (git -C $repo rev-parse -q --verify "refs/tags/deployed-functions^{commit}" 2>$null)
  if (-not $lastFn) {
    $deployFunctions = $true; $fnReason = 'no deployed-functions tag yet (first tracked deploy)'
  } else {
    $lastFn = $lastFn.Trim()
    $changed = @(git -C $repo diff --name-only $lastFn $sha -- functions)
    Check "diffing functions\"
    if ($changed.Count -gt 0) {
      $deployFunctions = $true
      $fnReason = "$($changed.Count) file(s) changed since $($lastFn.Substring(0, 12)): $($changed -join ', ')"
    } else {
      $fnReason = "unchanged since $($lastFn.Substring(0, 12))"
    }
  }
}
Write-Host ("Functions: " + $(if ($deployFunctions) { 'DEPLOY' } else { 'no' }) + " - $fnReason")
Write-Host ("Hosting:   " + $(if ($SkipHosting) { 'no - skipped (-SkipHosting)' } else { 'DEPLOY' }))

if (-not $deployFunctions -and $SkipHosting) { Write-Host "Nothing to deploy."; exit 0 }
if ($DryRun) { Write-Host ""; Write-Host "Dry run - nothing changed."; exit 0 }

function Move-Tag([string]$tag) {
  git -C $repo tag -f $tag $sha | Out-Null
  Check "tagging $tag"
  git -C $repo push --quiet --force origin "refs/tags/${tag}"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WARNING: the deploy succeeded but pushing tag $tag failed; other machines will not see it" -ForegroundColor Yellow
  }
}

# An install counts as broken if any tool the build or tests run is missing
# from node_modules\.bin - checking that the folder exists is not enough: a
# worktree cleanup that followed a node_modules junction once left the main
# checkout's folder standing with most of its contents gone.
function Repair-Dependencies([string]$dir, [string[]]$tools, [string]$label) {
  $missing = @($tools | Where-Object { -not (Test-Path (Join-Path $dir "node_modules\.bin\$_.cmd")) })
  if ($missing.Count -eq 0) { return }
  Write-Host ""
  Write-Host "WARNING: $label node_modules is missing $($missing -join ', ') - reinstalling with npm ci" -ForegroundColor Yellow
  npm --prefix $dir ci
  Check "npm ci for $label"
  $still = @($tools | Where-Object { -not (Test-Path (Join-Path $dir "node_modules\.bin\$_.cmd")) })
  if ($still.Count -gt 0) { Fail "npm ci finished but $label node_modules still lacks $($still -join ', ')" }
}

Push-Location $repo
try {
  Repair-Dependencies $repo @('tsc', 'vite', 'tsx') 'the main checkout'

  # --- 3. tests -------------------------------------------------------------
  if ($Test) {
    Step "npm test"
    npm test
    Check "npm test"
  }

  # --- 4. build -------------------------------------------------------------
  Step "npm run build"
  npm run build
  Check "npm run build"
  if (-not (Test-Path (Join-Path $repo 'dist\meltdown.html'))) {
    Fail "the build finished but dist\meltdown.html is missing"
  }

  # --- 5. functions ---------------------------------------------------------
  if ($deployFunctions) {
    Repair-Dependencies (Join-Path $repo 'functions') @('tsc') 'functions\'
    Step "Deploying functions"
    $env:FUNCTIONS_DISCOVERY_TIMEOUT = '60'
    npx firebase-tools deploy --only functions
    Check "the functions deploy (hosting NOT deployed)"
    Move-Tag 'deployed-functions'
  }

  # --- 6. hosting -----------------------------------------------------------
  if (-not $SkipHosting) {
    Step "Deploying hosting"
    npx firebase-tools deploy --only hosting --message "master $short"
    Check "the hosting deploy"
    Move-Tag 'deployed-hosting'
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Deployed $short ($subject)" -ForegroundColor Green
