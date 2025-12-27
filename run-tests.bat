@echo off
cd /d %~dp0
npx tsx src/simulation/tests.ts > test-results.txt 2>&1
