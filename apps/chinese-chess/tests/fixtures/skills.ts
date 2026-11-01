import { fileURLToPath } from 'node:url';

// Bundle completeness is a test assertion, not a runtime Skill registry.
export const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));
export const EXPECTED_SKILLS = [
  'xiangqi-coach',
  'principle-rules', 'principle-facts-over-heuristics', 'principle-threats-first',
  'principle-exchange-before-greed', 'principle-clock', 'principle-single-commit',
  'read-expert-report', 'compare-candidates', 'plan-protocol', 'use-knowledge-hints', 'coordinates',
  'playbook-opening', 'playbook-middlegame', 'playbook-endgame', 'playbook-in-check',
  'playbook-under-attack', 'playbook-time-pressure', 'playbook-risk-acknowledgement',
];
