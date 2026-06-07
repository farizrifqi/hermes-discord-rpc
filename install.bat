@echo off
echo ============================================
echo   Hermes Discord RPC Companion - Installer
echo ============================================
echo.

REM Check for Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/ (LTS recommended)
    pause
    exit /b 1
)

echo [1/4] Node.js detected:
node --version

REM Install dependencies
echo.
echo [2/4] Installing npm dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed. Check the error above.
    pause
    exit /b 1
)
echo Dependencies installed successfully.

REM Create .env if it doesn't exist
echo.
echo [3/4] Checking .env file...
if not exist ".env" (
    copy .env.example .env
    echo Created .env from .env.example
    echo.
    echo ╔══════════════════════════════════════════════════════════╗
    echo ║  IMPORTANT: Edit .env and set your DISCORD_CLIENT_ID!   ║
    echo ║                                                          ║
    echo ║  1. Go to https://discord.com/developers/applications    ║
    echo ║  2. Create a New Application                             ║
    echo ║  3. Copy the Application ID                              ║
    echo ║  4. Paste it in .env as DISCORD_CLIENT_ID=your_id_here   ║
    echo ╚══════════════════════════════════════════════════════════╝
) else (
    echo .env already exists, skipping.
)

REM Test run
echo.
echo [4/4] Running dry-run test...
call node src/index.js --dry-run
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] Dry-run test had issues. Check the output above.
) else (
    echo Dry-run test passed!
)

echo.
echo ============================================
echo   Installation complete!
echo.
echo   To start:   npm start
echo   To test:    npm test
echo   To edit:    notepad .env
echo ============================================
echo.
pause
