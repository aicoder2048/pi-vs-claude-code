import { describe, expect, test } from 'bun:test';
import { KNOWLEDGE_ITEMS, KNOWLEDGE_VERSION, PRINCIPLE_IDS, WORKFLOW_STEPS, type PlaybookId } from '../src/business/decision';
import { knowledgeContext, readKnowledge } from '../src/agent/knowledge-loader';

const playbooks: PlaybookId[] = ['opening', 'midgame', 'endgame', 'time-pressure'];
describe('host-owned Gomoku knowledge pack', () => {
  test('every indexed entry exists; portable skills have matching frontmatter', () => {
    for (const [id, item] of Object.entries(KNOWLEDGE_ITEMS)) {
      const text = readKnowledge(id);
      expect(item.description.length).toBeGreaterThan(10);
      expect(text.length).toBeGreaterThan(100);
      if (item.file.endsWith('SKILL.md')) {
        expect(text.startsWith('---\n')).toBe(true);
        expect(text).toContain(`name: ${id}\n`);
        expect(text).toContain('description: ');
      }
    }
    for (const id of playbooks) {
      for (const step of WORKFLOW_STEPS) expect(readKnowledge(id)).toContain(`**${step}**`);
      expect(readKnowledge(id)).toContain('证据');
    }
  });
  test('only the selected playbook is fully injected, alongside a short principles index', () => {
    for (const selected of playbooks) {
      const context = knowledgeContext(selected);
      expect(context).toContain(KNOWLEDGE_VERSION);
      expect(context).toContain(readKnowledge('gomoku-coach'));
      expect(context).toContain(readKnowledge(selected));
      for (const id of playbooks.filter(id => id !== selected)) expect(context).not.toContain(readKnowledge(id));
      for (const id of PRINCIPLE_IDS) {
        expect(context).toContain(`${id}: ${KNOWLEDGE_ITEMS[id].description}`);
        expect(context).not.toContain(readKnowledge(id));
      }
      expect(context).not.toContain(readKnowledge('verify-board'));
    }
  });
  test('knowledge lookup is an ID whitelist, not a file reader or prototype lookup', () => {
    for (const id of ['../RULES.md', '/etc/passwd', 'opening.md', '__proto__', 'constructor', 'toString', '']) {
      expect(() => readKnowledge(id)).toThrow('未知知识条目');
    }
  });
  test('verification is before commit, rules stay freestyle and heuristics stay qualified', () => {
    expect(readKnowledge('principle-rules')).toContain('无禁手');
    expect(readKnowledge('principle-rules')).toContain('长连对双方都合法');
    expect(readKnowledge('verify-board')).toContain('成功落子后不可再调用');
    expect(readKnowledge('evaluate-threats')).toContain('不是严格活三识别');
    expect(readKnowledge('endgame')).toContain('不可宣称随便堵一点就安全');
    expect(readKnowledge('principle-tactics')).toContain('先手反击');
    expect(readKnowledge('principle-evidence')).toContain('not-found-within-budget');
    for (const id of ['midgame', 'check-forcing-sequences', 'gomoku-coach', 'verify-board']) {
      expect(readKnowledge(id)).toContain('check_forcing_sequences');
      expect(readKnowledge(id)).toContain('accepted:true');
    }
    expect(readKnowledge('check-forcing-sequences')).toContain('acknowledgeRisk:true');
    expect(readKnowledge('check-forcing-sequences')).toContain('incomplete');
  });
});
