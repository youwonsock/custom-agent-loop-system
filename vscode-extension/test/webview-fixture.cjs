const roles = require('../../agent_roles.json').roles;
const graph = require('../../agent_loop.json');
exports.fixture = (id = 'session-A', status = 'RUNNING') => {
  const pipeline = structuredClone({ ...graph, roles });
  const provider = { id: 'codex', label: 'Codex', adapter: 'codex', binary: 'codex', enabled: true, available: true, models: ['model-A', 'model-B'], modelVariants: { 'model-A': ['low', 'high'], 'model-B': ['low', 'high'] } };
  return {
    registry: { sessionMetas: id ? [{ sessionId: 'session-A', status }, { sessionId: 'session-B', status: 'RUNNING' }] : [], availableModels: provider.models, providerCatalog: { codex: provider } },
    selectedSessionId: id,
    state: id ? { sessionId: id, status, phase: 'IMPLEMENTATION', loopCount: 1, completedIterations: 0, maxIterations: 20, stageExecutions: 3, stageExecutionLimit: 240, updatedAt: '2026-01-01', goal: 'Implement a search filter.', targetProjectPath: '/project', cliProfile: 'codex', accessMode: 'ask', pipeline, modelMapping: Object.fromEntries(roles.map(r => [r.id, 'model-A'])), providerMapping: Object.fromEntries(roles.map(r => [r.id, 'codex'])), variantMapping: {}, errorQueue: [], requirements: { items: [], evidence: [] }, resilience: { maxAgentAttempts: 3 } } : null,
    progressNotes: 'Plan approved. Implementation is running.', history: [], finalSummary: null, isRunning: !!id && status === 'RUNNING', defaultTargetPath: '/project', cliProfile: 'codex', modelVariants: {}, variantDefaults: {}, variantMapping: {}, runtimeLeaseStatus: 'active', cliProfiles: {},
    systemSettings: { providers: { codex: { ...provider, modelsArgs: [], fallbackModels: provider.models } }, toolAccess: { webSearch: { enabled: false, mode: 'cached' }, mcpServers: [] }, pipeline },
  };
};
