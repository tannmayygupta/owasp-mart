# Throwaway certificates for the live check of state reports (docs/runbooks/edge-vm-i.md part 3b). Run on your PC; needs openssl.
# One test CA (2 days) signs: the vm-p ingest server certificate, the vm-i orchestrator server certificate and one client certificate.
# The extensions are the ones Python 3.14 requires (a CA without keyUsage is refused by its strict certificate check).
# Never commit the output folder. Usage: .\scripts\make-test-certs.ps1 -OrchIp <vm-i private address> -IngestIp <vm-p private address> -Out $env:TEMP\vmcerts
param(
  [Parameter(Mandatory = $true)][string]$OrchIp,
  [Parameter(Mandatory = $true)][string]$IngestIp,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory $Out | Out-Null
Push-Location $Out
try {
  function Ossl { param([string[]]$a) cmd /c ("openssl " + ($a -join " ") + " 2>nul") | Out-Null; if ($LASTEXITCODE -ne 0) { throw "openssl $($a[0]) failed" } }
  function Leaf { param([string]$name, [string]$cn, [string]$usage, [string]$san)
    Ossl @('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', "$name.key", '-out', "$name.csr", '-subj', "/CN=$cn")
    $ext = "basicConstraints=CA:FALSE`nkeyUsage=digitalSignature`nextendedKeyUsage=$usage`n"
    if ($san) { $ext += "subjectAltName=$san`n" }
    [IO.File]::WriteAllText("$Out\$name.ext", $ext, (New-Object Text.UTF8Encoding $false))
    Ossl @('x509', '-req', '-in', "$name.csr", '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', "$name.pem", '-days', '2', '-extfile', "$name.ext")
    Remove-Item "$name.csr", "$name.ext"
  }
  Ossl @('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=vulnmart-test-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
  Leaf 'ingest' 'ingest' 'serverAuth' "IP:$IngestIp"
  Leaf 'orch' 'orchestrator' 'serverAuth' "IP:$OrchIp"
  Leaf 'client' 'platform' 'clientAuth' ''
  $rand = { -join ((1..64) | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] }) }
  foreach ($n in 'report_key', 'platform_key') { [IO.File]::WriteAllText("$Out\$n", (& $rand), (New-Object Text.ASCIIEncoding)) }
  Remove-Item 'ca.srl' -ErrorAction SilentlyContinue
  Write-Output "made: $((Get-ChildItem $Out | Select-Object -ExpandProperty Name) -join ', ')"
} finally { Pop-Location }
