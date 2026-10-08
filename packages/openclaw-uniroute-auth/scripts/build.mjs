import { pathToFileURL } from 'node:url';
const { build } = process.env.UNIROUTE_ESBUILD_MODULE
  ? await import(pathToFileURL(process.env.UNIROUTE_ESBUILD_MODULE).href)
  : await import('esbuild');
await build({
  entryPoints: ['src/index.js', 'src/provider.js'], outdir: 'dist', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['openclaw/*'],
  legalComments: 'eof',
});
