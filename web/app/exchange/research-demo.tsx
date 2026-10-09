"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResearchReply, ResearchStrategy } from '@/lib/research-workspace';
import { defaultGoal, type AgentReply } from '@/lib/research-agent-types';
import type { AgentProfile } from '@/lib/research-agent-profile.mjs';
import { ResearchResults, ResearchPlanExecution, horizonText, type AgentController } from './research-agent-panel';
import { AgentBar } from './research-agent-profile';
import { AgenticConnect, useAgentic } from './research-bsc-execution';
import { ResearchDemoContext } from './research-demo-context';
import './research-workspace.css';
import './research-journey.css';

// A read-only view of recorded runs (?view=research&demo=1): the owner's agents, research, approved plans and the
// trades they made on BNB Chain, rendered by the same components as the live workspace. No wallet, no sign-in, and
// nothing can be approved, signed or traded. The data is a snapshot of the owner's workspace (/research-demo.json).
type Snapshot = {
  schema: 'xtxc.research-demo/v1'; capturedAt: string; owner: string;
  workspace: Record<string, ResearchReply>; agents: { agents: AgentProfile[] };
  agent: Record<string, AgentReply>; agentic: Record<string, unknown>;
};
type Tab = 'Backtest' | 'Execution';
const tabLabels: Record<Tab, string> = { Backtest: 'Results', Execution: 'Trades' };
const date = (value: string | number) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const amount = (value: string) => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const pct = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const noop = () => {};

