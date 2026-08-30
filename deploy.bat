@echo off
cd /d "%~dp0"
set WRANGLER_SEND_METRICS=false

echo ============================================
echo   Drug Inventory - Deploy to Cloudflare Pages
echo ============================================
echo.
echo If the browser does not open automatically,
echo copy the https://dash.cloudflare.com/... link
echo shown above into your browser, log in and
echo click "Authorize", then return to this window.
echo.

call node_modules\.bin\wrangler.cmd pages deploy . --project-name drug-inventory

echo.
echo ============================================
echo Done. If you see "Success!" and a
echo https://...pages.dev address, send it to your
echo assistant. Press any key to close...
pause >nul
