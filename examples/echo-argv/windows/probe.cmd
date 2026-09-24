@echo off
setlocal enabledelayedexpansion
rem =====================================================================
rem  Does a bundle run on Windows, and does it know which name ran it?
rem
rem  Everything this package does on Unix rests on two facts: a `#!` prefix
rem  makes an archive executable by name, and the name it was invoked by
rem  reaches the program as argv[1]. Neither fact is documented for Windows,
rem  and neither can be tested anywhere else, so this script tests them here.
rem
rem  Run it from a normal (unelevated) cmd.exe:
rem
rem      cd examples\echo-argv\windows
rem      probe.cmd
rem
rem  It needs node 26.10+ on PATH and a built checkout (`npm run build`).
rem  It writes only to %TEMP% and to HKCU, and removes both afterwards.
rem  Nothing here needs administrator rights; the one test that would
rem  (a symbolic link) says so and skips itself.
rem
rem  Report the PASS/FAIL block at the end — that is the whole output.
rem =====================================================================

set "HERE=%~dp0"
set "EXAMPLE=%HERE%.."
set "REPO=%HERE%..\..\.."
set "WORK=%TEMP%\bundle-windows-probe"
set "CLI=%REPO%\dist\main.js"
set "PROGID=BundleProbeNzip"

where node >nul 2>&1 || (echo error: node is not on PATH & exit /b 64)
if not exist "%CLI%" (echo error: no %CLI% — run `npm run build` first & exit /b 64)

for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set "NODEVER=%%v"
for /f "tokens=*" %%p in ('node -p "process.execPath"') do set "NODEEXE=%%p"
echo node %NODEVER% at %NODEEXE%
echo.

rmdir /s /q "%WORK%" 2>nul
mkdir "%WORK%" || (echo error: cannot create %WORK% & exit /b 70)

rem ---- the two archives under test ------------------------------------
rem  app.cmd  a batch prefix in front of the archive, the Windows answer to
rem           the `#!/bin/sh` prefix. `%%~f0` is the file itself.
rem  app.nzip the archive with no prefix at all, for the file-association
rem           route where node is handed the path by the shell.
rem
rem  Both are unsigned: what is under test is how Windows *starts* them.
(echo package.json)> "%WORK%\list"
(echo index.ts)>> "%WORK%\list"

rem The batch prefix, written by node so the CRLFs and the trailing Ctrl-Z
rem (0x1A, the DOS end-of-file marker) are exactly right.
node -e "require('fs').writeFileSync(process.argv[1], ['@echo off','node --no-warnings --experimental-vfs --vfs-load=\"%%~f0\" -- %%*','exit /b %%errorlevel%%'].join('\r\n') + '\r\n\x1a')" "%WORK%\cmd-base"

node --no-warnings "%CLI%" create --base "%EXAMPLE%" --files "%WORK%\list" --prefix "%WORK%\cmd-base" --output "%WORK%\app.cmd" >nul 2>&1 || (echo error: could not build app.cmd & exit /b 70)
node --no-warnings "%CLI%" create --base "%EXAMPLE%" --files "%WORK%\list" --output "%WORK%\app.nzip" >nul 2>&1 || (echo error: could not build app.nzip & exit /b 70)

set "PASS=0"
set "FAIL=0"
set "SKIP=0"

rem =====================================================================
rem  1. Does cmd.exe run the batch prefix and stop before the ZIP?
rem =====================================================================
call :capture "%WORK%\app.cmd" one two
call :expect "1. batch prefix runs and the program sees its arguments" "args:"
call :absent "1a. cmd.exe did not read on into the archive" "is not recognized"

rem =====================================================================
rem  2..5. Does the *name* reach the program? One archive, four names.
rem =====================================================================
copy /y "%WORK%\app.cmd" "%WORK%\copied.cmd" >nul
call :capture "%WORK%\copied.cmd" x
call :expect "2. a copy reports its own name" "copied.cmd"

mklink /h "%WORK%\hardlink.cmd" "%WORK%\app.cmd" >nul 2>&1
if errorlevel 1 (
  call :skipped "3. hard link reports the link name" "mklink /h failed"
) else (
  call :capture "%WORK%\hardlink.cmd" x
  call :expect "3. hard link reports the link name" "hardlink.cmd"
)

