#!/usr/bin/env node
import { CLI_HELP, loadClientConnection, runCodeck, formatClientResult } from '../src/codeck-client.js';
const args = process.argv.slice(2);
try {
  if (!args.length || args.includes('--help')) console.log(CLI_HELP);
  else {
    const result = await runCodeck(args, await loadClientConnection());
    console.log(args.includes('--json') ? JSON.stringify(result) : formatClientResult(result));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
