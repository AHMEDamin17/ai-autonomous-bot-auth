# =============================================================================
# generate_project_dump.ps1
# Generates backend_complete.txt and frontend_complete.txt in the ANONYMOUS_AI
# root folder.  Only functional source files are included - no tests, no build
# artefacts, no generated / cache files, no sensitive secrets.
# =============================================================================

$Root        = $PSScriptRoot                                          # ANONYMOUS_AI/
$BackendRoot = Join-Path $Root "backend"
$FrontendRoot= Join-Path $Root "frontend"
$OutBackend  = Join-Path $Root "backend_complete.txt"
$OutFrontend = Join-Path $Root "frontend_complete.txt"

$Divider = "=" * 80

# ---------------------------------------------------------------------------
# Helper: write one file's content into the output stream
# ---------------------------------------------------------------------------
function Append-File {
    param(
        [string]$FilePath,
        [string]$RelativePath,
        [System.IO.StreamWriter]$Writer
    )
    $Writer.WriteLine($Divider)
    $Writer.WriteLine("FILE: $RelativePath")
    $Writer.WriteLine($Divider)
    try {
        $content = Get-Content -LiteralPath $FilePath -Raw -Encoding UTF8 -ErrorAction Stop
        if ($null -eq $content) { $content = "" }
        $Writer.WriteLine($content)
    } catch {
        $Writer.WriteLine("[ERROR reading file: $_]")
    }
    $Writer.WriteLine("")
}

# ---------------------------------------------------------------------------
# Directories / filename patterns to ALWAYS skip (backend + frontend)
# ---------------------------------------------------------------------------
$SkipDirs = @(
    "node_modules", "dist", ".git", ".cache", "build", ".vite",
    "test", "tests", "__tests__", "__mocks__", "coverage",
    "e2e", "playwright-report", "test-results", "blob-report", ".playwright",
    ".vscode", ".idea"
)

# Files to skip (exact name or glob-style — we use -like)
$SkipFilePatterns = @(
    "*.map",                    # source maps
    "*.lock",                   # lock files
    "package-lock.json",
    ".telemetry_cache.json",
    "*.log",
    "*.DS_Store",
    "*.gitkeep",
    "*.test.*",                 # test files
    "*.spec.*",                 # spec files
    "playwright.config.*",
    "test-query.*",
    "test-catalog.*",
    ".eslintrc.*",             # linting config is not functional source
    "*.eslintrc.*"
)

# Root-level files in backend/frontend to INCLUDE (empty because only functional code is requested)
$BackendRootIncludes = @()
$FrontendRootIncludes = @()

