import { boundedText, object, type AgentView } from './business/types.ts';

export type DesktopCommand =
  | { kind: 'ask'; text: string }
  | { kind: 'stop' }
  | { kind: 'restart' };

export type DesktopReply = { kind: 'ok' } | { kind: 'error'; error: string };

export interface DesktopBridge {
  view(): Promise<AgentView>;
  subscribe(listener: (view: AgentView) => void): () => void;
  send(command: DesktopCommand): Promise<DesktopReply>;
}

export function parseDesktopCommand(value: unknown): DesktopCommand {
  const data = object(value);
  switch (data.kind) {
    case 'ask': {
      if (Object.keys(data).some(key => key !== 'kind' && key !== 'text')) throw new Error('Unexpected question fields.');
      const text = boundedText(data.text).trim();
      if (!text) throw new Error('A question is required.');
      return { kind: 'ask', text };
    }
    case 'stop': case 'restart':
      if (Object.keys(data).some(key => key !== 'kind')) throw new Error('Unexpected command fields.');
      return { kind: data.kind };
    default:
      throw new Error('Unsupported desktop command.');
  }
}
