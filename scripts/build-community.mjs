import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const communityRoot = existsSync(join(projectRoot, 'community', 'packages'))
  ? join(projectRoot, 'community')
  : projectRoot;
const outputRoot = join(projectRoot, 'public', 'community');
const source = 'https://github.com/emptylower/uniroute-community';
const packages = ['uniroute-setup', 'openclaw-uniroute-auth'];

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

const scratch = await mkdtemp(join(tmpdir(), 'uniroute-community-build-'));
try {
  const metadata = await Promise.all(
    packages.map(async (name) => {
      const packageRoot = join(communityRoot, 'packages', name);
      const manifest = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8')
      );
      if (manifest.name !== name || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
        throw new Error(`Invalid package name or release version for ${name}.`);
      }
      return { name, packageRoot, version: manifest.version };
    })
  );
  const version = metadata[0].version;
  const marketplace = JSON.parse(
    await readFile(
      join(communityRoot, '.claude-plugin', 'marketplace.json'),
      'utf8'
    )
  );
  const pluginManifest = JSON.parse(
    await readFile(
      join(
        communityRoot,
        'plugins',
        'uniroute-setup',
        '.claude-plugin',
        'plugin.json'
      ),
      'utf8'
    )
  );
  if (
    metadata.some((item) => item.version !== version) ||
    pluginManifest.version !== version ||
    marketplace.plugins.find((item) => item.name === 'uniroute-setup')
      ?.version !== version
  ) {
    throw new Error(
      'CLI, OpenClaw plugin and marketplace versions must match.'
    );
  }

  const canonicalSkill = join(
    projectRoot,
    '.claude',
    'skills',
    'uniroute-setup'
  );
  const skillText = await readFile(join(canonicalSkill, 'SKILL.md'), 'utf8');
  if (
    !skillText.startsWith('---\n') ||
    !skillText.includes('name: uniroute-setup\n')
  ) {
    throw new Error('Canonical UniRoute Skill is missing its frontmatter.');
  }
  const generatedSkill = join(
    communityRoot,
    'plugins',
    'uniroute-setup',
    'skills',
    'uniroute-setup'
  );
  await rm(generatedSkill, { recursive: true, force: true });
  await cp(canonicalSkill, generatedSkill, {
    recursive: true,
    dereference: true,
  });

  const openclawRoot = metadata.find(
    (item) => item.name === 'openclaw-uniroute-auth'
  ).packageRoot;
  await rm(join(openclawRoot, 'dist'), { recursive: true, force: true });
  run(process.execPath, ['scripts/build.mjs'], openclawRoot);
  for (const name of ['index.js', 'provider.js']) {
    await readFile(join(openclawRoot, 'dist', name));
  }

  const artifacts = [];
  for (const item of metadata) {
    const packed = JSON.parse(
      run(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          scratch,
          '--cache',
          join(scratch, 'npm-cache'),
        ],
        item.packageRoot
      )
    );
    if (
      packed.length !== 1 ||
      packed[0].name !== item.name ||
      packed[0].version !== version
    ) {
      throw new Error(`Unexpected npm pack result for ${item.name}.`);
    }
    if (
      packed[0].files.some((file) =>
        file.path
          .split('/')
          .some(
            (part) =>
              ['node_modules', 'test', 'tests', 'research', '.git'].includes(
                part
              ) ||
              part === '.env' ||
              part.startsWith('.env.')
          )
      )
    ) {
      throw new Error(
        `The ${item.name} archive contains an excluded development or private file.`
      );
    }
    const filename = `${item.name}-${version}.tgz`;
    if (basename(packed[0].filename) !== filename)
      throw new Error('Unexpected archive filename.');
    artifacts.push({ name: item.name, filename });
  }

  const zipRoot = join(scratch, 'skill');
  await mkdir(zipRoot);
  await cp(canonicalSkill, join(zipRoot, 'uniroute-setup'), {
    recursive: true,
    dereference: true,
  });
  const skillZip = `uniroute-setup-skill-${version}.zip`;
  run('zip', ['-q', '-r', join(scratch, skillZip), 'uniroute-setup'], zipRoot);
  artifacts.push({ name: 'uniroute-setup-skill', filename: skillZip });

  for (const artifact of artifacts) {
    const contents = await readFile(join(scratch, artifact.filename));
    artifact.sha256 = createHash('sha256').update(contents).digest('hex');
    artifact.bytes = contents.length;
    artifact.url = `https://all-model-router.app/community/${artifact.filename}`;
  }
  await mkdir(outputRoot, { recursive: true });
  for (const artifact of artifacts) {
    await cp(
      join(scratch, artifact.filename),
      join(outputRoot, artifact.filename)
    );
  }
  const manifest = { version, source, artifacts };
  await writeFile(
    join(scratch, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    join(scratch, 'SHA256SUMS'),
    `${artifacts.map((item) => `${item.sha256}  ${item.filename}`).join('\n')}\n`
  );
  for (const filename of ['manifest.json', 'SHA256SUMS']) {
    const pending = join(outputRoot, `.${filename}.tmp`);
    await cp(join(scratch, filename), pending);
    await rename(pending, join(outputRoot, filename));
  }
  console.log(
    `Built UniRoute community ${version}: ${artifacts.map((item) => item.filename).join(', ')}`
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
