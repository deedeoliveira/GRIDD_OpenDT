# Descarrega e prepara o Apache Jena Fuseki (versao FIXADA) para uso local.
# Idempotente: se a versao ja estiver extraida em dist/, nao repete o download.
# Nada do que este script cria e' versionado (dist/ e run/ estao no .gitignore).
# (Este ficheiro usa apenas ASCII de proposito: PowerShell 5.1 le .ps1 sem BOM
#  como ANSI e caracteres acentuados corrompem o parsing.)
#
# Uso:  powershell -ExecutionPolicy Bypass -File infrastructure\graph\setup-fuseki.ps1

$ErrorActionPreference = "Stop"

$FusekiVersion = "5.6.0"   # versao fixada (requer Java 17+)
$BaseName = "apache-jena-fuseki-$FusekiVersion"
$ArchiveUrl = "https://archive.apache.org/dist/jena/binaries/$BaseName.zip"

$GraphDir = $PSScriptRoot
$DistDir = Join-Path $GraphDir "dist"
$RunDir = Join-Path $GraphDir "run"
$ZipPath = Join-Path $DistDir "$BaseName.zip"
$ExtractedDir = Join-Path $DistDir $BaseName

New-Item -ItemType Directory -Force $DistDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $RunDir "databases") | Out-Null

if (Test-Path (Join-Path $ExtractedDir "fuseki-server.jar")) {
    Write-Output "Fuseki $FusekiVersion ja preparado em $ExtractedDir - nada a fazer."
    exit 0
}

Write-Output "A descarregar $ArchiveUrl ..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ZipPath -UseBasicParsing

Write-Output "A verificar SHA512 ..."
$expected = ((Invoke-WebRequest -Uri "$ArchiveUrl.sha512" -UseBasicParsing).Content -split "\s+")[0].Trim().ToLower()
$actual = (Get-FileHash -Algorithm SHA512 $ZipPath).Hash.ToLower()
if ($expected -ne $actual) {
    Remove-Item $ZipPath -Force -Confirm:$false
    throw "SHA512 nao corresponde (esperado $expected, obtido $actual). Download removido."
}

Write-Output "A extrair para $DistDir ..."
Expand-Archive -Path $ZipPath -DestinationPath $DistDir -Force
Remove-Item $ZipPath -Force -Confirm:$false

if (-not (Test-Path (Join-Path $ExtractedDir "fuseki-server.jar"))) {
    throw "Extracao falhou: $ExtractedDir\fuseki-server.jar nao encontrado."
}
Write-Output "Fuseki $FusekiVersion pronto. Arranque com: powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1"
