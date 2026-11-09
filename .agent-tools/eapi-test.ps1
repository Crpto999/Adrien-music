$ErrorActionPreference = "Stop"

function Get-Md5Hex([string]$s) {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
  $hash = $md5.ComputeHash($bytes)
  return -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Get-EapiParams([string]$uri, $data) {
  # JSON with no spaces, non-ASCII kept raw
  $text = ($data | ConvertTo-Json -Depth 10 -Compress)
  $digest = Get-Md5Hex ("nobody" + $uri + "use" + $text + "md5forencrypt")
  $payload = $uri + "-36cd479b6b5-" + $text + "-36cd479b6b5-" + $digest

  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Mode = [System.Security.Cryptography.CipherMode]::ECB
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = [System.Text.Encoding]::UTF8.GetBytes("e82ckenh8dichen8")
  $enc = $aes.CreateEncryptor().TransformFinalBlock([System.Text.Encoding]::UTF8.GetBytes($payload), 0, [System.Text.Encoding]::UTF8.GetByteCount($payload))
  return -join ($enc | ForEach-Object { $_.ToString("X2") })
}

function Invoke-Eapi([string]$uri, $data) {
  $params = Get-EapiParams $uri $data
  $url = "https://interface.music.163.com/eapi/" + ($uri -replace "^/api/", "")
  try {
    $r = Invoke-WebRequest -Uri $url -Method POST -Body @{ params = $params } -ContentType "application/x-www-form-urlencoded" -Headers @{ "User-Agent"="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"; "Referer"="https://music.163.com/" } -UseBasicParsing
    return "HTTP $($r.StatusCode) :: " + $r.Content.Substring(0, [Math]::Min(400, $r.Content.Length))
  } catch {
    $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
    $t = $sr.ReadToEnd()
    return "HTTP $($_.Exception.Response.StatusCode.value__) :: " + $t.Substring(0, [Math]::Min(400, $t.Length))
  }
}

$header = @{
  os = "pc"; appver = "3.1.17.204416"; osver = "Microsoft-Windows-10-Professional-build-19045-64bit"
  deviceId = "pyncm!"; channel = "netease"; versioncode = "140"; mobilename = ""
  buildver = "200000000000"; resolution = "1920x1080"; __csrf = ""; requestId = "1_1"
}

Write-Output "=== control: /api/song/lyric (known good, anonymous) ==="
Invoke-Eapi "/api/song/lyric" @{ id = "1824045033"; lv = -1; tv = -1; rv = -1; kv = -1; _nmclfl = 1; header = $header }

Write-Output ""
Write-Output "=== /api/song/like (anonymous -> expect a login-ish code) ==="
Invoke-Eapi "/api/song/like" @{ trackId = "28935275"; userid = "123456"; like = $true; header = $header }

Write-Output ""
Write-Output "=== /api/v3/discovery/recommend/songs (anonymous) ==="
Invoke-Eapi "/api/v3/discovery/recommend/songs" @{ header = $header }
