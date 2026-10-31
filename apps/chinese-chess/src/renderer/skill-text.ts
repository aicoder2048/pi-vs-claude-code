// Human UI and model references share the same Markdown; no filesystem/IPC access.
import principles from '../../skills/skills/read-expert-report/references/principles.md' with { type: 'text' };
import conditional from '../../skills/skills/use-knowledge-hints/references/conditional-principles.md' with { type: 'text' };
import motifs from '../../skills/skills/use-knowledge-hints/references/motifs.md' with { type: 'text' };

function sections(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/^## /m).slice(1).map(section => {
    const newline = section.indexOf('\n');
    return [section.slice(0, newline).trim(), section.slice(newline + 1).trim()];
  }));
}
export const principleText = sections(principles);
export const conditionalText = sections(conditional);
export const motifText = sections(motifs);
