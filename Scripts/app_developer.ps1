[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$envPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw "Missing .env at $envPath" }
$keyLine = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*TWITTER_API_KEY\s*=' } | Select-Object -First 1
if (-not $keyLine) { throw 'TWITTER_API_KEY is not set in .env' }
$apiKey = ($keyLine -replace '^\s*TWITTER_API_KEY\s*=\s*', '').Trim().Trim('"').Trim("'")
if (-not $apiKey) { throw 'TWITTER_API_KEY is empty in .env' }
$defaultOut = Join-Path (Split-Path -Parent $PSScriptRoot) 'twitter_out_app_developer'
$out = $env:TWITTER_OUTPUT_DIR
if (-not $out) { $out = $defaultOut }
. (Join-Path $PSScriptRoot 'twitter_search_common.ps1')
$tests = [ordered]@{
  'A_mobile_app' = '"app developer" OR "mobile app developer" OR "iOS developer" OR "Android developer" OR "React Native developer" OR "Flutter developer" OR "cross-platform app developer"'
}
Invoke-TwitterLeadSearch -Tests $tests -OutputDir $out -ApiKey $apiKey -MaxPages 3


