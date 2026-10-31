import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSkillsForPrompt, loadSkillsFromDir, stripFrontmatter, type Skill } from '@earendil-works/pi-coding-agent';

export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));
export const EXPECTED_SKILLS = [
  'xiangqi-coach',
  'principle-rules', 'principle-facts-over-heuristics', 'principle-threats-first',
  'principle-exchange-before-greed', 'principle-clock', 'principle-single-commit',
  'read-expert-report', 'compare-candidates', 'plan-protocol', 'use-knowledge-hints', 'coordinates',
  'playbook-opening', 'playbook-middlegame', 'playbook-endgame', 'playbook-in-check',
  'playbook-under-attack', 'playbook-time-pressure', 'playbook-risk-acknowledgement',
] as const;

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function assertSkills(skills: Skill[], diagnostics: readonly unknown[]): void {
  const names = skills.map(s => s.name).sort();
  if (diagnostics.length || JSON.stringify(names) !== JSON.stringify([...EXPECTED_SKILLS].sort())) {
    throw new Error(`技能隔离校验失败：${names.join(', ')}；diagnostics=${diagnostics.length}`);
  }
}
export class SkillCatalog {
  readonly skills: Skill[];
  readonly index: string;
  private readonly root: string;
  constructor(readonly dir = DEFAULT_SKILLS_DIR) {
    this.root = realpathSync(dir);
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: 'app' });
    assertSkills(skills, diagnostics);
    this.skills = skills.sort((a, b) => a.name.localeCompare(b.name));
    for (const skill of skills) {
      if (!within(this.root, realpathSync(skill.filePath))) throw new Error('越界的技能文件');
      this.read(skill.name); // fail closed on unreadable/empty bundled files
    }
    // Pi owns XML formatting; logical locations keep installation paths private.
    this.index = formatSkillsForPrompt(this.skills.filter(s => s.name !== 'xiangqi-coach').map(s => ({
      ...s, filePath: `skills/${path.relative(this.root, s.filePath).split(path.sep).join('/')}`,
    })), 'indirect');
  }
  read(name: string, reference?: string): string {
    const skill = this.skills.find(s => s.name === name);
    if (!skill) throw new Error('未知的应用技能');
    if (reference !== undefined && !/^[a-z0-9-]+\.md$/.test(reference)) throw new Error('越界或无效的技能引用');
    const base = realpathSync(skill.baseDir);
    const file = realpathSync(reference === undefined ? skill.filePath : path.resolve(base, 'references', reference));
    if (!within(this.root, base) || !within(base, file)) throw new Error('越界的技能引用');
    if (reference !== undefined && !within(path.join(base, 'references'), file)) throw new Error('越界的技能引用');
    const text = stripFrontmatter(readFileSync(file, 'utf8')).trim();
    if (!text) throw new Error('空的技能内容');
    return text;
  }
  systemPrompt(system: string, playbook?: string): string {
    return [system, this.read('xiangqi-coach'), this.index,
      ...(playbook ? [`## 当前剧本：${playbook}\n${this.read(playbook)}`] : [])].join('\n\n');
  }
}
