<#
  一键安装 dsh-purge-flash
  ------------------------------------------------------------------
  只做三件事，不碰 DSH 安装目录里的任何文件：
    1. 在 <DSH_HOME>/profiles/<名字>/package.json 里登记 link: 依赖与 bundles 条目
    2. 把本仓库复制到 <profile>/node_modules/dsh-purge-flash
    3. 校验 JSON 还能解析，不能就还原备份

  用法：双击 install.bat
  可选：install.bat -Profile <名字> -DshHome <路径> -DryRun
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
  Write-Host "  没装成。配置没有被破坏（改过的话已经还原）。"
  Write-Host "  把上面几行连同下面这段一起发给作者："
  Write-Host "  --- 8< ---"
  Write-Host "  repo    : $Repo"
  Write-Host "  home    : $DshHome"
  Write-Host "  profile : $Profile"
  Write-Host "  ps      : $($PSVersionTable.PSVersion)"
  Write-Host "  os      : $([Environment]::OSVersion.VersionString)"
  Write-Host "  --- 8< ---"
  Write-Host ""
  exit 1
}

Say ""
Say "  dsh-purge-flash 安装器"
Say "  ---------------------"
Say "  仓库位置：$Repo"

if ($Repo -match '\s') {
  Warn "路径里有空格（$Repo）。能装，但装完没生效的话，先把整个文件夹挪到没有空格的路径再跑一次。"
}

# ---------- 1. 找 DSH_HOME ----------
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  elseif ($env:USERPROFILE) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not $DshHome -or -not (Test-Path $DshHome)) {
  Die "找不到 DSH 数据目录。先启动一次 DeepSeek Harness 让它自己建出来，或者用 -DshHome 指定。"
}
Say "  DSH 数据目录：$DshHome"

# ---------- 2. 找 profile ----------
$ProfilesDir = Join-Path $DshHome 'profiles'
$ProfDir     = Join-Path $ProfilesDir $Profile
$PkgPath     = Join-Path $ProfDir 'package.json'

if (-not (Test-Path $PkgPath)) {
  if (Test-Path $ProfilesDir) {
    $cands = Get-ChildItem $ProfilesDir -Directory |
             Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
             Select-Object -ExpandProperty Name
    if ($cands) {
      Warn "profile「$Profile」不存在。这台机器上有：$($cands -join ', ')"
      Die "用 install.bat -Profile <名字> 指定其中一个重跑。"
    }
  }
  Die "找不到 $PkgPath。先启动一次 DSH。"
}
Say "  目标 profile：$ProfDir"

# ---------- 3. 改 package.json ----------
$text = Get-Content $PkgPath -Raw -Encoding UTF8
$linkVal = 'link:' + ($Repo -replace '\\', '/')

$mDep = [regex]::Match($text, '"dependencies"\s*:\s*\{([\s\S]*?)\}')
if (-not $mDep.Success) { Die "package.json 里没有 dependencies 段，版本可能太老。" }
$hasDep = $mDep.Groups[1].Value -match [regex]::Escape("`"$Pkg`"")

$mBun = [regex]::Match($text, '"bundles"\s*:\s*\[([\s\S]*?)\]')
if (-not $mBun.Success) { Die "package.json 里没有 dsh.profile.bundles 段，版本可能太老。" }
$hasBun = $mBun.Groups[1].Value -match [regex]::Escape("`"$Pkg`"")

if ($hasDep -and $hasBun) {
  Ok "package.json 里已经登记过了，跳过"
} else {
  $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Backup = "$PkgPath.bak-before-flash-$stamp"
  if (-not $DryRun) { Copy-Item $PkgPath $Backup -Force; Say "  备份：$Backup" }

  if (-not $hasDep) {
    $open = [regex]::Match($text, '"dependencies"\s*:\s*\{')
    $at = $open.Index + $open.Length
    $text = $text.Insert($at, "`r`n    `"$Pkg`": `"$linkVal`",")
    Ok "加依赖 → $linkVal"
  } else {
    Ok "依赖已存在"
  }

  if (-not $hasBun) {
    $mBun2 = [regex]::Match($text, '"bundles"\s*:\s*\[([\s\S]*?)\]')
    $innerStart = $mBun2.Groups[1].Index
    $trimmed = $mBun2.Groups[1].Value.TrimEnd()
    if ($trimmed.Length -gt 0) {
      $text = $text.Insert($innerStart + $trimmed.Length, ",`r`n        `"$Pkg`"")
    } else {
      $text = $text.Insert($innerStart, "`r`n        `"$Pkg`"`r`n      ")
    }
    Ok "加 bundles 条目"
  } else {
    Ok "bundles 已存在"
  }

  if ($DryRun) {
    Say ""
    Say "  --- DryRun：下面是改完的样子（没落盘） ---"
    Say $text
    exit 0
  }

  try { $null = $text | ConvertFrom-Json } catch {
    Copy-Item $Backup $PkgPath -Force
    Die "改完 JSON 解析不了，已还原。这份 package.json 本身可能有格式问题。"
  }
  [System.IO.File]::WriteAllText($PkgPath, $text, (New-Object System.Text.UTF8Encoding $false))
  Ok "package.json 已写入并校验通过"
}

# ---------- 4. 复制到 node_modules ----------
$NmDir  = Join-Path $ProfDir 'node_modules'
$Target = Join-Path $NmDir $Pkg
if (-not (Test-Path $NmDir)) { New-Item -ItemType Directory -Path $NmDir | Out-Null }

$doCopy = $true
if (Test-Path $Target) {
  $item = Get-Item $Target -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Ok "node_modules\$Pkg 已是一个链接，跳过复制"
    $doCopy = $false
  } else {
    Remove-Item $Target -Recurse -Force
  }
}

if ($doCopy) {
  $skip = @('.git', 'node_modules', 'posters')
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  Get-ChildItem $Repo -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $Target -Recurse -Force
  }
  Ok "已复制到 node_modules\$Pkg"
}

# ---------- 5. 完 ----------
Say ""
Say "  装好了。还差一步："
Say ""
Say "    1. 完全退出 DeepSeek Harness（关窗口不算，要从托盘或任务管理器退进程）"
Say "    2. 重新打开，发一条消息"
Say "    3. 输入 /armor status，看到「内核 ✓ on」就成了"
Say ""
Say "  如果 status 全是一行行 —：确认重启了、profile 名对不对。"
Say "  如果「操作稿」那行是「! 空」：$DshHome\prompt-inject.md 还没写，强度会明显偏低。"
Say ""
