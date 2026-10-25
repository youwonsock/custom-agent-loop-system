import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { inspectionSegments, stripInspectionStderr, normalizeInspectionCommand } from './inspection_syntax';

test('inspection syntax preserves quoted operators and stderr text while separating only actual control operators',()=>{
 const parts=inspectionSegments(`grep -E 'pass|fail' report.txt 2>&1; ls 'name;literal' 2>/dev/null || echo 'not found' && pwd`)!;
 assert.equal(parts.length,4);assert.equal(parts[0]!.next,';');assert.equal(parts[1]!.next,'||');assert.equal(parts[2]!.next,'&&');
 assert.equal(stripInspectionStderr(parts[0]!.text),`grep -E 'pass|fail' report.txt `);
 assert.equal(stripInspectionStderr(`echo 'literal 2>/dev/null'`),`echo 'literal 2>/dev/null'`);
 for(const bad of ['ls . & touch source','ls "unfinished','ls .\ncat source','ls . ||'])assert.equal(inspectionSegments(bad),null,bad);
});
test('validated absolute inspection paths become relative without changing globs, arbitrary programs or changed cwd semantics',()=>{
 if(process.platform==='win32')return;
 const cwd=path.resolve('owned target'),absolute=path.join(cwd,'verification/report.json');
 assert.equal(normalizeInspectionCommand(`cat '${absolute}' 2>&1 | tail -5`,cwd),'cat verification/report.json 2>&1 | tail -5');
 assert.equal(normalizeInspectionCommand(`mkdir -p '${cwd}/verification' && npm test > verification/log.txt 2>&1`,cwd),'mkdir -p verification && npm test > verification/log.txt 2>&1');
 for(const original of [`ls '${cwd}/*.mjs'`,`node -e "console.log('${absolute}')"`,`cd child && cat '${absolute}'`,`cat '${path.dirname(cwd)}/outside.txt'`])assert.equal(normalizeInspectionCommand(original,cwd),original);
});
