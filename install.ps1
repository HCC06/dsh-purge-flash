<#
  一键安装 dsh-purge-flash（Windows / PowerShell 5.1+，不需要 Node）
  ---------------------------------------------------------------
  它做的事只有三件：
    1. 在 <DSH_HOME>/profiles/<名字>/package.json 里加一条 link: 依赖 + 一条 bundles 条目
    2. 把本仓库复制到 <profile>/node_modules/dsh-purge-flash
    3. 校验 JSON 还能解析，不能就还原备份

  不需要联网、不需要 npm、不改 DSH 安装目录里的任何文件。

  用法：
    双击 install.bat
    或 powershell -ExecutionPolicy Bypass -File install.ps1
    可选参数：
      -Profile desktop     目标 profile 名（默认 desktop）
      -DshHome D:\path      指定 DSH_HOME（默认读 $env:DSH_HOME，否则 ~\.dsh）
      -DryRun               只看它会改什么，不落盘
#>

[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$DshHome = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$Pkg  = 'dsh-purge-flash'

function Say($t) { Write-Host $t }
function Ok($t)  { Write-Host "  [ok] $t" -ForegroundColor Green }
function Warn($t){ Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Die($t) {
  Write-Host ""
  Write-Host "  [x]  $t" -ForegroundColor Red
  Write-Host ""
  Write-Host "  没装成。什么都没改，或者已经还原了备份。"
  Write-Host "  把上面这几行发给作者，附上你的 DSH 安装路径即可。"
  Write-Host ""
  exit 1
}

Say ""
Say "  dsh-purge-flash 安装器"
Say "  ---------------------"
Say "  仓库位置：$Repo"

# ---------- 1. 找 DSH_HOME ----------
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif ($env:USERPROFILE) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}

if (-not $DshHome -or -not (Test-Path $DshHome)) {
  Die "找不到 DSH 的数据目录（DSH_HOME）。请先启动一次 DeepSeek Harness，让它自己建出这个目录；或者用 -DshHome 指定它。"
}
Say "  DSH 数据目录：$DshHome"

# ---------- 2. 找 profile 的 package.json ----------
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfDir     = Join-Path $ProfilesDir $Profile
$PkgPath     = Join-Path $ProfDir 'package.json'

if (-not (Test-Path $PkgPath)) {
  if (Test-Path $ProfilesDir) {
    $cands = Get-ChildItem $ProfilesDir -Directory |
             Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
             Select-Object -ExpandProperty Name
    if ($cands) {
      Warn "profile「$Profile」不存在。可用的有：$($cands -join ', ')"
      Die "用 -Profile <名字> 指定其中一 个重跑。"
    }
  }
  Die "找不到 $PkgPath。请先启动一次 DSH，让它把 profile 建出来。"
}
Say "  目标 profile：$ProfDir"

# ---------- 3. 备份 ----------
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = "$PkgPath.bak-before-flash-$stamp"
if (-not $DryRun) { Copy-Item $PkgPath $Backup -Force; Say "  备份：$Backup" }

# ---------- 4. 改 package.json（文本插入，保留原有格式） ----------
$text = Get-Content $PkgPath -Raw -Encoding UTF8
$linkVal = 'link:' + ($Repo -replace '\\', '/')

if ($text -match [regex]::Escape("`"$Pkg`"")) {
  Ok "package.json 里已经有 $Pkg 了，跳过这一步"
} else {
  # 4a. dependencies
  $depLine = "`"$Pkg`": `"$linkVal`","
  $m = [regex]::Match($text, '"dependencies"\s*:\s*\{')
  if (-not $m.Success) { Die "profile 的 package.json 里没有 dependencies 段，版本可能太老。把这份文件发给作者看看。" }
  $at = $m.Index + $m.Length
  $text = $text.Insert($at, "`r`n    $depLine")
  Ok "已加依赖 $Pkg → $linkVal"

  # 4b. dsh.profile.bundles
  $mb = [regex]::Match($text, '"bundles"\s*:\s*\[([\s\S]*?)\]')
  if (-not $mb.Success) { Die "profile 的 package.json 里没有 dsh.profile.bundles 段。把这份文件发给作者看看。" }
  $innerStart = $mb.Groups[1].Index
  $trimmed = $mb.Groups[1].Value.TrimEnd()
  if ($trimmed.Length -gt 0) {
    $text = $text.Insert($innerStart + $trimmed.Length, ",`r`n        `"$Pkg`"")
  } else {
    $text = $text.Insert($innerStart, "`r`n        `"$Pkg`"`r`n      ")
  }
  Ok "已加 bundles 条目 $Pkg"
}

if ($DryRun) {
  Say ""
  Say "  --- DryRun：下面是改完的样子（没落盘） ---"
  Say $text
  exit 0
}

# 先校验能不能解析，再落盘
try { $null = $text | ConvertFrom-Json } catch {
  Copy-Item $Backup $PkgPath -Force
  Die "改完之后 JSON 解析不了，已还原。这通常说明这份 package.json 本身就有格式问题。"
}
[System.IO.File]::WriteAllText($PkgPath, $text, (New-Object System.Text.UTF8Encoding $false))
Ok "package.json 已写入并校验通过"

# ---------- 5. 复制到 node_modules ----------
$NmDir  = Join-Path $ProfDir 'node_modules'
$Target = Join-Path $NmDir $Pkg
if (-not (Test-Path $NmDir)) { New-Item -ItemType Directory -Path $NmDir | Out-Null }

$exists = Test-Path $Target
if ($exists) {
  # 已经是软链/联接：保留它，指向本仓库的位置由 DSH 自己维护
  $item = Get-Item $Target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Ok "node_modules\$Pkg 已是一个链接，跳过复制"
    $exists = $false
  } else {
    Warn "node_modules\$Pkg 已存在（不是链接），将覆盖"
    Remove-Item $Target -Recurse -Force
  }
}

if (Test-Path $Target) { <# 链接的情况，不动 #> } else {
  $skip = @('.git', 'node_modules', 'docs', 'posters')
  Get-ChildItem $Repo -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $Target -Recurse -Force
  }
  Ok "已复制到 node_modules\$Pkg"
}

# ---------- 6. 完 ----------
Say ""
Say "  装好了。还差一步："
Say ""
Say "    1. 完全退出 DeepSeek Harness（关窗口不算，要从托盘/任务管理器退进程）"
Say "    2. 重新打开"
Say "    3. 随便发一条消息，然后输入 /armor status"
Say ""
Say "  status 里看到「内核 ✓ on」就是成了。"
Say "  如果每一行都是 —，说明 profile 名不对或没重启，重跑一次本脚本并加 -Profile <名字>。"
Say ""
