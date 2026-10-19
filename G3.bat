@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title G3
set "PY="
for %%C in ("py -3" "python") do call :try %%~C
if not defined PY goto no_python
%PY% -c "import serial" >nul 2>nul || echo (Optional: LoRa radio play needs "pip install pyserial". Everything else works without it.)
echo Starting G3... its window will open. Close that window to quit.
%PY% -m g3 %*
if errorlevel 1 goto crashed
exit /b 0

:try
if defined PY exit /b 0
%* -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=%*"
exit /b 0

:crashed
echo.
echo  G3 stopped with an error (see above).
pause
exit /b 1

:no_python
echo.
echo  Python 3.8 or newer was not found.
echo  Install it from https://www.python.org/downloads/
echo  and TICK "Add python.exe to PATH" during setup, then run this again.
echo.
pause
exit /b 1
