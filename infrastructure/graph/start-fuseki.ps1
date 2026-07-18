# Arranca o Fuseki local do OSWADT (porta 3030) com os datasets oswadt-dev
# (persistente, TDB2) e oswadt-test (em memoria), autenticacao basica de
# desenvolvimento (admin / oswadt-dev-graph) e health em http://localhost:3030/$/ping.
# (Este ficheiro usa apenas ASCII de proposito: PowerShell 5.1 le .ps1 sem BOM
#  como ANSI e caracteres acentuados corrompem o parsing.)
#
# Pre-requisitos: Java 17+ e setup-fuseki.ps1 executado uma vez.
# Uso:  powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1

$ErrorActionPreference = "Stop"

$FusekiVersion = "5.6.0"   # manter em sincronia com setup-fuseki.ps1
$GraphDir = $PSScriptRoot
$ExtractedDir = Join-Path $GraphDir "dist\apache-jena-fuseki-$FusekiVersion"
$RunDir = Join-Path $GraphDir "run"
$ConfigFile = Join-Path $GraphDir "config\oswadt-fuseki.ttl"

if (-not (Test-Path (Join-Path $ExtractedDir "fuseki-server.jar"))) {
    throw "Fuseki nao preparado. Execute primeiro: powershell -ExecutionPolicy Bypass -File infrastructure\graph\setup-fuseki.ps1"
}

# java -version escreve no stderr; cmd /c junta os streams sem irritar o PowerShell
$javaVersionLine = (cmd /c "java -version 2>&1" | Select-Object -First 1)
Write-Output "Java detetado: $javaVersionLine"

New-Item -ItemType Directory -Force (Join-Path $RunDir "databases") | Out-Null

# shiro.ini vive em FUSEKI_BASE (run/); copiado do template na primeira execucao
$shiroTarget = Join-Path $RunDir "shiro.ini"
if (-not (Test-Path $shiroTarget)) {
    Copy-Item (Join-Path $GraphDir "config\shiro.ini") $shiroTarget
    Write-Output "shiro.ini de desenvolvimento copiado para run/."
}

$env:FUSEKI_BASE = $RunDir
Set-Location $GraphDir   # tdb2:location no config e' relativo a este diretorio

Write-Output "A arrancar Fuseki $FusekiVersion em http://localhost:3030 (Ctrl+C para parar)"
Write-Output "  datasets: /oswadt-dev (TDB2) e /oswadt-test (memoria)"
& java -jar (Join-Path $ExtractedDir "fuseki-server.jar") --config=$ConfigFile
