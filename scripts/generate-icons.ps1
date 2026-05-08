param(
  [string]$Source = "resources\icon\icon.png",
  [string]$Output = "resources\icon\app.ico"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function Write-UInt16([System.IO.BinaryWriter]$Writer, [int]$Value) {
  $Writer.Write([uint16]$Value)
}

function Write-UInt32([System.IO.BinaryWriter]$Writer, [long]$Value) {
  $Writer.Write([uint32]$Value)
}

$sourcePath = Resolve-Path $Source
$outputPath = Join-Path (Get-Location) $Output
$outputDirectory = Split-Path -Parent $outputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
try {
  $side = [Math]::Min($sourceImage.Width, $sourceImage.Height)
  $sourceX = [int](($sourceImage.Width - $side) / 2)
  $sourceY = [int](($sourceImage.Height - $side) / 2)
  $sourceRect = [System.Drawing.Rectangle]::new($sourceX, $sourceY, $side, $side)
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $entries = @()

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, [System.Drawing.Rectangle]::new(0, 0, $size, $size), $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $graphics.Dispose()
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $entries += [PSCustomObject]@{
          Size = $size
          Data = $stream.ToArray()
        }
      } finally {
        $stream.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }

  $file = [System.IO.File]::Create($outputPath)
  try {
    $writer = [System.IO.BinaryWriter]::new($file)
    try {
      Write-UInt16 $writer 0
      Write-UInt16 $writer 1
      Write-UInt16 $writer $entries.Count

      $offset = 6 + ($entries.Count * 16)
      foreach ($entry in $entries) {
        $writer.Write([byte]($(if ($entry.Size -eq 256) { 0 } else { $entry.Size })))
        $writer.Write([byte]($(if ($entry.Size -eq 256) { 0 } else { $entry.Size })))
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        Write-UInt16 $writer 1
        Write-UInt16 $writer 32
        Write-UInt32 $writer $entry.Data.Length
        Write-UInt32 $writer $offset
        $offset += $entry.Data.Length
      }

      foreach ($entry in $entries) {
        $writer.Write([byte[]]$entry.Data)
      }
    } finally {
      $writer.Dispose()
    }
  } finally {
    $file.Dispose()
  }
} finally {
  $sourceImage.Dispose()
}

$result = Get-Item $outputPath
Write-Host "Generated $($result.FullName) ($($result.Length) bytes)"
