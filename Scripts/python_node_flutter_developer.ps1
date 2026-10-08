[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw "Missing .env at $envPath" }
$keyLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*TWITTER_API_KEY\s*=' } | Select-Object -First 1
if (-not $keyLine) { throw 'TWITTER_API_KEY is not set in .env' }
$apiKey = ($keyLine -replace '^\s*TWITTER_API_KEY\s*=\s*', '').Trim().Trim('"').Trim("'")
if (-not $apiKey) { throw 'TWITTER_API_KEY is empty in .env' }
$defaultOut = Join-Path (Split-Path -Parent $PSScriptRoot) 'twitter_out_python_node_flutter'
$out = $env:TWITTER_OUTPUT_DIR
if (-not $out) { $out = $defaultOut }
. (Join-Path $PSScriptRoot 'twitter_search_common.ps1')
$tests = [ordered]@{
  'A_python' = '"Python developer" OR "Python dev" OR "Python engineer" OR "Django developer" OR "Django expert" OR "FastAPI developer" OR "Flask developer"'
  'B_node_backend' = '"Node.js developer" OR "NodeJS developer" OR "Node dev" OR "Express.js developer" OR "NestJS developer" OR "JavaScript developer" OR "TypeScript developer" OR "MERN stack developer"'
  'C_react_next' = '"React developer" OR "ReactJS developer" OR "React Native developer" OR "React Native dev" OR "Next.js developer" OR "NextJS developer" OR "Next.js engineer" OR "frontend developer"'
  'D_flutter_mobile' = '"Flutter developer" OR "Flutter dev" OR "Flutter engineer" OR "mobile app developer" OR "cross-platform app developer" OR "Android app developer" OR "iOS app developer"'
}
Invoke-TwitterLeadSearch -Tests $tests -OutputDir $out -ApiKey $apiKey -MaxPages 3



