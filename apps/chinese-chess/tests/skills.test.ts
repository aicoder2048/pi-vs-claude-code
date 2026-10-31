import { describe, expect, test } from 'bun:test';
import { mkdtempSync, cpSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import { assertSkills, DEFAULT_SKILLS_DIR, EXPECTED_SKILLS, SkillCatalog } from '../src/agent/skill-loader';
import { analyzeExpert } from '../src/business/expert';
import { replay } from '../src/business/engine';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';

describe('Pi-native bundled skills', () => {
  test('Pi validates exact names, portable directories and invocation descriptions', () => {
    const { skills, diagnostics } = loadSkillsFromDir({ dir: DEFAULT_SKILLS_DIR, source: 'app' });
    expect(diagnostics).toEqual([]); expect(skills.map(s => s.name).sort()).toEqual([...EXPECTED_SKILLS].sort());
    for (const skill of skills) {
      expect(path.basename(skill.baseDir)).toBe(skill.name);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).toMatch(/时|回合/);
      expect(skill.disableModelInvocation).toBe(skill.name.startsWith('playbook-'));
    }
    const catalog = new SkillCatalog();
    expect(catalog.index).toContain('<available_skills>');
    expect(catalog.index).not.toContain(DEFAULT_SKILLS_DIR);
    expect(catalog.index).not.toContain('Use the read tool');
    expect(catalog.index).not.toContain('playbook-');
    const prompt = catalog.systemPrompt('identity', 'playbook-in-check');
    expect(prompt).toContain('# 被将军');
    expect(prompt).not.toContain('# 开局');
    expect(prompt).not.toContain('# 残局');
    expect(catalog.index.length).toBeLessThan(4200);
    expect(catalog.read('xiangqi-coach')).not.toContain('metadata:');
    expect(catalog.read('read-expert-report', 'principles.md')).toContain('cannon-screen');
  });
  test('workflow reuses current evidence and batches candidates without forcing a shorter thought budget', () => {
    const catalog = new SkillCatalog(), coach = catalog.read('xiangqi-coach');
    expect(coach).toContain('不必例行重复 analyze_position');
    expect(coach).toContain('一次 compare_moves');
    expect(coach).toContain('不复用其他 revision');
    expect(coach).toContain('不跳过 update_plan 与最终独立复查');
    expect(coach).toContain('不是催促或思考时限');
    expect(catalog.read('compare-candidates')).toContain('覆盖不足、位置变化或出现新风险时仍应补算');
  });
  test('triggered principle IDs have human-readable full references, with concise signal advice', () => {
    const text = new SkillCatalog().read('read-expert-report', 'principles.md');
    for (const ply of [0, 20, 30, 41, HUMAN_MISTAKES.length]) {
      for (const principle of analyzeExpert(replay(HUMAN_MISTAKES.slice(0, ply)), { maxMs: 0 }).expert!.principles) {
        expect(text).toContain(`## ${principle.id}\n`); expect(principle.advice.length).toBeLessThan(32);
      }
    }
  });
  test('noSkills + explicit paths ignores user, project and settings-injected skills', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chess-skill-isolation-'));
    try {
      for (const root of ['agent/skills/foreign', '.pi/skills/foreign', '.agents/skills/foreign', 'injected/foreign']) {
        mkdirSync(path.join(dir, root), { recursive: true });
        writeFileSync(path.join(dir, root, 'SKILL.md'), '---\nname: foreign\ndescription: forbidden\n---\nDo not load.');
      }
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'agent'),
        settingsManager: SettingsManager.inMemory({ skills: [path.join(dir, 'injected')] }),
        noSkills: true, additionalSkillPaths: [DEFAULT_SKILLS_DIR],
        noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      const result = loader.getSkills(); assertSkills(result.skills, result.diagnostics);
      expect(result.skills.map(s => s.filePath).sort()).toEqual(new SkillCatalog().skills.map(s => s.filePath).sort());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('TUI-only review is discoverable and physically absent from application allowlist', () => {
    const result = loadSkillsFromDir({ dir: path.join(DEFAULT_SKILLS_DIR, '../.pi/skills'), source: 'project' });
    expect(result.diagnostics).toEqual([]); expect(result.skills.map(s => s.name)).toEqual(['xiangqi-review']);
    expect(new SkillCatalog().skills.some(s => s.name === 'xiangqi-review')).toBe(false);
  });
  test('rejects unknown names, traversal, absolute paths, missing files and symlink escapes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chess-skill-paths-'));
    try {
      cpSync(DEFAULT_SKILLS_DIR, path.join(dir, 'skills'), { recursive: true });
      const catalog = new SkillCatalog(path.join(dir, 'skills'));
      for (const ref of ['../SKILL.md', '/etc/passwd', '..', 'references/fields.md', 'fields.md/..', '']) {
        expect(() => catalog.read('read-expert-report', ref)).toThrow();
      }
      expect(() => catalog.read('foreign')).toThrow();
      expect(() => catalog.read('read-expert-report', 'missing.md')).toThrow();
      const outside = path.join(dir, 'secret.md'); writeFileSync(outside, 'secret');
      symlinkSync(outside, path.join(dir, 'skills/skills/read-expert-report/references/escape.md'));
      expect(() => catalog.read('read-expert-report', 'escape.md')).toThrow('越界');
      rmSync(path.join(dir, 'skills/xiangqi-coach'), { recursive: true });
      expect(() => new SkillCatalog(path.join(dir, 'skills'))).toThrow('校验失败');
      expect(() => new SkillCatalog(path.join(dir, 'missing'))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