# ---------------------------------------------------------------------------
# Should we skip this directory?
# ---------------------------------------------------------------------------
function Should-SkipDir([string]$DirName) {
    foreach ($skip in $SkipDirs) {
        if ($DirName -ieq $skip) { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Should we skip this file?
# ---------------------------------------------------------------------------
function Should-SkipFile([string]$FileName) {
    foreach ($pattern in $SkipFilePatterns) {
        if ($FileName -ilike $pattern) { return $true }
    }
    # Skip hidden files
    if ($FileName.StartsWith(".") -and $FileName -ne ".env.example") { return $true }
    return $false
}

# ---------------------------------------------------------------------------
# Collect files from a source tree, respecting skip rules
# ---------------------------------------------------------------------------
function Collect-SourceFiles {
    param(
        [string]$BaseDir,
        [string[]]$Extensions        # e.g. @("*.ts","*.tsx","*.js","*.jsx","*.css","*.sql","*.json","*.html")
    )

    $result = @()

    Get-ChildItem -LiteralPath $BaseDir -Recurse -File | ForEach-Object {
        $file = $_

        # --- skip by directory segment ---
        $relativeParts = $file.FullName.Substring($BaseDir.Length).TrimStart('\','/') -split '[\\/]'
        $skipThis = $false
        if ($relativeParts.Count -gt 1) {
            foreach ($part in $relativeParts[0..($relativeParts.Count - 2)]) {
                if (Should-SkipDir $part) { $skipThis = $true; break }
            }
        }
        if ($skipThis) { return }

        # --- skip by filename ---
        if (Should-SkipFile $file.Name) { return }

        # --- only keep files with matching extension ---
        $matched = $false
        foreach ($ext in $Extensions) {
            if ($file.Name -ilike $ext) { $matched = $true; break }
        }
        if (-not $matched) { return }

        $result += $file
    }

    return $result | Sort-Object FullName
}

# ===========================================================================
# BACKEND
# ===========================================================================
Write-Host "Building backend_complete.txt ..." -ForegroundColor Cyan

$backendExtensions = @("*.ts", "*.js", "*.sql")

$writer = [System.IO.StreamWriter]::new($OutBackend, $false, [System.Text.Encoding]::UTF8)
try {
    $writer.WriteLine("ANONYMOUS_AI - BACKEND COMPLETE SOURCE DUMP")
    $writer.WriteLine("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $writer.WriteLine($Divider)
    $writer.WriteLine("")

    # 1. Root-level config files
    foreach ($fname in $BackendRootIncludes) {
        $fp = Join-Path $BackendRoot $fname
        if (Test-Path $fp) {
            Append-File -FilePath $fp -RelativePath "backend\$fname" -Writer $writer
        }
    }

    # 2. migrations/ (SQL only) & scripts/
    $migrationsDir = Join-Path $BackendRoot "migrations"
    if (Test-Path $migrationsDir) {
        Get-ChildItem -LiteralPath $migrationsDir -File -Filter "*.sql" | Sort-Object Name | ForEach-Object {
            Append-File -FilePath $_.FullName -RelativePath "backend\migrations\$($_.Name)" -Writer $writer
        }
    }
    $scriptsDir = Join-Path $BackendRoot "scripts"
    if (Test-Path $scriptsDir) {
        $scriptFiles = Collect-SourceFiles -BaseDir $scriptsDir -Extensions $backendExtensions
        foreach ($file in $scriptFiles) {
            $rel = "backend\scripts\" + $file.FullName.Substring($scriptsDir.Length).TrimStart('\')
            Append-File -FilePath $file.FullName -RelativePath $rel -Writer $writer
        }
    }

    # 3. src/ tree
    $srcDir = Join-Path $BackendRoot "src"
    $backendFiles = Collect-SourceFiles -BaseDir $srcDir -Extensions $backendExtensions
    foreach ($file in $backendFiles) {
        $rel = "backend\src\" + $file.FullName.Substring($srcDir.Length).TrimStart('\')
        Append-File -FilePath $file.FullName -RelativePath $rel -Writer $writer
    }

    $writer.Flush()
} finally {
    $writer.Close()
}

$backendCount = ($backendFiles | Measure-Object).Count
Write-Host "  -> backend_complete.txt written ($backendCount source files from src/ + migrations)" -ForegroundColor Green

# ===========================================================================
# FRONTEND
# ===========================================================================
Write-Host "Building frontend_complete.txt ..." -ForegroundColor Cyan

$frontendExtensions = @("*.jsx", "*.tsx", "*.js", "*.ts", "*.css", "*.html")

$writer = [System.IO.StreamWriter]::new($OutFrontend, $false, [System.Text.Encoding]::UTF8)
try {
    $writer.WriteLine("ANONYMOUS_AI - FRONTEND COMPLETE SOURCE DUMP")
    $writer.WriteLine("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $writer.WriteLine($Divider)
    $writer.WriteLine("")

    # 1. Root-level config files
    foreach ($fname in $FrontendRootIncludes) {
        $fp = Join-Path $FrontendRoot $fname
        if (Test-Path $fp) {
            Append-File -FilePath $fp -RelativePath "frontend\$fname" -Writer $writer
        }
    }

    # 2. src/ tree
    $srcDir = Join-Path $FrontendRoot "src"
    $frontendFiles = Collect-SourceFiles -BaseDir $srcDir -Extensions $frontendExtensions
    foreach ($file in $frontendFiles) {
        $rel = "frontend\src\" + $file.FullName.Substring($srcDir.Length).TrimStart('\')
        Append-File -FilePath $file.FullName -RelativePath $rel -Writer $writer
    }

    $writer.Flush()
} finally {
    $writer.Close()
}

$frontendCount = ($frontendFiles | Measure-Object).Count
Write-Host "  -> frontend_complete.txt written ($frontendCount source files from src/ + configs)" -ForegroundColor Green

# ===========================================================================
# Summary
# ===========================================================================
Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "  backend_complete.txt  -> $OutBackend"
Write-Host "  frontend_complete.txt -> $OutFrontend"
