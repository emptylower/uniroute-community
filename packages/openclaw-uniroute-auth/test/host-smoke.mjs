import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.env.UNIROUTE_HOST_TEST_ROOT;
const cli = process.env.UNIROUTE_OPENCLAW_CLI;
const tarball = process.env.UNIROUTE_PLUGIN_TARBALL;
if (!root || !cli || !tarball) throw new Error('Set UNIROUTE_HOST_TEST_ROOT, UNIROUTE_OPENCLAW_CLI and UNIROUTE_PLUGIN_TARBALL to isolated paths.');
const state = join(root, 'state');
const home = join(root, 'home');
await mkdir(state, { recursive: true });
await mkdir(home, { recursive: true });
const secret = 'test-cli-not-real-credential';
const requests = [];
let fail = false;
const server = createServer((req, res) => {
  const matches = req.headers.authorization === `Bearer ${secret}`;
  requests.push({ path: req.url, authMatches: matches });
  if (fail || !matches) { res.writeHead(403); res.end('private upstream body'); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: ['claude-unit', 'gpt-unit', 'deepseek-unit', 'gemini-unit'].map(id => ({ id })) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = {
  ...process.env, HOME: home, OPENCLAW_STATE_DIR: state,
  OPENCLAW_AGENT_DIR: join(state, 'agents/main/agent'),
  OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'), UNIROUTE_API_KEY: secret,
};
async function run(args, { expectedCode = 0, key = false } = {}) {
  const child = spawn(process.execPath, [cli, ...args], { env: { ...env, UNIROUTE_API_KEY: key ? secret : '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await writeFile(join(root, `${args.slice(0, 2).join('-')}-${key ? 'key' : 'no-key'}${fail ? '-failure' : ''}.log`), stdout + stderr);
  assert.equal((stdout + stderr).includes(secret), false, 'Host command must not echo the test key');
  assert.equal(code, expectedCode, `${args.join(' ')}: ${stderr}`);
  return stdout;
}
async function loginWithPty() {
  const script = String.raw`
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], 'models', 'auth', 'login', '--provider', 'uniroute', '--method', 'api-key'], stdin=slave, stdout=slave, stderr=slave, env=os.environ.copy())
os.close(slave)
output = b''
sent = False
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try: chunk = os.read(master, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if not sent and b'Enter your UniRoute API key' in output:
            os.write(master, (os.environ['UNIROUTE_TEST_LOGIN_KEY'] + '\r').encode())
            sent = True
    if child.poll() is not None and not readable: break
if child.poll() is None:
    child.terminate()
    child.wait(timeout=5)
os.close(master)
text = output.decode('utf-8', 'replace').replace(os.environ['UNIROUTE_TEST_LOGIN_KEY'], '[TEST KEY REDACTED]')
sys.stdout.write(text)
if not sent: sys.stderr.write('API-key prompt not reached\n')
sys.exit(child.returncode if sent else 2)
`;
  const child = spawn('python3', ['-u', '-c', script, process.execPath, cli], {
    env: { ...env, UNIROUTE_API_KEY: '', UNIROUTE_TEST_LOGIN_KEY: secret, TERM: 'xterm-256color' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  await writeFile(join(root, 'models-auth-login-pty.log'), output);
  assert.equal(code, 0, output);
}
try {
  await run(['plugins', 'install', tarball, '--force', '--accept-capabilities']);
  const config = JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8'));
  config.plugins.entries['openclaw-uniroute-auth'].config = { baseUrl: `http://127.0.0.1:${server.address().port}` };
  config.agents = { defaults: { model: { primary: 'openai/gpt-5.1' } } };
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
  const info = JSON.parse(await run(['plugins', 'info', 'openclaw-uniroute-auth', '--json']));
  assert.equal(info.plugin.status, 'loaded');
  assert.deepEqual(info.diagnostics, []);
  await run(['plugins', 'doctor']);
  await run(['config', 'validate']);
  assert.equal(requests.length, 0, 'No catalog request or credential cache may precede real login');
  assert.equal(JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8')).agents.defaults.model.primary, 'openai/gpt-5.1');
  await loginWithPty();
  // Authenticated discovery must now succeed using only the profile persisted by
  // the real host login command, including the four manifest auth aliases.
  for (const [provider, model] of [
    ['uniroute-anthropic', 'claude-unit'], ['uniroute-openai-responses', 'gpt-unit'],
    ['uniroute-openai-chat', 'deepseek-unit'], ['uniroute-gemini', 'gemini-unit'],
  ]) {
    const result = JSON.parse(await run(['models', 'list', '--all', '--provider', provider, '--refresh', '--json']));
    assert.equal(result.count, 1);
    assert.equal(result.models[0].key, `${provider}/${model}`);
    assert.equal(result.models[0].available, true);
  }
  assert.equal(requests.length >= 5, true);
  assert.equal(requests.every(request => request.authMatches), true);
  const savedConfig = await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8');
  assert.equal(savedConfig.includes(secret), false);
  assert.equal(JSON.parse(savedConfig).agents.defaults.model.primary, 'openai/gpt-5.1');
  const ownerDb = new DatabaseSync(join(state, 'state/openclaw.sqlite'), { readOnly: true });
  const ownerRow = ownerDb.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get('authProfiles.store');
  ownerDb.close();
  const storedProfiles = JSON.parse(ownerRow.value_json).profiles;
  assert.deepEqual(Object.keys(storedProfiles), ['uniroute:default']);
  assert.equal(storedProfiles['uniroute:default'].provider, 'uniroute');
  assert.equal(storedProfiles['uniroute:default'].type, 'api_key');
  assert.equal(storedProfiles['uniroute:default'].key === secret || Boolean(storedProfiles['uniroute:default'].keyRef), true);
  fail = true;
  await run(['models', 'list', '--all', '--provider', 'uniroute-openai-responses', '--refresh', '--json']);
  // The host may preserve its last valid catalog on refresh failure. The plugin
  // must report the error in host diagnostics; its callback itself throws.
  const failureLog = await readFile(join(root, 'models-list-no-key-failure.log'), 'utf8');
  assert.match(failureLog, /403|catalog.*fail|discovery.*fail/i);
  assert.equal(failureLog.includes('private upstream body'), false);
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ hostVersion: '2026.9.8', nodeVersion: process.version, installedAndLoaded: true, configValid: true, doctorPassed: true, nativeProviders: 4, realPtyLogin: true, profileOnlyDiscovery: true, authAliasesResolved: true, persistedProfileIds: [{ id: 'uniroute:default', provider: 'uniroute', type: 'api_key', owner: 'state-db' }], credentialAbsentFromConfig: true, strictAuthorizationRequests: requests, defaultPreserved: true, failedDiscoveryReported: true }, null, 2));
  process.stdout.write('Host smoke passed: install/load/doctor, real PTY login and profile-only 4-protocol catalogs, failure diagnostics and default preservation.\n');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
