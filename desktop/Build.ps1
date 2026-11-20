param([string] $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Resolve-Path -LiteralPath $NodeExe).Path
$nodeVersion = (& $node --version).Trim()
$nodeArch = (& $node -p 'process.arch').Trim()
if ($nodeVersion -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 20 -or $nodeArch -ne 'x64') {
    throw 'The desktop build requires x64 Node.js 20 or newer.'
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The .NET Framework C# compiler is unavailable.' }

$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ('sjtu-latex-build-' + [Guid]::NewGuid().ToString('N'))
$runtime = Join-Path $buildRoot 'runtime'
$output = Join-Path $repo 'dist'
New-Item -ItemType Directory -Path $runtime, $output -Force | Out-Null

try {
    Copy-Item -LiteralPath (Join-Path $repo 'package.json'), (Join-Path $repo 'package-lock.json'), (Join-Path $repo 'migrate.mjs') -Destination $runtime
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'desktop-self-test.mjs') -Destination $runtime
    Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile (Join-Path $runtime 'NODE-LICENSE.txt')

    Push-Location $runtime
    try {
        & npm.cmd ci --ignore-scripts --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally { Pop-Location }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $payload = Join-Path $buildRoot 'runtime.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($runtime, $payload, [IO.Compression.CompressionLevel]::Optimal, $false)
    $exe = Join-Path $output 'SJTU-LaTeX-Migration-win-x64-background.exe'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 `
        '/reference:System.Drawing.dll,System.Windows.Forms.dll,System.Web.Extensions.dll,System.IO.Compression.dll,System.IO.Compression.FileSystem.dll' `
        "/resource:$payload,SJTULaTeX.Runtime.zip" "/out:$exe" (Join-Path $PSScriptRoot 'Program.cs')
    if ($LASTEXITCODE -ne 0) { throw 'C# compilation failed.' }
    Get-FileHash -LiteralPath $exe -Algorithm SHA256
} finally {
    $resolvedBuildRoot = (Resolve-Path -LiteralPath $buildRoot).Path
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedBuildRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedBuildRoot) -match '^sjtu-latex-build-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
    }
}
