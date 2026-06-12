<#
.SYNOPSIS
    Generates the two icons required by the Cowork plugin package:
      color.png   (192x192, full colour)
      outline.png ( 32x32, single-colour outline, transparent background)

.DESCRIPTION
    Draws a simple map-pin glyph using System.Drawing (GDI+). Run once; the PNGs are
    committed with the package. Replace with brand artwork before store submission.

.EXAMPLE
    ./New-Icons.ps1
#>
[CmdletBinding()]
param(
    [string]$OutputDir = $PSScriptRoot,
    [string]$AccentHex = "#E2231A"   # TomTom-style red
)

Add-Type -AssemblyName System.Drawing

function ConvertFrom-Hex([string]$hex) {
    $hex = $hex.TrimStart('#')
    return [System.Drawing.Color]::FromArgb(
        [Convert]::ToInt32($hex.Substring(0, 2), 16),
        [Convert]::ToInt32($hex.Substring(2, 2), 16),
        [Convert]::ToInt32($hex.Substring(4, 2), 16)
    )
}

$accent = ConvertFrom-Hex $AccentHex

# ---------------------------------------------------------------------------
# color.png — 192x192 filled rounded background + white map pin
# ---------------------------------------------------------------------------
$size = 192
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded background
$radius = 36
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$bg.AddArc(0, 0, $d, $d, 180, 90)
$bg.AddArc($size - $d, 0, $d, $d, 270, 90)
$bg.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$bg.AddArc(0, $size - $d, $d, $d, 90, 90)
$bg.CloseFigure()
$brushBg = New-Object System.Drawing.SolidBrush($accent)
$g.FillPath($brushBg, $bg)

# White map pin (head circle + pointed base)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$cx = 96; $headCy = 80; $headR = 38
$pin = New-Object System.Drawing.Drawing2D.GraphicsPath
$pin.AddEllipse(($cx - $headR), ($headCy - $headR), ($headR * 2), ($headR * 2))
# Triangle to the tip
$pts = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF(($cx - 30), ($headCy + 18))),
    (New-Object System.Drawing.PointF(($cx + 30), ($headCy + 18))),
    (New-Object System.Drawing.PointF([float]$cx, [float]156))
)
$pin.AddPolygon($pts)
$g.FillPath($white, $pin)

# Inner hole (accent-coloured) to give the classic ring look
$holeR = 16
$g.FillEllipse($brushBg, ($cx - $holeR), ($headCy - $holeR), ($holeR * 2), ($holeR * 2))

$colorPath = Join-Path $OutputDir "color.png"
$bmp.Save($colorPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "Wrote $colorPath (192x192)"

# ---------------------------------------------------------------------------
# outline.png — 32x32 transparent, single-colour pin outline
# ---------------------------------------------------------------------------
$osize = 32
$obmp = New-Object System.Drawing.Bitmap($osize, $osize)
$og = [System.Drawing.Graphics]::FromImage($obmp)
$og.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$og.Clear([System.Drawing.Color]::Transparent)

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(36, 36, 36), 2.2)
$ocx = 16; $oHeadCy = 12; $oHeadR = 8
# Head circle
$og.DrawEllipse($pen, ($ocx - $oHeadR), ($oHeadCy - $oHeadR), ($oHeadR * 2), ($oHeadR * 2))
# Two lines down to the tip
$og.DrawLine($pen, ($ocx - 6), ($oHeadCy + 5), $ocx, 29)
$og.DrawLine($pen, ($ocx + 6), ($oHeadCy + 5), $ocx, 29)
# Inner dot
$dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 36, 36))
$og.FillEllipse($dotBrush, ($ocx - 3), ($oHeadCy - 3), 6, 6)

$outlinePath = Join-Path $OutputDir "outline.png"
$obmp.Save($outlinePath, [System.Drawing.Imaging.ImageFormat]::Png)
$og.Dispose(); $obmp.Dispose()
Write-Host "Wrote $outlinePath (32x32)"
