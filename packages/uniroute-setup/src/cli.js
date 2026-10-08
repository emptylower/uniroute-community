#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { fetchCatalog, selectModel, DEFAULT_BASE_URL, validateApiKey } from './catalog.js';
import { configureClient, doctor, CLIENTS } from './configure.js';
import { readProtectedKey } from './files.js';

const usage = `UniRoute setup (Node.js 22+)

uniroute-setup models [--json]
uniroute-setup configure <claude|codex|gemini|opencode|openclaw|hermes> --model <catalog-id>
uniroute-setup doctor [client]

Options: --home <directory> --base-url <https-root> --key-file <private-file>
         --protocol <anthropic|openai-responses|openai-chat|gemini>
         --timeout-ms <milliseconds> --dry-run --json --help

Supply the key via UNIROUTE_API_KEY, a chmod 600 key file, or the masked TTY prompt.
No API-key command-line argument is supported. --dry-run makes no local changes.
doctor checks local configuration only; it does not prove an inference request works.
`;

export function parseArgs(args) {
  const options = { positional: [] };
  const values = new Map([['--home', 'home'], ['--base-url', 'baseUrl'], ['--key-file', 'keyFile'], ['--model', 'model'], ['--protocol', 'protocol'], ['--timeout-ms', 'timeoutMs']]);
  const flags = new Map([['--dry-run', 'dryRun'], ['--json', 'json'], ['--help', 'help'], ['-h', 'help']]);
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (values.has(argument)) {
      const key = values.get(argument);
      if (options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing or duplicate option value. Run --help.');
      options[key] = args[++i];
    } else if (flags.has(argument)) options[flags.get(argument)] = true;
    else if (argument.startsWith('-')) throw new Error('Unknown option. Run --help; API keys must never be supplied in arguments.');
    else options.positional.push(argument);
  }
  if (options.timeoutMs !== undefined) {
    options.timeoutMs = Number(options.timeoutMs);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) throw new Error('--timeout-ms must be between 1 and 120000.');
  }
  return options;
}

async function maskedKeyPrompt(input, output) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('Set UNIROUTE_API_KEY or --key-file in noninteractive environments.');
  output.write('UniRoute API key (hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    function finish(error) {
      input.off('data', onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    }
    function onData(chunk) {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u0003' || character === '\u0004') { finish(new Error('Setup cancelled.')); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    }
    input.on('data', onData);
  });
}

async function pickModel(catalog, input, output, client) {
  if (!input.isTTY || !output.isTTY) throw new Error('--model is required in noninteractive environments. Run models for available IDs.');
  const required = { claude: 'anthropic', codex: 'openai-responses', gemini: 'gemini' }[client];
  const choices = catalog.filter(model => !required || model.protocol === required);
  if (!choices.length) throw new Error('Your authenticated catalog has no models compatible with this client.');
  choices.forEach((model, index) => output.write(`${index + 1}. ${model.id} (${model.protocol || 'explicit protocol required'})\n`));
  const reader = createInterface({ input, output });
  try {
    const answer = await reader.question('Choose model number: ');
    const index = Number(answer) - 1;
    if (!Number.isSafeInteger(index) || !choices[index]) throw new Error('Invalid model choice.');
    return choices[index].id;
  } finally { reader.close(); }
}

export async function run(args, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const options = parseArgs(args);
  if (options.help || !options.positional.length) { output.write(usage); return; }
  const [command, client, ...extra] = options.positional;
  if (extra.length || !['models', 'configure', 'doctor'].includes(command) || (command === 'models' && client) || (command === 'configure' && !CLIENTS.includes(client)) || (command === 'doctor' && client && !CLIENTS.includes(client))) {
    throw new Error('Invalid command or client. Run --help.');
  }
  const home = path.resolve(options.home || os.homedir());
  if (command === 'doctor') {
    const results = await doctor({ home, client });
    if (options.json) output.write(JSON.stringify(results, null, 2) + '\n');
    else for (const result of results) output.write(`${result.client}: ${result.status}${result.reason ? ` (${result.reason})` : ''}\n`);
    if (results.some(result => ['needs configuration', 'invalid config'].includes(result.status))) return 1;
    return;
  }
  let apiKey;
  if (options.keyFile) {
    try { apiKey = await readProtectedKey(path.resolve(options.keyFile)); } catch { throw new Error('Cannot read a protected API key file. Use a regular chmod 600 file without links.'); }
  } else apiKey = env.UNIROUTE_API_KEY || await maskedKeyPrompt(input, output);
  validateApiKey(apiKey);
  try {
    const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    const catalog = await fetchCatalog({ baseUrl, apiKey, timeoutMs: options.timeoutMs });
    if (command === 'models') {
      if (options.json) output.write(JSON.stringify(catalog, null, 2) + '\n');
      else for (const model of catalog) output.write(`${model.id}\t${model.protocol || 'unknown; use --protocol'}\n`);
      return;
    }
    const id = options.model || await pickModel(catalog, input, output, client);
    const model = selectModel(catalog, id, options.protocol);
    const changes = await configureClient({ home, client, model, apiKey, baseUrl, dryRun: options.dryRun });
    if (options.json) output.write(JSON.stringify({ client, model: model.id, protocol: model.protocol, dryRun: Boolean(options.dryRun), changes }, null, 2) + '\n');
    else {
      output.write(`${options.dryRun ? 'Dry run' : 'Configured'} ${client}: ${model.id} (${model.protocol})\n`);
      for (const change of changes) output.write(`${change.action}: ${change.file}${change.backup ? ` (backup: ${change.backup})` : ''}\n`);
      if (!changes.length) output.write('Configuration already up to date.\n');
    }
  } catch (error) {
    // Never include credentials even if a downstream exception accidentally embeds them.
    throw new Error(String(error.message).split(apiKey).join('[REDACTED]'));
  }
}

// npm/npx invoke the bin through a symlink; ESM resolves import.meta.url to the
// physical file, including macOS /var -> /private/var aliases.
let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]); } catch { /* imported from a launcher without a filesystem entry */ }
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  run(process.argv.slice(2)).then(code => { if (code) process.exitCode = code; }).catch(error => {
    process.stderr.write(`UniRoute setup: ${error.message}\n`);
    process.exitCode = 1;
  });
}
