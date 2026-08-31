[CmdletBinding()]
param(
	[switch] $CheckOnly,
	[switch] $NoOpen,
	[switch] $Demo
)

$ErrorActionPreference = "Stop"

$repositoryRoot = $PSScriptRoot
$piWebDirectory = Join-Path $repositoryRoot "apps\pi-web"
$baseUrl = "http://127.0.0.1:30141"
$minimumNodeVersion = [Version]"22.19.0"

function Test-LocalPortOpen {
	$client = [System.Net.Sockets.TcpClient]::new()
	try {
		$connection = $client.BeginConnect("127.0.0.1", 30141, $null, $null)
		if (-not $connection.AsyncWaitHandle.WaitOne(500)) {
			return $false
		}
		$client.EndConnect($connection)
		return $true
	} catch {
		return $false
	} finally {
		$client.Dispose()
	}
}

function Test-HealthyHarness {
	try {
		$response = Invoke-WebRequest -Uri "$baseUrl/api/harness/status" -UseBasicParsing -TimeoutSec 10
		if ($response.StatusCode -ne 200) {
			return $false
		}
		return ($response.Content | ConvertFrom-Json).ready -eq $true
	} catch {
		return $false
	}
}

function Get-ExistingDemoSeed {
	param([string] $dataDirectory)
	$demoOutput = & $nodeCommand.Source --experimental-strip-types (Join-Path $repositoryRoot "scripts\seed-learning-harness-demo.mjs") --lookup-only --data-dir $dataDirectory
	if ($LASTEXITCODE -ne 0) {
		throw "The running Learning Harness cannot safely use Demo because no compatible seeded demo was found. Stop the current server and run start-learning-harness.ps1 -Demo again."
	}
	$demoLookupResult = ($demoOutput | Select-Object -Last 1 | ConvertFrom-Json)
	if (-not $demoLookupResult.sessionId -or -not $demoLookupResult.courseVersionId) {
		throw "The running Learning Harness cannot safely use Demo because its seeded demo result is incomplete. Stop the current server and run start-learning-harness.ps1 -Demo again."
	}
	return $demoLookupResult
}

function Assert-RunningDemoSession {
	param([string] $sessionId, [string] $courseVersionId)
	try {
		$response = Invoke-WebRequest -Uri "$baseUrl/api/harness/status?sessionId=$([uri]::EscapeDataString($sessionId))" -UseBasicParsing -TimeoutSec 10
		$status = $response.Content | ConvertFrom-Json
		if (
			$response.StatusCode -ne 200 -or
			$status.ready -ne $true -or
			-not $status.session -or
			$status.session.sessionId -ne $sessionId -or
			$status.session.courseVersionId -ne $courseVersionId
		) {
			throw "The running Learning Harness does not recognize the seeded demo session."
		}
	} catch {
		throw "The running Learning Harness cannot safely use Demo because it does not recognize the seeded demo session. Stop the current server and run start-learning-harness.ps1 -Demo again."
	}
}

function Resolve-PdfToTextPath {
	if ($env:PI_PDFTOTEXT_PATH) {
		if (-not (Test-Path -LiteralPath $env:PI_PDFTOTEXT_PATH -PathType Leaf)) {
			throw "PI_PDFTOTEXT_PATH does not point to a file: $env:PI_PDFTOTEXT_PATH"
		}
		return (Resolve-Path -LiteralPath $env:PI_PDFTOTEXT_PATH).Path
	}

	$pathCommand = Get-Command pdftotext -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($pathCommand -and (Test-Path -LiteralPath $pathCommand.Source -PathType Leaf)) {
		return (Resolve-Path -LiteralPath $pathCommand.Source).Path
	}

	$fallbackPath = "C:\texlive\2020\bin\win32\pdftotext.exe"
	if (Test-Path -LiteralPath $fallbackPath -PathType Leaf) {
		return $fallbackPath
	}

	throw "pdftotext.exe was not found. Set PI_PDFTOTEXT_PATH, add pdftotext to PATH, or install it at $fallbackPath."
}

if (-not (Test-Path -LiteralPath $piWebDirectory -PathType Container)) {
	throw "Pi Web directory was not found: $piWebDirectory"
}

$healthyHarnessAlreadyRunning = $false
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeVersionText = (& $nodeCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0) {
	throw "node --version failed with exit code $LASTEXITCODE"
}
$nodeVersion = [Version]($nodeVersionText.TrimStart("v").Split("-")[0])
if ($nodeVersion -lt $minimumNodeVersion) {
	throw "Node.js $minimumNodeVersion or newer is required; found $nodeVersionText."
}

