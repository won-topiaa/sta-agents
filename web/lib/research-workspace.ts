export type ResearchBrief = {
  name: string;
  objective: string;
  budget: string;
  instruments: string[];
  weights: { instrument: string; weightBps: number }[];
  cashBps: number | null;
  agentId?: string;
};
export type ResearchNote = { id: string; text: string; createdAt: string; revision: number };
export type ResearchStrategy = ResearchBrief & {
  id: string;
  revision: number;
  status: "DRAFT";
  createdAt: string;
  updatedAt: string;
  messages: ResearchNote[];
};
export type ResearchSummary = Omit<ResearchStrategy, "messages">;
export type ResearchEvent = { cursor: number; strategyId: string; revision: number; kind: string; createdAt: string };
export type ResearchReply = {
  owner: string;
  strategies: ResearchSummary[];
  strategy: ResearchStrategy | null;
  events: ResearchEvent[];
  cursor: number;
};
export const blankResearchBrief = (): ResearchBrief => ({ name: "", objective: "", budget: "100", instruments: [], weights: [], cashBps: null });
