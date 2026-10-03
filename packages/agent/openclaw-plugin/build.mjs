// Bundle the plugin with the installed esbuild. typebox resolves from the installed OpenClaw's node_modules and is
// bundled in; openclaw/* stays external so the host supplies its own SDK at load time.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const openclawModules = resolve(repoRoot, '.tools', 'npm-global', 'lib', 'node_modules', 'openclaw', 'node_modules');
if (!existsSync(openclawModules)) throw new Error('installed OpenClaw not found at ' + openclawModules);

await build({
  entryPoints: [resolve(here, 'src', 'index.ts')],
  outfile: resolve(here, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['openclaw', 'openclaw/*'],
  nodePaths: [openclawModules, resolve(repoRoot, 'node_modules')],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: { js: '// Beetle OpenClaw tool plugin (bundled). Source: packages/agent/openclaw-plugin/src/index.ts' },
});