export default function ResearchDemo() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [tab, setTab] = useState<Tab>('Backtest'), [mobile, setMobile] = useState<'chat' | 'report'>('chat');
  const report = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    fetch('/research-demo.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then((b: Snapshot | null) => {
      if (!live) return;
      if (b?.schema !== 'xtxc.research-demo/v1' || !b.workspace || !b.agent) { setFailed(true); return; }
      setSnapshot(b);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  // Oldest first: the hand-signed run, then the Agentic Wallet run.
  const strategies = useMemo(() => Object.values(snapshot?.workspace ?? {}).map(w => w.strategy).filter((s): s is ResearchStrategy => Boolean(s)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [snapshot]);
  const strategy = strategies.find(s => s.id === selected) ?? strategies[0] ?? null;
  const reply = strategy ? snapshot?.agent[strategy.id] ?? null : null;
  const agents = snapshot?.agents.agents ?? [];
  const agentOf = (s: ResearchStrategy) => agents.find(a => a.id === s.agentId) ?? null;
  const agent = strategy ? agentOf(strategy) : null;
  const owner = snapshot?.owner.split(':').at(-1) ?? '';
  // The recorded reply behind the same controller the live workspace uses; every action is a no-op.
  const controller = useMemo(() => reply && strategy ? {
    data: reply, dataId: strategy.id, goal: reply.runs[0]?.goal ?? defaultGoal(), setGoal: noop, busy: false, error: null, failure: null,
    refresh: async () => {}, act: async () => null, run: reply.runs[0], running: false, start: async () => null,
  } as unknown as AgentController : null, [reply, strategy]);
  const demo = useMemo(() => ({ agentic: snapshot?.agentic ?? {} }), [snapshot]);
  const run = reply?.runs[0], plans = reply?.plans ?? [];
  const trades = plans.reduce((n, p) => n + p.steps.filter(s => s.phase === 'RECONCILED').length, 0);
  // Each strategy and tab opens at its top.
  useEffect(() => { report.current?.scrollTo({ top: 0 }); }, [strategy?.id, tab]);
  function select(id: string) { setSelected(id); setTab('Backtest'); setMobile('chat'); }

  if (failed) return <main className="rw-root"><div className="rw-error" role="alert"><span>The demo could not load. <a className="rw-link" href="?view=research">Open the workspace</a> to try it with your own wallet.</span></div></main>;
  if (!snapshot || !strategy || !controller) return <main className="rw-root"><p className="rw-quiet" style={{ padding: 24 }}>Opening the demo…</p></main>;
  return <ResearchDemoContext.Provider value={demo}><main className={`rw-root rw-demo rw-mobile-${mobile}`}>
    <h1 className="rw-sr">Research demo</h1>
    <div className="rw-demo-banner" role="note"><div><b>Demo · real runs on BNB Chain mainnet, {date(strategies[0].createdAt).split(',').slice(0, 2).join(',')}</b><span>Two agents researched the same goal; one asked the owner to sign each trade, the other traded on its own through the Binance Agentic Wallet. Read-only: nothing here can be approved, signed or traded.</span></div><a className="rw-button rw-primary" href="?view=research">Try it with your wallet</a></div>
    <div className="rw-mobile-bar"><span>Demo</span><div>{(['chat', 'report'] as const).map(v => <button key={v} onClick={() => setMobile(v)} aria-pressed={mobile === v}>{v === 'chat' ? 'Strategy' : 'Report'}</button>)}</div></div>
    <div className="rw-layout">
      <aside className="rw-sidebar" aria-label="Demo strategies">
        <div className="rw-sidebar-heading"><b>Strategies <span>{strategies.length}</span></b></div>
        <div className="rw-strategy-list">{strategies.map(s => { const a = agentOf(s); return <button className={`rw-strategy ${strategy.id === s.id ? 'selected' : ''}`} aria-current={strategy.id === s.id ? 'true' : undefined} key={s.id} onClick={() => select(s.id)}><span className="rw-strategy-title"><b>{s.name}</b></span><span>{a?.name ?? 'No agent'}</span><small><i /> Recorded<span>{date(s.createdAt).split(',')[0]}</span></small></button>; })}</div>
        <div className="rw-sidebar-bottom"><span>Read-only demo<small>Owner {owner.slice(0, 6)}…{owner.slice(-4)}</small></span></div>
      </aside>
      <section className="rw-conversation" aria-label="Strategy conversation">
        <header className="rw-pane-heading"><div><b>{strategy.name}</b></div></header>
        <div className="sx-journey"><ol aria-label="Progress">{(['Agent', 'Request', 'Results', 'Approve', 'Trade'] as const).map((label, i) => <li key={label} className="sx-done"><button type="button" onClick={() => { if (i >= 2) { setTab(i === 4 ? 'Execution' : 'Backtest'); setMobile('report'); } }}><span className="sx-mark">✓</span>{label}</button></li>)}</ol>
          <div className="sx-next"><div><b>{trades} trade{trades === 1 ? '' : 's'} recorded</b><small>{agent?.approval === 'AUTO_WITHIN_LIMITS' ? 'Approved once; the agent placed each order through the Binance Agentic Wallet.' : 'Each trade was signed by the owner in their own wallet.'}</small></div><button type="button" className="rw-button rw-primary" onClick={() => { setTab('Execution'); setMobile('report'); }}>View trades</button></div></div>
        <div className="rw-messages">
          <AgentBar agents={agents} selectedId={strategy.agentId ?? null} boundToStrategy disabled onSelect={noop} onEdit={noop} onCreate={noop} extra={a => a.approval === 'AUTO_WITHIN_LIMITS' ? <DemoAgentic owner={owner} /> : null} />
          <div className="rw-date-divider"><span>{date(strategy.createdAt)}</span></div>
          <article className="rw-message"><div className="rw-message-by"><span className="rw-avatar">You</span><span>Research request</span></div><p>{strategy.objective}</p><div className="rw-brief-tags"><span>{amount(strategy.budget)} budget</span>{strategy.instruments.map(i => <span key={i}>{i}</span>)}</div></article>
          {run && <article className="rw-message"><div className="rw-message-by"><span className="rw-avatar">Goal</span><span>Research target</span></div><p>{run.goal.targetReturnBps >= 0 ? '+' : ''}{pct(run.goal.targetReturnBps)} over {horizonText(run.goal.horizonDays).replace('-', ' ')}, losing no more than {pct(run.goal.maxDrawdownBps)}. At most {pct(run.goal.maxWeightBps)} in one stock, at least {pct(run.goal.minCashBps)} in cash, {run.goal.costBps} bps cost per trade.</p><button className="rw-link" onClick={() => { setTab('Backtest'); setMobile('report'); }}>See the results</button></article>}
        </div>
      </section>
      <div className="rw-resizer" aria-hidden="true" />
      <section className="rw-report" aria-label="Research report">
        <div className="rw-tabs" role="tablist" aria-label="Report sections">{(Object.keys(tabLabels) as Tab[]).map(t => <button key={t} role="tab" aria-controls="rw-report-panel" aria-selected={tab === t} onClick={() => setTab(t)}>{tabLabels[t]}</button>)}</div>
        <div className="rw-report-scroll" role="tabpanel" id="rw-report-panel" tabIndex={0} ref={report}>
          {tab === 'Backtest' && <ResearchResults agent={controller} budget={strategy.budget} autoTrade={agent?.approval === 'AUTO_WITHIN_LIMITS'} onActivity={() => setTab('Execution')} />}
          {tab === 'Execution' && <><div className="rw-report-intro"><h2>Plans & trades</h2></div><ResearchPlanExecution key={strategy.id} agent={controller} wallet={owner} strategy={strategy} onRefresh={noop} /></>}
        </div>
        <footer className="rw-report-footer"><span>Read-only demo</span><span>Snapshot {date(snapshot.capturedAt)}</span></footer>
      </section>
    </div>
  </main></ResearchDemoContext.Provider>;
}
function DemoAgentic({ owner }: { owner: string }) { const agentic = useAgentic(owner); return <AgenticConnect agentic={agentic} />; }