mklink "%WORK%\symlink.cmd" "%WORK%\app.cmd" >nul 2>&1
if errorlevel 1 (
  call :skipped "4. symbolic link reports the link name" "needs Developer Mode or elevation"
) else (
  call :capture "%WORK%\symlink.cmd" x
  call :expect "4. symbolic link reports the link name" "symlink.cmd"
)

rem Found on PATH, typed without the extension — .CMD is in PATHEXT already.
set "SAVEDPATH=%PATH%"
set "PATH=%WORK%;%PATH%"
call :capture "copied" x
set "PATH=%SAVEDPATH%"
call :expect "5. found on PATH without typing .cmd" "copied.cmd"

rem =====================================================================
rem  6..8. The association route: no prefix, the shell hands node the path.
rem        Registered under HKCU, which needs no administrator.
rem =====================================================================
reg add "HKCU\Software\Classes\.nzip" /ve /d "%PROGID%" /f >nul 2>&1
reg add "HKCU\Software\Classes\%PROGID%\shell\open\command" /ve /d "\"%NODEEXE%\" --experimental-vfs --vfs-load=\"%%1\" -- %%~2" /f >nul 2>&1
if errorlevel 1 (
  call :skipped "6. .nzip association runs the archive" "could not write HKCU"
) else (
  set "SAVEDEXT=%PATHEXT%"
  set "PATHEXT=%PATHEXT%;.NZIP"
  set "PATH=%WORK%;%PATH%"

  call :capture "%WORK%\app.nzip" one two
  call :expect "6. .nzip association runs the archive" "args:"

  call :capture "app" one two
  call :expect "7. PATHEXT finds app.nzip when you type `app`" "app.nzip"

  mklink /h "%WORK%\second.nzip" "%WORK%\app.nzip" >nul 2>&1
  if errorlevel 1 (
    call :skipped "8. a second name for one .nzip reports itself" "mklink /h failed"
  ) else (
    call :capture "%WORK%\second.nzip" x
    call :expect "8. a second name for one .nzip reports itself" "second.nzip"
  )

  set "PATHEXT=%SAVEDEXT%"
  set "PATH=%SAVEDPATH%"
  reg delete "HKCU\Software\Classes\.nzip" /f >nul 2>&1
  reg delete "HKCU\Software\Classes\%PROGID%" /f >nul 2>&1
)

rem =====================================================================
rem  9. PowerShell, for completeness: the parser reads the whole file, so
rem     an archive behind a .ps1 is expected to fail. A PASS here would be
rem     the surprise.
rem =====================================================================
copy /y "%WORK%\app.nzip" "%WORK%\app.ps1" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%WORK%\app.ps1" x >"%WORK%\ps.txt" 2>&1
if errorlevel 1 (
  echo   expected  9. .ps1 with an archive appended does not run
) else (
  echo   SURPRISE  9. .ps1 with an archive appended DID run — worth reporting
)

echo.
echo ================ result ================
echo   passed:  %PASS%
echo   failed:  %FAIL%
echo   skipped: %SKIP%
echo ========================================
echo.
echo Output of each run is in %WORK%\out.txt (last run only).
echo Remove %WORK% when done: rmdir /s /q "%WORK%"
exit /b 0

rem ---------------------------------------------------------------------
rem  Run a command, keeping its output where :expect can look at it.
:capture
set "OUT=%WORK%\out.txt"
call %1 %2 %3 > "%OUT%" 2>&1
exit /b 0

rem  Did the last run print what it should have?
:expect
findstr /c:%2 "%WORK%\out.txt" >nul 2>&1
if errorlevel 1 (
  set /a FAIL+=1
  echo   FAIL      %~1
  echo             wanted: %~2
  for /f "usebackq delims=" %%l in ("%WORK%\out.txt") do echo             got:    %%l
) else (
  set /a PASS+=1
  echo   PASS      %~1
)
exit /b 0

:skipped
set /a SKIP+=1
echo   skipped   %~1  ^(%~2^)
exit /b 0

rem  The opposite: a run is only clean if this string is *not* in its output.
rem  Cmd.exe reading on into the ZIP would announce itself here.
:absent
findstr /c:%2 "%WORK%\out.txt" >nul 2>&1
if errorlevel 1 (
  set /a PASS+=1
  echo   PASS      %~1
) else (
  set /a FAIL+=1
  echo   FAIL      %~1
  echo             found: %~2
)
exit /b 0
