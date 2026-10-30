import { readFileSync } from 'node:fs';
import { KNOWLEDGE_ITEMS, KNOWLEDGE_VERSION, PRINCIPLE_IDS, type KnowledgeId, type PlaybookId } from '../business/decision';

// Host-owned resources only. Never resolve a model-supplied path or discover
// user/project skills. The build mirrors this directory under dist/business/.
const root = new URL('../business/knowledge/', import.meta.url);
export function readKnowledge(id: string): string {
  if (!Object.hasOwn(KNOWLEDGE_ITEMS, id)) throw new Error('未知知识条目；只允许读取内置知识索引中的 ID');
  const text = readFileSync(new URL(KNOWLEDGE_ITEMS[id as KnowledgeId].file, root), 'utf8');
  if (!text.trim()) throw new Error(`知识条目为空：${id}`);
  return text;
}
export function knowledgeContext(playbook: PlaybookId): string {
  return [`知识包版本：${KNOWLEDGE_VERSION}`, readKnowledge('gomoku-coach'),
    '## 始终适用的原则索引',
    ...PRINCIPLE_IDS.map(id => `- ${id}: ${KNOWLEDGE_ITEMS[id].description}`),
    '## 按需知识索引（使用 read_knowledge，参数为 ID，不是文件路径）',
    ...Object.entries(KNOWLEDGE_ITEMS).map(([id, item]) => `- ${id}: ${item.description}`),
    `## 当前选中剧本：${playbook}`, readKnowledge(playbook)].join('\n\n');
}
