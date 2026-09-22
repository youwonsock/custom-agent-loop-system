const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { fixture } = require('./webview-fixture.cjs');
const load = Module._load;
Module._load = function(name, ...args) {
 if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), workspaceFolders: [] } };
 return load.call(this, name, ...args);
};
const { StateStore } = require('../out/stateStore.js');
Module._load = load;

test('settings persist roles and handoffs together and reject invalid graphs before writing', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-loop-settings-test-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const store = new StateStore({ rootDir: root });
 const settings = fixture().systemSettings;
 settings.pipeline.roles[1].id = 'builder';
 settings.pipeline.stages[1].role = 'builder';
 settings.pipeline.stages[1].instructions = 'Verify the edit with a focused test.';
 await store.saveSystemSettings(settings);
 const saved = await store.readSystemSettings();
 assert.deepEqual(saved.pipeline.roles, settings.pipeline.roles);
 assert.deepEqual(saved.pipeline.stages, settings.pipeline.stages);
 const rolesBefore = await fs.readFile(path.join(root, 'agent_roles.json'), 'utf8');
 const loopBefore = await fs.readFile(path.join(root, 'agent_loop.json'), 'utf8');
 saved.pipeline.stages[1].onSuccess = 'MISSING';
 await assert.rejects(store.saveSystemSettings(saved), /unknown transition/);
 assert.equal(await fs.readFile(path.join(root, 'agent_roles.json'), 'utf8'), rolesBefore);
 assert.equal(await fs.readFile(path.join(root, 'agent_loop.json'), 'utf8'), loopBefore);
});

test('host validates MCP string maps even when a message bypasses webview validation', async () => {
 const settings = fixture().systemSettings;
 settings.toolAccess.mcpServers.push({ id: 'docs', type: 'local', enabled: true, command: 'npx', environment: { TOKEN: 42 } });
 const store = new StateStore({});
 await assert.rejects(store.saveSystemSettings(settings), /environment must be a JSON object with string values/);
});
