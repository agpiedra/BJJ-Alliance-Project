# Owner-run only: one authenticated GET of /api/health/email-policy (docs/EMAIL_RECIPIENT_POLICY.md).
#
# - Calls ONLY <BaseUrl>/api/health/email-policy. The route reads settings only: no database, no email, no send.
# - CRON_SECRET is read with a hidden prompt. It is never printed, written to disk, set as an environment variable or
#   passed on a command line. Redirects are not followed, so the Authorization header cannot reach another host.
# - For -Expect allowlist, the intended addresses are typed here (never into chat) and only used to compute the same
#   keyed fingerprint locally. Neither the addresses nor any fingerprint is printed; only match / no match.
# - Prints the HTTP status and fixed field values only. Do not run it inside Start-Transcript.
#
# Usage: powershell -File docs/email-policy-status-check.ps1 -BaseUrl https://<deployment-host> -Expect allowlist
# Exit: 0 = the deployment enforces exactly the expected policy; 1 = anything else.
param(
  [Parameter(Mandatory)][ValidatePattern('^https://[^/]+$')][string]$BaseUrl,
  [Parameter(Mandatory)][ValidateSet('allowlist', 'unrestricted')][string]$Expect
)
$ErrorActionPreference = 'Stop'

# Same normalization as src/lib/email/recipient-policy.ts: trim, lowercase, strict address pattern, at most 25,
# unique, ordinal sort, joined by "\n". Returns $null when the list would be rejected by the app.
function Get-NormalizedAllowlist([string]$Raw) {
  if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
  $entries = @($Raw.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() })
  if ($entries.Count -gt 25) { return $null }
  foreach ($e in $entries) { if ($e -cnotmatch '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$') { return $null } }
  [string[]]$unique = @($entries | Select-Object -Unique)
  [Array]::Sort($unique, [StringComparer]::Ordinal)
  return , $unique
}

function Get-AllowlistFingerprint([string]$Key, [string[]]$Addresses) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($Key))
  try { -join ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes(($Addresses -join "`n"))) | ForEach-Object { $_.ToString('x2') }) }
  finally { $hmac.Dispose() }
}

function Test-EmailPolicyStatus([int]$Code, [string]$Body, [string]$Expect, [int]$ExpectedCount, [string]$ExpectedFingerprint) {
  function Line([bool]$ok, [string]$name, [string]$detail) { '{0,-4} {1}: {2}' -f $(if ($ok) { 'ok' } else { 'FAIL' }), $name, $detail }
  if ($Code -ne 200) {
    $why = if ($Code -eq 401) { ' (secret not accepted: stop; do not retry; do not rotate)' } else { '' }
    return @(Line $false 'http status' "$Code$why")
  }
  $out = @(Line $true 'http status' '200')
  try { $s = $Body | ConvertFrom-Json } catch { return $out + (Line $false 'response' 'not JSON') }
  $out += Line ($s.mode -eq $Expect) 'mode' "$($s.mode)"
  $out += Line ($s.effective -eq $Expect) 'effective policy' "$($s.effective)$(if ($s.reason) { " (reason: $($s.reason))" })"
  $out += Line ($s.deploymentTarget -eq 'production') 'deployment target' "$($s.deploymentTarget)"
  if ($Expect -eq 'allowlist') {
    $out += Line ($s.allowlistCount -eq $ExpectedCount) 'allowlist count' "deployed=$($s.allowlistCount) intended=$ExpectedCount"
    $match = $null -ne $s.allowlistFingerprint -and $s.allowlistFingerprint -eq $ExpectedFingerprint
    $out += Line $match 'allowlist fingerprint' $(if ($match) { 'matches the intended list' } else { 'does NOT match the intended list' })
  } else {
    $out += Line ($null -eq $s.allowlistCount -and $null -eq $s.allowlistFingerprint) 'no allowlist in effect' "count=$($s.allowlistCount)"
  }
  $out += Line ($s.providerKeyPresent -eq $true) 'provider key present' "$($s.providerKeyPresent)"
  $out += Line ($s.senderConfigured -eq $true) 'sender configured' "$($s.senderConfigured)"
  $out
}

$Url = "$BaseUrl/api/health/email-policy"
"One GET to $Url. No other request is made."
$sec = $null; $bstr = [IntPtr]::Zero; $plain = $null; $headers = $null; $body = $null; $fingerprint = $null; $list = $null; $count = 0
try {
  $sec = Read-Host -AsSecureString 'Enter CRON_SECRET (input hidden)'
  if ($sec.Length -eq 0) { throw 'STOP: empty input; nothing was sent.' }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($Expect -eq 'allowlist') {
    $list = Get-NormalizedAllowlist (Read-Host 'Enter the intended allowlist, comma-separated (not printed)')
    if ($null -eq $list) { throw 'STOP: the intended list is empty or invalid (the app would block every send); nothing was sent.' }
    $count = $list.Count
    $fingerprint = Get-AllowlistFingerprint $plain $list
    $list = $null
  }
  $headers = @{ Authorization = "Bearer $plain" }
  $plain = $null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $code = 0
  try {
    $r = Invoke-WebRequest -Uri $Url -Method Get -Headers $headers -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30
    $code = [int]$r.StatusCode; $body = $r.Content
  } catch [System.Net.WebException] {
    if ($null -eq $_.Exception.Response) { throw "STOP: no HTTP response ($($_.Exception.Status)). Do not retry." }
    $code = [int]$_.Exception.Response.StatusCode
  }
  $headers.Clear(); $headers = $null
  $lines = Test-EmailPolicyStatus $code $body $Expect $count $fingerprint
  $body = $null; $fingerprint = $null
  $lines
  if (@($lines | Where-Object { $_ -like 'FAIL*' }).Count -eq 0) { "RESULT: PASS (deployment enforces $Expect as intended)"; $rc = 0 }
  else { 'RESULT: FAIL (send these lines; do not retry)'; $rc = 1 }
}
catch {
  if ("$($_.Exception.Message)" -like 'STOP:*') { $_.Exception.Message } else { "STOP: $($_.Exception.GetType().FullName)" }
  'RESULT: FAIL'; $rc = 1
}
finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($headers) { $headers.Clear() }
  if ($sec) { $sec.Dispose() }
  $plain = $null; $headers = $null; $body = $null; $fingerprint = $null; $list = $null
  Remove-Variable sec, bstr, plain, headers, body, fingerprint, list -ErrorAction SilentlyContinue
  [GC]::Collect()
}
exit $rc
