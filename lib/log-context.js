'use strict';
// AsyncLocalStorage-basiertes Logging-Context-Layer.
// Middleware/Job-Wrapper rufen `runWithContext({ ... }, fn)` auf; alle
// `logger.*`-Calls innerhalb (auch in async/await-Ketten) erben den Ctx
// automatisch. Das Winston-Format liest den Store via `getContext()`.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

function getContext() {
  return als.getStore() || {};
}

module.exports = { als, runWithContext, getContext };
