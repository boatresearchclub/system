@echo off
if /I "%~1"=="RELAUNCHED" goto :main

start "BRCsystem cleanup" cmd /k call "%~f0" RELAUNCHED %~1
exit /b

:main
setlocal EnableDelayedExpansion
shift

rem ============================================================
rem  BRCsystem Safe Archive Script
rem  - Moves only unreferenced backup/diff files into archive
rem  - Does NOT touch core files that auto_push.py / index.html use
rem  - Default is DRY RUN (nothing is moved, list only)
rem  - Usage:
rem      cleanup_archive.bat        -> dry run (preview only)
rem      cleanup_archive.bat RUN    -> actually move files
rem  This window stays open (cmd /k) even if an error happens,
rem  so you can always read what went wrong.
rem ============================================================

set "SYSTEM_DIR=%~dp0"
if "%SYSTEM_DIR:~-1%"=="\" set "SYSTEM_DIR=%SYSTEM_DIR:~0,-1%"
set "ARCHIVE_DIR=%SYSTEM_DIR%\archive\2026-07_cleanup"
set "BACKUP_ZIP=%SYSTEM_DIR%\archive\BRCsystem_backup_before_cleanup.zip"
set "MODE=%~1"

echo ============================================================
echo  Target folder : %SYSTEM_DIR%
echo  Archive folder: %ARCHIVE_DIR%
echo  Mode          : %MODE%
echo ============================================================
echo.

if /I "%MODE%"=="RUN" goto :do_run

echo [DRY RUN] Nothing will be moved. Files that WOULD be archived:
echo.
call :list_only "bak.prob_scenario_engine.py"
call :list_only "bak.tenjihoseiplus (2).py"
call :list_only "bak.tenjihoseiplus.py"
call :list_only "bak.auto_push (2).py"
call :list_only "bak.auto_push.py"
call :list_only "bak.analyzer (2).js"
call :list_only "bak.analyzer.js"
call :list_only "bak.renderer (2).js"
call :list_only "bak.renderer.js"
call :list_only "bak.loader.js"
call :list_only "bak.boatrace_analyzer (2).html"
call :list_only "bak.boatrace_analyzer.html"
call :list_only "bak.index.html"
call :list_only "bak.sample.js"
call :list_only "bak.sample_obf.js"
call :list_only "bak2.sample.js"
call :list_only "bak3.sample.js"
call :list_only "diff_backtest.txt"
call :list_only "diff_calibration.txt"
call :list_only "diff_computeScenCombosWithEV.txt"
call :list_only "diff_computeScenCombosWithEV_v2.txt"
call :list_only "pipeline_prototype.py"
echo.
echo To actually move these files, close this window and run:
echo   cleanup_archive.bat RUN
echo.
echo (This window will stay open. You can close it now.)
goto :eof

:list_only
set "F=%~1"
if exist "%SYSTEM_DIR%\!F!" (
    echo   [FOUND]   !F!
) else (
    echo   [absent]  !F!  (already gone, will be skipped)
)
exit /b 0

:do_run
echo [1/3] Creating full zip backup for safety...
if not exist "%SYSTEM_DIR%\archive" mkdir "%SYSTEM_DIR%\archive"
powershell -NoProfile -Command "Compress-Archive -Path '%SYSTEM_DIR%\*' -DestinationPath '%BACKUP_ZIP%' -Force -CompressionLevel Optimal"
if errorlevel 1 (
    echo   Backup failed. Stopping for safety, nothing was moved.
    goto :eof
)
echo   OK: %BACKUP_ZIP%
echo.

echo [2/3] Creating archive folder...
if not exist "%ARCHIVE_DIR%" mkdir "%ARCHIVE_DIR%"
echo   OK: %ARCHIVE_DIR%
echo.

echo [3/3] Moving files...
call :move_one "bak.prob_scenario_engine.py"
call :move_one "bak.tenjihoseiplus (2).py"
call :move_one "bak.tenjihoseiplus.py"
call :move_one "bak.auto_push (2).py"
call :move_one "bak.auto_push.py"
call :move_one "bak.analyzer (2).js"
call :move_one "bak.analyzer.js"
call :move_one "bak.renderer (2).js"
call :move_one "bak.renderer.js"
call :move_one "bak.loader.js"
call :move_one "bak.boatrace_analyzer (2).html"
call :move_one "bak.boatrace_analyzer.html"
call :move_one "bak.index.html"
call :move_one "bak.sample.js"
call :move_one "bak.sample_obf.js"
call :move_one "bak2.sample.js"
call :move_one "bak3.sample.js"
call :move_one "diff_backtest.txt"
call :move_one "diff_calibration.txt"
call :move_one "diff_computeScenCombosWithEV.txt"
call :move_one "diff_computeScenCombosWithEV_v2.txt"
call :move_one "pipeline_prototype.py"

echo.
echo ============================================================
echo  Done.
echo  Core files used by auto_push.py / index.html were not touched.
echo  Wait a few days to confirm production still works fine,
echo  then you can delete the archive folder entirely.
echo  If anything breaks, restore from: %BACKUP_ZIP%
echo ============================================================
goto :eof

:move_one
set "F=%~1"
if exist "%SYSTEM_DIR%\!F!" (
    move "%SYSTEM_DIR%\!F!" "%ARCHIVE_DIR%\!F!" >nul
    echo   moved: !F!
)
exit /b 0
