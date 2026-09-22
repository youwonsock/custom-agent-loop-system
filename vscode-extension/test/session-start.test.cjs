const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
 if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }, window: { showErrorMessage: () => {} } };
 return load.call(this, name, ...args);
};
const { LoopClient } = require('../out/loopClient.js');
Module._load = load;

test('startup rejects spawn and preflight failures instead of acknowledging a session', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-start-failure-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const store = { readState: async () => null };
 const missing = new LoopClient({ nodeBinary: path.join(root, 'missing-node') }, store);
 await assert.rejects(missing.spawnSession([], root, 'missing', process.env, true), /ENOENT/);
 assert.equal(missing.isRunning('missing'), false);
 const client = new LoopClient({ nodeBinary: process.execPath }, store);
 await assert.rejects(client.spawnSession(['-e', "console.error('Invalid pipeline configuration'); process.exit(1)"], root, 'invalid', process.env, true), /Invalid pipeline configuration/);
 assert.equal(client.isRunning('invalid'), false);
});

test('startup waits for persisted state and retains logs emitted before panel subscription', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-start-ready-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const readyPath = path.join(root, 'ready.json');
 const store = { readState: async () => { try { return JSON.parse(await fs.readFile(readyPath, 'utf8')); } catch { return null; } } };
 const client = new LoopClient({ nodeBinary: process.execPath }, store);
 const script = `console.log('Preparing the session'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, '{"sessionId":"ready"}'), 150);`;
 assert.equal(await client.spawnSession(['-e', script], root, 'ready', process.env, true), 'ready');
 assert.equal((await store.readState()).sessionId, 'ready');
 assert.match(client.getSessionLog('ready'), /Preparing the session/);
 assert.equal(client.getSessionLog('another-session'), '');
});
