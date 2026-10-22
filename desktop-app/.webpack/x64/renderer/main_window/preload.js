/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "electron"
/*!***************************!*\
  !*** external "electron" ***!
  \***************************/
(module) {

module.exports = require("electron");

/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/************************************************************************/
let __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
let exports = __webpack_exports__;
/*!************************!*\
  !*** ./src/preload.ts ***!
  \************************/

Object.defineProperty(exports, "__esModule", ({ value: true }));
const electron_1 = __webpack_require__(/*! electron */ "electron");
function invoke(channel, payload) {
    return electron_1.ipcRenderer.invoke(channel, payload);
}
const bridge = {
    getStartupStatus: () => invoke("desktop:getStartupStatus"),
    openProfileFolder: (kind) => invoke("desktop:openProfileFolder", { kind }),
    getSnapshot: (sessionId) => invoke("desktop:getSnapshot", { sessionId }),
    getSessionBundle: (sessionId) => invoke("desktop:getSessionBundle", { sessionId }),
    getSettings: () => invoke("desktop:getSettings"),
    chooseProjectDirectory: () => invoke("desktop:chooseProjectDirectory"),
    chooseProviderBinary: () => invoke("desktop:chooseProviderBinary"),
    startSession: (input) => invoke("desktop:startSession", input),
    resumeSession: (sessionId) => invoke("desktop:resumeSession", { sessionId }),
    stopSession: (sessionId) => invoke("desktop:stopSession", { sessionId }),
    interruptSession: (sessionId, message) => invoke("desktop:interruptSession", { sessionId, message }),
    deleteSession: (sessionId) => invoke("desktop:deleteSession", { sessionId }),
    resolveAccessRequest: (sessionId, approved) => invoke("desktop:resolveAccessRequest", { sessionId, approved }),
    setAccessMode: (sessionId, mode) => invoke("desktop:setAccessMode", { sessionId, mode }),
    selectPlanChoice: (sessionId, choiceId) => invoke("desktop:selectPlanChoice", { sessionId, choiceId }),
    approvePlan: (sessionId, choiceId) => invoke("desktop:approvePlan", { sessionId, choiceId }),
    revisePlan: (sessionId, message) => invoke("desktop:revisePlan", { sessionId, message }),
    approveVerification: (sessionId, requestId, candidateHash) => invoke("desktop:approveVerification", { sessionId, requestId, candidateHash }),
    rejectVerification: (sessionId, requestId, candidateHash, message) => invoke("desktop:rejectVerification", { sessionId, requestId, candidateHash, message }),
    saveSettings: (settings, secrets) => invoke("desktop:saveSettings", { settings, secrets }),
    discoverModels: () => invoke("desktop:discoverModels"),
    revealSessionFolder: (sessionId) => invoke("desktop:revealSessionFolder", { sessionId }),
    requestQuit: () => invoke("desktop:requestQuit"),
    openExternal: (url) => invoke("desktop:openExternal", { url }),
    onStateInvalidated: (listener) => {
        const callback = (_event, snapshot) => listener(snapshot);
        electron_1.ipcRenderer.on("desktop:state-invalidated", callback);
        return () => electron_1.ipcRenderer.removeListener("desktop:state-invalidated", callback);
    },
    onLog: (listener) => {
        const callback = (_event, value) => listener(value);
        electron_1.ipcRenderer.on("desktop:log", callback);
        return () => electron_1.ipcRenderer.removeListener("desktop:log", callback);
    },
    onNotification: (listener) => {
        const callback = (_event, value) => listener(value);
        electron_1.ipcRenderer.on("desktop:notification", callback);
        return () => electron_1.ipcRenderer.removeListener("desktop:notification", callback);
    },
};
electron_1.contextBridge.exposeInMainWorld("desktopBridge", bridge);

})();

/******/ })()
;
//# sourceMappingURL=preload.js.map