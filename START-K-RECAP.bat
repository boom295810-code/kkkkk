@echo off
rem ============================================================
rem  K RECAP - double-click to start the app and get a link.
rem  Two windows open. Keep BOTH open while people use the app.
rem  Closing either one stops the link. Ctrl+C is ignored in both on
rem  purpose: people press it to "copy" the link, and it used to kill it.
rem ============================================================
title K RECAP link - keep this window open
cd /d "%~dp0recap-v3\server"

rem 1. Server: start it in its own window unless it's already running.
netstat -ano | findstr /r /c:":5002 .*LISTENING" >nul
if errorlevel 1 (
  start "K RECAP server - keep this window open" powershell -NoProfile -Command "try { [Console]::TreatControlCAsInput = $true } catch {}; & npm.cmd start; Read-Host 'The server has stopped. Press Enter to close this window'"
) else (
  echo Server is already running.
)

rem 2. Link: start the tunnel and show only the link (also copied to the clipboard).
echo.
echo Getting your link... (about 10 seconds)
echo.
powershell -NoProfile -Command "try { [Console]::TreatControlCAsInput = $true } catch {}; & 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://localhost:5002 2>&1 | ForEach-Object { $l = [string]$_; if ($l -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $u = $Matches[0]; Set-Clipboard -Value $u; Write-Host ''; Write-Host ('   YOUR LINK:   ' + $u) -ForegroundColor Green; Write-Host '   (already copied - just paste it to your friends)' -ForegroundColor Green; Write-Host '   Keep this window open. Closing it stops the link.'; Write-Host '   No need to copy anything here - Ctrl+C does nothing in this window.'; Write-Host '' } elseif ($l -match ' ERR ') { Write-Host $l -ForegroundColor DarkYellow } }"

echo.
echo The link has stopped. Close this window and double-click START-K-RECAP again for a new link.
pause
