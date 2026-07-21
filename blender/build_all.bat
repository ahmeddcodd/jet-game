@echo off
REM build_all.bat — rebuild every Blender asset (blend + glb) headlessly.
REM Usage: double-click, or run from a terminal:  blender\build_all.bat
setlocal
set BLENDER="C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
set HERE=%~dp0

echo.
echo === Building player jet ===
%BLENDER% --background --python "%HERE%build_player_jet.py"

echo.
echo === Building enemy jet ===
%BLENDER% --background --python "%HERE%build_enemy_jet.py"

echo.
echo === Building helicopter ===
%BLENDER% --background --python "%HERE%build_helicopter.py"

echo.
echo === Building props (missile, tree, rock, cloud) ===
%BLENDER% --background --python "%HERE%build_props.py"

echo.
echo === DONE. GLB files in assets\models\ ===
dir /b "%HERE%..\assets\models\*.glb"
endlocal
