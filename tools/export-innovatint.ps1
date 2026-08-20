param(
  [string]$MysqlPath = "C:\KRISTINE_WORK\Innovatint_2026-08-20_1148\MariaDB-Program\MariaDB\bin\mysql.exe",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3307,
  [string]$Database = "innovatint",
  [string]$OutFile = "C:\KRISTINE_WORK\innovatint-kristine-export.json"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $MysqlPath)) { throw "mysql.exe nicht gefunden: $MysqlPath" }

function Query-Rows([string]$Sql, [string[]]$Columns) {
  $raw = & $MysqlPath -h $HostName -P $Port -u root -D $Database --batch --raw --skip-column-names -e $Sql
  if ($LASTEXITCODE -ne 0) { throw "MySQL-Abfrage fehlgeschlagen" }
  $rows = @()
  foreach ($line in $raw) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split "`t", -1
    $obj = [ordered]@{}
    for ($i=0; $i -lt $Columns.Count; $i++) {
      $v = if ($i -lt $parts.Count) { $parts[$i] } else { "" }
      if ($v -eq "NULL") { $v = $null }
      $obj[$Columns[$i]] = $v
    }
    $rows += [pscustomobject]$obj
  }
  return ,$rows
}

Write-Host "Lese Innovatint-Katalog auf $HostName`:$Port ..."
$colors = Query-Rows "SELECT COLOURID,COLOURCODE,IFNULL(RGB,''),IFNULL(ALTCOLOURCODE,'') FROM colour ORDER BY COLOURID" @("colourId","colourCode","rgb","altColourCode")
$products = Query-Rows "SELECT PRODUCTID,IFNULL(PARENTPRODUCTID,''),PRODUCTNAME,IFNULL(PRODUCTCODE,''),IFNULL(SYSTEMID,'') FROM product ORDER BY PRODUCTID" @("productId","parentProductId","productName","productCode","systemId")
$formulas = Query-Rows "SELECT FORMULAID,IFNULL(ABASEID,''),IFNULL(COLOURID,''),IFNULL(CNTINFORMULA,''),IFNULL(STATUS,''),IFNULL(SOURCE,'') FROM formula ORDER BY FORMULAID" @("formulaId","aBaseId","colourId","cntInFormula","status","source")
$cip = Query-Rows "SELECT COLOURID,PRODUCTID,VERSION,FORMULAID FROM colourinproduct ORDER BY COLOURID,PRODUCTID,VERSION" @("colourId","productId","version","formulaId")
$bases = Query-Rows "SELECT BASEID,PRODUCTID,ABASEID,BASECODE,IFNULL(NOMINALFILL,''),STRENGTH FROM basepaint ORDER BY BASEID" @("baseId","productId","aBaseId","baseCode","nominalFill","strength")
$canSizes = Query-Rows "SELECT CANSIZEID,CANSIZECODE,IFNULL(NOMINALAMOUNT,''),IFNULL(GRAVIMETRIC,'') FROM cansize ORDER BY CANSIZEID" @("canSizeId","canSizeCode","nominalAmount","gravimetric")
$cans = Query-Rows "SELECT CANID,CANSIZEID,IFNULL(BASEID,''),IFNULL(CANSHAPEID,''),IFNULL(FILL,''),IFNULL(DEFBARCODE,''),IFNULL(CANCODE,'') FROM can ORDER BY CANID" @("canId","canSizeId","baseId","canShapeId","fill","defaultBarcode","canCode")
$colorants = Query-Rows "SELECT CNTID,CNTCODE,IFNULL(DESCRIPTION,''),SPECIFICGRAVITY,IFNULL(WETVOLUME,'') FROM colorant ORDER BY CNTID" @("cntId","cntCode","description","specificGravity","wetVolume")

$payload = [ordered]@{
  exportedAt = (Get-Date).ToString("o")
  source = "Innovatint MariaDB 10.1.25 / KRISTINE clone"
  colors = $colors
  products = $products
  formulas = $formulas
  colorInProduct = $cip
  basePaints = $bases
  canSizes = $canSizes
  cans = $cans
  colorants = $colorants
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "FERTIG: $OutFile"
Write-Host "Farben: $($colors.Count) · Produkte: $($products.Count) · Rezepte: $($formulas.Count)"
