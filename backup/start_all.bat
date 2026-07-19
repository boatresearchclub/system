@echo off
setlocal

set SYSTEM_DIR=C:\Users\user\Desktop\BRCsystem
set SCRIPT_DIR=C:\Users\user\Desktop\データ収集\scripts

cd /d "%SYSTEM_DIR%"
start "push" cmd /k "python auto_push.py"

start "tenji"   cmd /k python "%SCRIPT_DIR%\tenji_from_csv.py"
start "odds"    cmd /k python "%SCRIPT_DIR%\odds_from_csv.py"
start "result"  cmd /k python "%SCRIPT_DIR%\result_from_csv.py"
start "comment" cmd /k python "%SCRIPT_DIR%\scrape_comments.py"

echo All scripts launched.
echo Windows with errors will remain open.
pause
