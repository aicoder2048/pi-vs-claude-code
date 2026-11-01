import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');
const entries = [
  { entrypoint: 'src/main.ts', outfile: 'main.cjs', target: 'node', format: 'cjs' },
  { entrypoint: 'src/preload.ts', outfile: 'preload.cjs', target: 'node', format: 'cjs' },
  { entrypoint: 'renderer/renderer.ts', outfile: 'renderer.js', target: 'browser', format: 'esm' },
] satisfies Array<{
  entrypoint: string;
  outfile: string;
  target: 'node' | 'browser';
  format: 'cjs' | 'esm';
}>;
const missing: string[] = [];
for (const { entrypoint } of entries) {
  if (!(await Bun.file(join(root, entrypoint)).exists())) missing.push(entrypoint);
}
if (!(await Bun.file(join(root, 'renderer/index.html')).exists())) missing.push('renderer/index.html');

await rm(dist, { recursive: true, force: true });
if (missing.length > 0) {
  if (missing.length !== entries.length + 1 || Bun.argv.includes('--require-app')) {
    throw new Error(`App is not runnable. Missing source files: ${missing.join(', ')}`);
  }
  process.stdout.write('Scaffold only. No application sources to build; Electron is not runnable yet.\n');
} else {
  await mkdir(dist, { recursive: true });
  for (const { entrypoint, outfile, target, format } of entries) {
    const result = await Bun.build({
      entrypoints: [join(root, entrypoint)],
      outdir: dist,
      naming: outfile,
      target,
      format,
      external: ['electron'],
      sourcemap: 'linked',
    });
    if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  }
  for await (const file of new Bun.Glob('**/*.{html,css}').scan(join(root, 'renderer'))) {
    const destination = join(dist, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, 'renderer', file), destination);
  }
  process.stdout.write('Built Electron main, preload, renderer, HTML and CSS in dist/.\n');
}
