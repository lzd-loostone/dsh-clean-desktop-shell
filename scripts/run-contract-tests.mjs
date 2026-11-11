#!/usr/bin/env node
// Runs the pinned delegation contract suite against the DSH runtime installed on this machine.
//
// The suite already resolves its own prerequisites (src/host/delegation-contract-fixture.js
// `applyContractEnvironment`), so this wrapper only exports the same confined environment to
// this process and to the `node --test` child, prints the resolved paths, and forwards any
// extra arguments. Prefer `npm run test:contract`; a bare `node --test
// src/host/delegation-contract.test.js` behaves identically.
//
// Overrides (all optional, all absolute):
//   DSH_CONTRACT_RUNTIME_ROOT          installed @deepseek-ai/dsh (default: `npm root -g`)
//   DSH_CONTRACT_SCRATCH_ROOT          scratch root (default: <repo>/.dsh-tmp/contract)
//   DSH_CONTRACT_CLIENT_SOURCE_ROOT    harness checkout (default: ../deepseek-harness)
//   DSH_CONTRACT_CLIENT_DEPS           client dependency anchor package.json
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyContractEnvironment } from '../src/host/delegation-contract-fixture.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let environment;
try {
  environment = applyContractEnvironment(process.env);
} catch (error) {
  console.error(`run-contract-tests: ${error.message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const testArgs = args.length === 0 ? ['src/host/delegation-contract.test.js'] : args;
console.log(`run-contract-tests: runtime=${environment.runtimeRoot}`);
console.log(`run-contract-tests: scratch=${environment.scratchRoot}`);
console.log(`run-contract-tests: node --test ${testArgs.join(' ')}`);

const child = spawn(process.execPath, ['--test', ...testArgs], { cwd: repoRoot, env: process.env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
