function Invoke-TwitterLeadSearch {
  param(
    [System.Collections.IDictionary]$Tests,
    [string]$OutputDir,
    [string]$ApiKey,
    [int]$MaxPages = 2
  )

  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
  $since = [int][double]::Parse((Get-Date).AddDays(-3).ToUniversalTime().Subtract([datetime]'1970-01-01').TotalSeconds)
  $intent = '("looking for" OR "need a" OR "need an" OR "seeking a" OR "looking to hire" OR "hiring a")'
  $exclude = ' -"looking to connect" -"#connect" -"@grok" -"join our team" -"for hire" -"hire me" -"open to work" -"available for" -"#hiring" -"full-time" -"full time" -"internship" -is:retweet lang:en'
  $summary = [System.Collections.Generic.List[object]]::new()

  foreach ($key in $Tests.Keys) {
    $query = $intent + ' (' + $Tests[$key] + ')' + $exclude + " since_time:$since"
    $pages = [System.Collections.Generic.List[object]]::new()
    $allTweets = [System.Collections.Generic.List[object]]::new()
    $seenIds = @{}
    $cursor = $null
    $searchError = $null

    try {
      for ($pageNumber = 1; $pageNumber -le $MaxPages; $pageNumber++) {
        $params = @{ query = $query; queryType = 'Top' }
        if ($cursor) { $params.cursor = $cursor }
        $response = $null
        for ($attempt = 1; $attempt -le 4; $attempt++) {
          try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.twitterapi.io/twitter/tweet/advanced_search' `
              -Headers @{ 'X-API-Key' = $ApiKey } -Method Get -Body $params -TimeoutSec 30
            break
          } catch {
            $statusCode = 0
            if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
            if ($statusCode -ne 429 -or $attempt -eq 4) { throw }
            $retryAfter = 0
            try { $retryAfter = [int]$_.Exception.Response.Headers['Retry-After'] } catch {}
            $waitSeconds = if ($retryAfter -gt 0) { [Math]::Min($retryAfter, 60) } else { [Math]::Min(10 * [Math]::Pow(2, $attempt - 1), 60) }
            Write-Warning "TwitterAPI.io rate limited this page; retrying in $waitSeconds seconds (attempt $attempt of 3)."
            Start-Sleep -Seconds $waitSeconds
          }
        }
        $raw = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
        $page = $raw | ConvertFrom-Json
        if ($null -eq $page.tweets) { throw 'Search response did not include tweets.' }
        $pages.Add($page)
        $pageTweets = @($page.tweets)
        foreach ($tweet in $pageTweets) {
          $id = [string]$tweet.id
          if ($id -and -not $seenIds.ContainsKey($id)) {
            $seenIds[$id] = $true
            $allTweets.Add($tweet)
          }
        }
        $nextCursor = [string]$page.next_cursor
        if ($pageTweets.Count -eq 0 -or -not $nextCursor -or $nextCursor -eq $cursor) { break }
        $cursor = $nextCursor
        if ($pageNumber -lt $MaxPages) { Start-Sleep -Seconds 1 }
      }
    } catch {
      $searchError = $_.Exception.Message
      $httpResponse = $_.Exception.Response
      if ($httpResponse) {
        try {
          $responseStream = $httpResponse.GetResponseStream()
          if ($responseStream) {
            $reader = [System.IO.StreamReader]::new($responseStream)
            $responseBody = $reader.ReadToEnd()
            $reader.Dispose()
            if ($responseBody) { $searchError = "HTTP $([int]$httpResponse.StatusCode): $responseBody" }
          }
        } catch {}
      }
    }

    $normalized = @($allTweets | ForEach-Object {
      [pscustomobject]@{
        id = $_.id
        createdAt = $_.createdAt
        user = $_.author.userName
        text = ($_.text -replace '\s+',' ').Trim()
        link = "https://x.com/$($_.author.userName)/status/$($_.id)"
      }
    })
    $rawBundle = [pscustomobject]@{ query = $query; queryType = 'Top'; pages = $pages.ToArray() }
    $rawBundle | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $OutputDir "raw_${key}_Top.json") -Encoding utf8
    ConvertTo-Json -InputObject $normalized -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDir "tweets_${key}_Top.json") -Encoding utf8

    $count = $normalized.Count
    if ($searchError -and $count -eq 0) { $count = -1 }
    $summaryRow = [pscustomobject]@{ test = $key; type = 'Top'; count = $count; pages = $pages.Count; query = $query; error = $searchError }
    $summary.Add($summaryRow)
    if ($searchError) { '{0} / Top: partial search ({1} tweets): {2}' -f $key, $normalized.Count, $searchError }
    else { '{0} / Top: {1} tweets across {2} page(s)' -f $key, $normalized.Count, $pages.Count }
    $normalized | Select-Object -First 5 | ForEach-Object {
      $text = $_.text; if ($text.Length -gt 110) { $text = $text.Substring(0,110) }
      '   - {0} | {1} | {2}' -f $_.createdAt, $_.user, $text
    }
    Start-Sleep -Seconds 2
  }

  ConvertTo-Json -InputObject $summary.ToArray() -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDir 'summary.json') -Encoding utf8
  "Saved in: $((Resolve-Path $OutputDir).Path)"
}




