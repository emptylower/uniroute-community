import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSON5 from 'json5';
import { parse, modify, applyEdits, parseTree } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parseDocument } from 'yaml';

export function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export async function assertSafePath(home, file) {
  const root = path.resolve(home);
  const target = path.resolve(file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Config path must stay inside the selected home.');
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('Cannot inspect the selected config path.');
    }
    if (stat.isSymbolicLink()) throw new Error('Refusing a symlink in the selected config path. Use a physical isolated home.');
    if (current !== target && !stat.isDirectory()) throw new Error('Config parent is not a directory.');
    if (current === target && target !== root && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Config target must be a regular file without hard links.');
    if (target === root && current === target && !stat.isDirectory()) throw new Error('Selected home must be a directory.');
  }
}

export async function readConfig(home, relative, format) {
  const file = path.resolve(home, relative);
  await assertSafePath(home, file);
  let source = null;
  try { source = await fs.readFile(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${relative}.`);
  }
  const text = source ?? (format === 'toml' || format === 'yaml' || format === 'env' ? '' : '{}\n');
  let value, document, syntax = format;
  try {
    if (format === 'toml') value = parseToml(text);
    else if (format === 'yaml') {
      document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length) throw new Error();
      value = document.toJS({ maxAliasCount: 100 }) ?? {};
    } else if (format === 'env') value = parseEnv(text);
    else {
      const errors = [];
      value = parse(text, errors, { allowTrailingComma: format !== 'json', disallowComments: format === 'json' });
      if (errors.length) {
        if (format !== 'json5') throw new Error();
        value = JSON5.parse(text);
      } else {
        syntax = 'jsonc';
        rejectDuplicateKeys(parseTree(text));
      }
    }
    if (!isObject(value)) throw new Error();
  } catch { throw new Error(`Invalid ${format.toUpperCase()} config in ${relative}; original file was not changed.`); }
  return { file, relative, source, text, value, document, syntax, format };
}

function rejectDuplicateKeys(node) {
  if (!node) return;
  if (node.type === 'object') {
    const keys = node.children.map(property => property.children[0].value);
    if (new Set(keys).size !== keys.length) throw new Error();
  }
  for (const child of node.children ?? []) rejectDuplicateKeys(child);
}

function parseEnv(text) {
  const value = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error();
    const raw = match[2];
    if (raw.startsWith('"')) {
      const quoted = raw.match(/^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/);
      if (!quoted) throw new Error();
      value[match[1]] = JSON.parse(raw.match(/^"(?:[^"\\]|\\.)*"/)[0]);
    } else if (raw.startsWith("'")) {
      const quoted = raw.match(/^'([^']*)'\s*(?:#.*)?$/);
      if (!quoted) throw new Error();
      value[match[1]] = quoted[1];
    } else value[match[1]] = raw.replace(/\s+#.*$/, '').trim();
  }
  return value;
}

export function patchConfig(config, changes) {
  let text = config.text;
  for (const [keys, value] of changes) {
    let object = config.value;
    for (const key of keys.slice(0, -1)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe config field.');
      if (!Object.hasOwn(object, key) || object[key] === undefined) object[key] = {};
      if (!isObject(object[key])) throw new Error(`Config field ${keys.slice(0, -1).join('.')} must be an object in ${config.relative}.`);
      object = object[key];
    }
    const last = keys.at(-1);
    if (['__proto__', 'constructor', 'prototype'].includes(last)) throw new Error('Unsafe config field.');
    if (value === undefined) delete object[last];
    else object[last] = value;
    if (config.syntax === 'jsonc') {
      text = applyEdits(text, modify(text, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    } else if (config.format === 'yaml') {
      if (value === undefined) config.document.deleteIn(keys);
      else config.document.setIn(keys, value);
    }
  }
  if (config.syntax === 'jsonc') return { ...config, output: text };
  if (config.format === 'toml') text = stringifyToml(config.value);
  else if (config.format === 'yaml') text = config.document.toString();
  else if (config.format === 'env') {
    const replacements = new Map(changes.map(([keys, value]) => [keys[0], value]));
    const emitted = new Set();
    const lines = config.text.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match || !replacements.has(match[1])) return [line];
      if (emitted.has(match[1])) return [];
      emitted.add(match[1]);
      return replacements.get(match[1]) === undefined ? [] : [`${match[1]}=${JSON.stringify(replacements.get(match[1]))}`];
    });
    while (lines.at(-1) === '') lines.pop();
    for (const [key, value] of replacements) if (!emitted.has(key) && value !== undefined) lines.push(`${key}=${JSON.stringify(value)}`);
    text = lines.join('\n') + '\n';
  } else text = JSON.stringify(config.value, null, 2) + '\n';
  return { ...config, output: text };
}

export async function writeConfigs(home, configs, { dryRun = false } = {}) {
  const changed = [];
  for (const config of configs) {
    await assertSafePath(home, config.file);
    let current = null;
    try { current = await fs.readFile(config.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== config.source) throw new Error('Config changed during setup; retry after other writers finish.');
    const insecure = process.platform !== 'win32' && current !== null && ((await fs.stat(config.file)).mode & 0o777) !== 0o600;
    if (current !== config.output || insecure) changed.push(config);
  }
  if (dryRun) return changed.map(config => ({ file: config.relative, action: 'would update' }));
  const staged = [];
  const committed = [];
  try {
    for (const config of changed) {
      await assertSafePath(home, config.file);
      await fs.mkdir(path.dirname(config.file), { recursive: true, mode: 0o700 });
      const temporary = `${config.file}.uniroute-${randomUUID()}.tmp`;
      const backup = config.source === null ? null : `${config.file}.uniroute-${randomUUID()}.bak`;
      staged.push({ ...config, temporary, backup });
      if (backup) await fs.writeFile(backup, config.source, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(temporary, config.output, { flag: 'wx', mode: 0o600 });
    }
    for (const config of staged) {
      await assertSafePath(home, config.file);
      let current = null;
      try { current = await fs.readFile(config.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== config.source) throw new Error('Config changed during setup; refusing to overwrite it.');
      await fs.rename(config.temporary, config.file);
      committed.push(config);
    }
  } catch (error) {
    for (const config of committed.reverse()) {
      if (config.backup) await fs.rename(config.backup, config.file);
      else await fs.unlink(config.file);
    }
    throw error;
  } finally {
    for (const config of staged) await fs.rm(config.temporary, { force: true });
  }
  return staged.map(config => ({ file: config.relative, action: 'updated', ...(config.backup ? { backup: path.basename(config.backup) } : {}) }));
}

export async function readProtectedKey(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error('API key file must be a private regular file (chmod 600), without links.');
  }
  return (await fs.readFile(file, 'utf8')).trim();
}
