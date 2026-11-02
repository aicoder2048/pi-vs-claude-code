import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('real Pi loader probe rejects fake-pi before spawning it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'option-pi-probe-guard-'));
  try {
    const log = join(directory, 'fake.jsonl');
    const child = Bun.spawn([process.execPath, 'scripts/probe-pi.ts'], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PI_CODING_AGENT_DIR: join(directory, 'agent'),
        OPTION_AGENT_PI_BIN: resolve(import.meta.dir, 'fake-pi.ts'),
        OPTION_AGENT_FAKE_LOG: log,
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('requires the real Pi CLI');
    expect(await Bun.file(log).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
