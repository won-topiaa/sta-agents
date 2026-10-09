"use client";
import {createContext,useContext} from 'react';

// The read-only demo (?view=research&demo=1): recorded runs instead of the owner's live workspace. Components that
// would fetch live state or offer an action read this instead: no sign-in, no request, nothing to sign.
export type ResearchDemo={agentic:Record<string,unknown>};
export const ResearchDemoContext=createContext<ResearchDemo|null>(null);
export const useResearchDemo=()=>useContext(ResearchDemoContext);
