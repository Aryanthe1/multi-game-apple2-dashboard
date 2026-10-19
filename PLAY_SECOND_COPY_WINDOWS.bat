@echo off
rem A second G3 on this same PC with its own name/settings, for trying multiplayer alone.
rem Host in one copy (Wi-Fi/LAN > HOST), then in the other: JOIN and type 127.0.0.1
call "%~dp0PLAY_WINDOWS.bat" --data "%USERPROFILE%\.g3_player2" --port 8734
