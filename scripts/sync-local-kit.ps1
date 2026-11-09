param(
  [string]$Workspace = 'C:\Users\03\Documents\deepseek-harness\default-workspace',
  [string]$SkillsHome = (Join-Path $env:USERPROFILE '.dsh\skills'),
  [string]$Token = $env:GH_TOKEN,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repo 'sync-manifest.json'
if (-not (Test-Path $manifestPath)) { throw "missing sync-manifest.json" }
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Sync-Dir([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) { Write-Warning "skip missing: $src"; return }
  robocopy $src $dst /MIR /XD node_modules .git /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $src (exit $LASTEXITCODE)" }
}

foreach ($name in $manifest.plugins) {
  $src = if ($name -eq 'dsh-team-ops') { Join-Path $Workspace 'tools\team-ops-plugin' } else { Join-Path $Workspace "plugins\$name" }
  Sync-Dir $src (Join-Path $repo "plugins\$name")
}

foreach ($name in $manifest.skills) {
  Sync-Dir (Join-Path $SkillsHome $name) (Join-Path $repo "skills\$name")
}

Push-Location $repo
try {
  git add -A
  if (-not (git status --porcelain)) { Write-Host 'nothing to sync'; return }
  git -c user.name='dsh-kit sync' -c user.email='dsh-kit@users.noreply.github.com' commit -m "sync: local plugins and skills $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Host
  if ($NoPush) { Write-Host 'committed (not pushed)'; return }

  if (-not $Token) {
    $secure = Read-Host 'GitHub token (input hidden)' -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
  git -c http.extraheader="AUTHORIZATION: basic $basic" push origin HEAD:main
  Write-Host 'pushed to origin/main'
} finally {
  Pop-Location
}
