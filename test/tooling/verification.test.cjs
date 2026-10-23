const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runChecks } = require('../../scripts/run-verification');
for (const exitCode of [0, 7]) test(`verification records exit ${exitCode} and preserves subsequent check status`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const steps = [
    { name: 'first', command: [process.execPath, '-e', `console.log('stdout evidence'); console.error('stderr evidence'); process.exitCode = ${exitCode};`] },
    { name: 'second', command: [process.execPath, '-e', 'console.log("next check");'] },
    { name: 'platform-only', command: [process.execPath, '-e', 'process.exit(99)'], skip: 'Other platform' },
  ];
  assert.equal(await runChecks({ suite: 'fixture', steps, cwd: root, outputDirectory: root, metadata: { commit: 'fixture-sha' } }), exitCode);
  const report = JSON.parse(await fs.readFile(path.join(root, 'summary.json')));
  assert.equal(report.commit, 'fixture-sha');
  assert.equal(report.exitCode, exitCode);
  assert.equal(report.checks[0].status, exitCode ? 'failed' : 'passed');
  assert.equal(report.checks[1].status, exitCode ? 'not_run' : 'passed');
  assert.equal(report.checks[2].status, 'not_run');
  assert.ok(report.startedAt && report.endedAt && report.checks[0].endedAt);
  const log = await fs.readFile(path.join(root, report.checks[0].log), 'utf8');
  assert.match(log, /stdout evidence/); assert.match(log, /stderr evidence/);
});
test('spawn failures leave a failed summary instead of a successful or missing report', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-spawn-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await runChecks({ suite: 'fixture', steps: [{ name: 'missing', command: [path.join(root, 'missing')] }], cwd: root, outputDirectory: root }), 1);
  const report = JSON.parse(await fs.readFile(path.join(root, 'summary.json')));
  assert.equal(report.checks[0].status, 'failed');
  assert.match(report.checks[0].reason, /ENOENT/);
});
