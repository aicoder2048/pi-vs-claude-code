import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
for (const [entrypoint, outfile, target, format] of [
  ['src/electron/main.ts', 'dist/electron/main.js', 'node', 'esm'],
  ['src/learning/worker.ts', 'dist/electron/learning-worker.js', 'node', 'esm'],
  ['src/learning/search-worker.ts', 'dist/electron/search-worker.js', 'node', 'esm'],
  ['src/electron/preload.ts', 'dist/electron/preload.cjs', 'node', 'cjs'],
  ['src/renderer/app.ts', 'dist/renderer/app.js', 'browser', 'esm'],
] as const) {
  const result = await Bun.build({ entrypoints: [entrypoint], outdir: '.', naming: outfile, target, format,
    packages: target === 'node' ? 'external' : 'bundle', sourcemap: 'linked' });
  if (!result.success) throw new Error(result.logs.map(log => String(log)).join('\n'));
}
for (const file of ['index.html', 'styles.css', 'expert.css']) await cp(`src/renderer/${file}`, `dist/renderer/${file}`);
await cp('src/renderer/assets', 'dist/renderer/assets', { recursive: true });
await cp('skills', 'dist/skills', { recursive: true });
await cp('src/data/ccpd', 'dist/data/ccpd', { recursive: true });
await cp('KNOWLEDGE-SOURCES.md', 'dist/KNOWLEDGE-SOURCES.md');
console.log('Built Electron main, isolated preload and renderer → dist/');
