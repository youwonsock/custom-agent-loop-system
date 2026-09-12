$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repoRoot 'native\verification-host.cpp'
$outputDirectory = Join-Path $repoRoot 'native\bin\win32-x64'
$output = Join-Path $outputDirectory 'verification-host.exe'
if (-not (Test-Path $source -PathType Leaf)) { throw "Missing helper source: $source" }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
  throw 'The verification helper release target is win32-x64.'
}
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$objectDirectory = Join-Path $repoRoot '.build\native'
New-Item -ItemType Directory -Force -Path $objectDirectory | Out-Null
$objectFile = Join-Path $objectDirectory 'verification-host.obj'
$compileArguments = @('/nologo', '/std:c++17', '/O2', '/EHsc', '/DUNICODE', '/D_UNICODE', $source, "/Fo:$objectFile", "/Fe:$output", '/link', '/SUBSYSTEM:CONSOLE')
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if ($cl) {
  & $cl.Source @compileArguments
} else {
  # GitHub's Windows images install Visual Studio but do not guarantee that
  # cl.exe is already on a PowerShell PATH.  Resolve the matching VC toolset
  # through vswhere and run the compiler inside its x64 developer environment.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere -PathType Leaf)) {
    throw 'MSVC cl.exe is required to build verification-host.exe (vswhere.exe was not found).'
  }
  $installation = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1).Trim()
  if (-not $installation) { throw 'Visual Studio C++ x64 tools were not found.' }
  $developerCommand = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $developerCommand -PathType Leaf)) { throw "Visual Studio developer command was not found: $developerCommand" }
  function Quote-CmdArgument([string]$value) {
    return '"' + $value.Replace('"', '\\"') + '"'
  }
  $compilerCommand = ($compileArguments | ForEach-Object {
      if ($_ -match '^[A-Za-z0-9_/:.+-]+$') { $_ } else { Quote-CmdArgument ([string]$_) }
    }) -join ' '
  & cmd.exe /d /s /c ('call ' + (Quote-CmdArgument $developerCommand) + ' -arch=x64 && cl ' + $compilerCommand)
}
if ($LASTEXITCODE -ne 0) { throw "MSVC failed with exit code $LASTEXITCODE." }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
$commit = if ($env:GITHUB_SHA) { $env:GITHUB_SHA } else { (git -C $repoRoot rev-parse HEAD 2>$null).Trim() }
if (-not $commit) { $commit = 'unknown' }
$manifest = [ordered]@{
  schemaVersion = 1
  source = 'native/verification-host.cpp'
  sourceCommit = $commit
  target = 'win32-x64'
  artifact = 'native/bin/win32-x64/verification-host.exe'
  sha256 = $hash
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
# Windows PowerShell's `-Encoding utf8` emits a UTF-8 BOM.  The manifest is
# consumed by Node's JSON parser in package/release verification, so write an
# explicit BOM-free UTF-8 payload instead.
$manifestPath = Join-Path $outputDirectory 'verification-host.manifest.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)
Write-Host "Built $output ($hash)"