if (Test-LocalPortOpen) {
	if (Test-HealthyHarness) {
		Write-Host "A healthy Learning Harness is already running at $baseUrl."
		$healthyHarnessAlreadyRunning = $true
		if ($Demo) {
			$existingHarnessDataDirectory = if ($env:PI_LEARNING_HARNESS_DIR) {
				$env:PI_LEARNING_HARNESS_DIR
			} else {
				Join-Path $repositoryRoot ".learning-harness-data"
			}
			$demoLookupResult = Get-ExistingDemoSeed $existingHarnessDataDirectory
			Assert-RunningDemoSession $demoLookupResult.sessionId $demoLookupResult.courseVersionId
			$launchUrl = "$baseUrl/?session=$($demoLookupResult.sessionId)"
			Write-Host "Demo course: $($demoLookupResult.courseVersionId)"
			Write-Host "Demo session: $($demoLookupResult.sessionId)"
			if ($CheckOnly) {
				Write-Host "Learning Harness startup checks passed."
				return
			}
			Write-Host "Reusing the healthy Learning Harness at $baseUrl."
			if (-not $NoOpen) {
				Start-Process $launchUrl
			}
			return
		}
		if (-not $Demo -and -not $CheckOnly) {
			if (-not $NoOpen) {
				Start-Process $baseUrl
			}
			return
		}
	} else {
		throw "Port 30141 is already occupied by a service that is not a healthy Learning Harness. Stop that service before starting Pi Web."
	}
}

$npmCommand = Get-Command npm -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nextEntry = Join-Path $piWebDirectory "node_modules\next\dist\bin\next"
if (-not (Test-Path -LiteralPath $nextEntry -PathType Leaf)) {
	Write-Host "Pi Web dependencies are missing; running npm ci --ignore-scripts..."
	Push-Location $piWebDirectory
	try {
		& $npmCommand.Source ci --ignore-scripts
		if ($LASTEXITCODE -ne 0) {
			throw "npm ci --ignore-scripts failed with exit code $LASTEXITCODE"
		}
	} finally {
		Pop-Location
	}
}

$pdfToTextPath = Resolve-PdfToTextPath
$requestedHarnessDataDirectory = if ($env:PI_LEARNING_HARNESS_DIR) {
	$env:PI_LEARNING_HARNESS_DIR
} else {
	Join-Path $repositoryRoot ".learning-harness-data"
}
New-Item -ItemType Directory -Force -Path $requestedHarnessDataDirectory | Out-Null
$harnessDataDirectory = (Resolve-Path -LiteralPath $requestedHarnessDataDirectory).Path
$env:PI_LEARNING_HARNESS_DIR = $harnessDataDirectory
$requestedPiAgentDirectory = if ($env:PI_CODING_AGENT_DIR) {
	$env:PI_CODING_AGENT_DIR
} else {
	Join-Path $harnessDataDirectory "pi-agent"
}
New-Item -ItemType Directory -Force -Path $requestedPiAgentDirectory | Out-Null
$env:PI_CODING_AGENT_DIR = (Resolve-Path -LiteralPath $requestedPiAgentDirectory).Path
$env:PI_PDFTOTEXT_PATH = $pdfToTextPath
Write-Host "Node.js: $nodeVersionText"
Write-Host "PDF extractor: $pdfToTextPath"
Write-Host "Harness data directory: $harnessDataDirectory"
Write-Host "Pi agent directory: $env:PI_CODING_AGENT_DIR"

$launchUrl = $baseUrl
if ($Demo) {
	$demoOutput = & $nodeCommand.Source --experimental-strip-types (Join-Path $repositoryRoot "scripts\seed-learning-harness-demo.mjs") --data-dir $harnessDataDirectory
	if ($LASTEXITCODE -ne 0) {
		throw "Learning Harness demo seed failed with exit code $LASTEXITCODE"
	}
	$demoSeedResult = ($demoOutput | Select-Object -Last 1 | ConvertFrom-Json)
	if (-not $demoSeedResult.sessionId) {
		throw "Learning Harness demo seed did not return a Pi session ID"
	}
	$launchUrl = "$baseUrl/?session=$($demoSeedResult.sessionId)"
	Write-Host "Demo course: $($demoSeedResult.courseVersionId)"
	Write-Host "Demo session: $($demoSeedResult.sessionId)"
}

if ($CheckOnly) {
	Write-Host "Learning Harness startup checks passed."
	return
}

if ($healthyHarnessAlreadyRunning) {
	Write-Host "Reusing the healthy Learning Harness at $baseUrl."
	if (-not $NoOpen) {
		Start-Process $launchUrl
	}
	return
}

Write-Host "Starting Pi Web at $baseUrl ..."
$browserHelper = $null
if (-not $NoOpen) {
	$browserHelper = Start-Job -ArgumentList $baseUrl, $launchUrl -ScriptBlock {
		param([string] $healthUrl, [string] $openUrl)
		while ($true) {
			try {
				$response = Invoke-WebRequest -Uri "$healthUrl/api/harness/status" -UseBasicParsing -TimeoutSec 3
				if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).ready -eq $true) {
					Start-Process $openUrl
					return
				}
			} catch {
				# The development server is not ready yet; keep waiting while npm owns it in the foreground.
			}
			Start-Sleep -Seconds 1
		}
	}
}

Push-Location $piWebDirectory
try {
	& $npmCommand.Source run dev
	if ($LASTEXITCODE -ne 0) {
		throw "Pi Web exited with code $LASTEXITCODE."
	}
} finally {
	Pop-Location
	if ($browserHelper) {
		if ($browserHelper.State -eq "Running") {
			Stop-Job -Job $browserHelper
		}
		Remove-Job -Job $browserHelper
	}
}
