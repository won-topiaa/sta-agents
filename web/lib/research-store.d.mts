import type { ResearchBrief, ResearchStrategy, ResearchReply } from './research-workspace';
export class ResearchStoreError extends Error { constructor(message: string, status?: number); status: number }
export function validateBrief(input: unknown, allowed: readonly string[]): ResearchBrief;
export class ResearchStore {
  constructor(path: string, allowed: readonly string[]);
  close(): void;
  read(owner: string, id?: string | null, after?: number): ResearchReply;
  mutate(owner: string, body: unknown): ResearchStrategy;
}
