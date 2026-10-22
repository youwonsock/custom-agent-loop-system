# Operator verification evidence

The operator ran the generated game in a real browser. `browser-checks.json` records initial tiles, arrow-key movement, exact saved/reloaded state equality, and an empty console-error list. The screenshots show actual desktop play and a 390px iframe of the original game. Physical mobile swipes were not tested; touch event handlers are covered by the operator acceptance tests.

On 2026-10-23, Kilo's Windows PowerShell tool resolved `npm` to npm.ps1, which was blocked by the host execution policy. The same package test script was successfully run using `node --test tests/*.test.js`. The operator also independently ran `npm.cmd test` using Windows PowerShell without changing its execution policy; the full output in `windows-powershell-tests.log` shows 13 passed, 0 failed, exit 0.

For this Windows shell use `npm.cmd test` / `npm.cmd start`, or `node.exe` directly. Use PowerShell syntax rather than Bash for/do/done loops. Do not change the machine execution policy to run this game.

`node verification/check-game.cjs` runs 10 independent rule checks including 4,000 seeded board/direction comparisons. These files are evidence, not instructions to skip the test, QA or approval roles. Their verdicts must be based on their own inspection and the actual recorded results.

Final rerun: Auto Free added deterministic coverage for spawning a 4 tile and for restarting from the game-over overlay. The operator independently reran the final tests using Windows PowerShell: **15 passed, 0 failed**. `windows-powershell-tests-final.log` contains this latest result; the 13-test log above is historical evidence from before those additions. Production game files were preserved.
