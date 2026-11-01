import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, formatSkillsForPrompt, loadSkillsFromDir, SettingsManager, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import { EXPECTED_SKILLS, SKILLS_DIR } from './fixtures/skills';
import { analyzeExpert } from '../src/business/expert';
import { replay } from '../src/business/engine';
import { HUMAN_MISTAKES } from './fixtures/human-mistakes';
import { ANALYSIS_TURN_REQUESTS, MAX_TURN_REQUESTS } from '../src/agent/turn-budget';

const bundle = () => loadSkillsFromDir({ dir: SKILLS_DIR, source: 'app' });

describe('Pi-native bundled skills', () => {
  test('Pi validates portable names and descriptions; all skills use its native read index', () => {
    const { skills, diagnostics } = bundle();
    expect(diagnostics).toEqual([]);
    expect(skills.map(s => s.name).sort()).toEqual([...EXPECTED_SKILLS].sort());
    for (const skill of skills) {
      expect(path.basename(skill.baseDir)).toBe(skill.name);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).toMatch(/时|回合/);
      expect(skill.disableModelInvocation).toBe(false);
    }
    const index = formatSkillsForPrompt(skills, 'read');
    expect(index).toContain('<available_skills>');
    expect(index).toContain('Use the read tool');
    expect(index).toContain(SKILLS_DIR);
    expect(index).toContain('playbook-risk-acknowledgement');
    expect(index).not.toContain('read_skill');
  });
  test('workflow uses native tools, reuses evidence and batches candidates without a shorter thought budget', () => {
    const coach = stripFrontmatter(readFileSync(path.join(SKILLS_DIR, 'xiangqi-coach/SKILL.md'), 'utf8'));
    expect(coach).toContain('不必例行重复 analyze_position');
    expect(coach).toContain('一次 compare_moves');
    expect(coach).toContain('不复用其他 revision');
    expect(coach).toContain('不跳过 update_plan 与最终独立复查');
    expect(coach).toContain('不是催促或思考时限');
    expect(coach).toContain('原生 read/bash/edit/write');
    expect(coach).toContain('不是 OS 沙箱');
    expect(coach).not.toContain('read_skill');
    expect(coach).toContain(`最多 ${MAX_TURN_REQUESTS} 次模型请求`);
    expect(coach).toContain(`前 ${ANALYSIS_TURN_REQUESTS} 次内完成`);
    const clock = readFileSync(path.join(SKILLS_DIR, 'principles/principle-clock/SKILL.md'), 'utf8');
    for (const instructions of [coach, clock]) {
      expect(instructions).toContain(`第 ${ANALYSIS_TURN_REQUESTS + 1}–${MAX_TURN_REQUESTS} 次`);
      expect(instructions).toContain('仅提供 move_piece / resign_game');
    }
    expect(clock).toContain(`${MAX_TURN_REQUESTS} 次模型请求`);
    expect(readFileSync(path.join(SKILLS_DIR, 'skills/compare-candidates/SKILL.md'), 'utf8'))
      .toContain('覆盖不足、位置变化或出现新风险时仍应补算');
  });
  test('triggered principle IDs have human-readable full references, with concise signal advice', () => {
    const text = readFileSync(path.join(SKILLS_DIR, 'skills/read-expert-report/references/principles.md'), 'utf8');
    for (const ply of [0, 20, 30, 41, HUMAN_MISTAKES.length]) {
      for (const principle of analyzeExpert(replay(HUMAN_MISTAKES.slice(0, ply)), { maxMs: 0 }).expert!.principles) {
        expect(text).toContain(`## ${principle.id}\n`); expect(principle.advice.length).toBeLessThan(32);
      }
    }
  });
  test('native noSkills + explicit paths ignores user, project and settings-injected skills', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'chess-skill-discovery-'));
    try {
      for (const root of ['agent/skills/foreign', '.pi/skills/foreign', '.agents/skills/foreign', 'injected/foreign']) {
        mkdirSync(path.join(dir, root), { recursive: true });
        writeFileSync(path.join(dir, root, 'SKILL.md'), '---\nname: foreign\ndescription: forbidden\n---\nDo not load.');
      }
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'agent'),
        settingsManager: SettingsManager.inMemory({ skills: [path.join(dir, 'injected')] }),
        noSkills: true, additionalSkillPaths: [SKILLS_DIR],
        noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      const result = loader.getSkills();
      expect(result.diagnostics).toEqual([]);
      expect(result.skills.map(s => s.filePath).sort()).toEqual(bundle().skills.map(s => s.filePath).sort());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('TUI-only review is discoverable and physically absent from application skills', () => {
    const result = loadSkillsFromDir({ dir: path.join(SKILLS_DIR, '../.pi/skills'), source: 'project' });
    expect(result.diagnostics).toEqual([]); expect(result.skills.map(s => s.name)).toEqual(['xiangqi-review']);
    expect(bundle().skills.some(s => s.name === 'xiangqi-review')).toBe(false);
  });
});
