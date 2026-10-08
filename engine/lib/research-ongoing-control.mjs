import {randomBytes} from 'node:crypto';
import {hash,MAINNET,TOKEN,TOKEN22,requirePolicy as need} from './research-autonomy-policy.mjs';
import {briefHash} from './research-agent-core.mjs';
import {boundedMap,atomsDecimal} from './research-rebalance.mjs';
import {normalizeBuyQuote} from './research-autonomy-runtime.mjs';
import {operatingMessage,validateOperatingMandate,mandateActive} from './research-ongoing-policy.mjs';
import {chooseOperatingResearch,observeOperatingPortfolio,operatingRisk,decideOperatingTrade} from './research-ongoing-decision.mjs';
import {settledPhase} from './research-ongoing-journal.mjs';

// The controller observes one portfolio and admits one exact transaction at a
// time. No report, quote or optimistic pending sale counts as spendable cash.
export class OngoingControl {
  constructor({journal,runtime,stockmesh,connection,signer,observe=observeOperatingPortfolio}) {
    Object.assign(this,{journal,runtime,stockmesh,connection,signer,observe});
    this.busy=new Set();
  }
  async draft(owner,config) {
    validateOperatingMandate(config);need(config.owner===owner,'OWNER_SCOPE_MISMATCH');
    const binding=await this.connection(owner);
    const r=this.journal.draft(config,binding);
    return {...this.status(owner,config.id),messageToSign:operatingMessage(r.config)};
  }
  async draftResearch(owner,input) {
    const {research,limits}=input;
    need(research?.owner===owner&&research.input?.owner===`solana:${owner}`,'OWNER_SCOPE_MISMATCH');
    const binding=await this.connection(owner),notional=atomsDecimal(limits.perBuyAtoms,6);
    await this.runtime.mainnet.pin(MAINNET);
    const assets=await boundedMap(research.strategy.instruments,async instrument=>{
      const q=await this.stockmesh.quote({instrument,side:'BUY',notional,notionalAsset:'USDC',maxSlippageBps:limits.maxSlippageBps});
      const mint=q.exposure?.products?.[0]?.mint;
      normalizeBuyQuote(q,{instrument,mint,inputAtoms:limits.perBuyAtoms,maxSlippageBps:limits.maxSlippageBps});
      const a=await this.runtime.mainnet.call('getAccountInfo',[mint,{encoding:'base64',commitment:'finalized'}]);
      const bytes=Buffer.from(a?.value?.data?.[0]??'','base64');
      need([TOKEN,TOKEN22].includes(a?.value?.owner)&&a.value.executable===false&&bytes.length>=82&&bytes[45]===1,'ASSET_METADATA_NOT_VERIFIED');
      return {instrument,mint,rawDecimals:bytes[44]};
    });
    const c={...limits,schema:'sta.operating-mandate/v1',id:hash(randomBytes(32)),owner,wallet:binding.address,
      strategyId:research.strategy.id,briefHash:briefHash(research.strategy),executionChain:'solana:mainnet',
      startsAt:String(Math.floor(Date.now()/1000)),assets,goal:research.input.goal};
    chooseOperatingResearch(c,research);validateOperatingMandate(c);
    const r=await this.draft(owner,c);this.feed(owner,c.id,research);return {...r,messageToSign:operatingMessage(c)};
  }
  async activate(owner,id,signature) {
    const r=this.journal.row(id,owner),binding=await this.connection(owner);
    await this.signer({...r.binding,enabled:true}).assertBinding(r.config);
    this.journal.activate(id,owner,signature,binding);
    return this.status(owner,id);
  }
  feed(owner,id,research) {
    const r=this.journal.row(id,owner),selection=chooseOperatingResearch(r.config,research);
    return this.journal.transaction(()=>{
      const current=this.journal.row(id,owner);
      if(current.research?.updatedAt===research.updatedAt) {
        need(current.research.result.reportHash===selection.reportHash,'RESEARCH_EVENT_CONFLICT');
        return {accepted:true,duplicate:true};
      }
      need(!current.research||current.research.updatedAt<research.updatedAt,'RESEARCH_EVENT_OUT_OF_ORDER');
      this.journal.save({...current,research,nextAt:0});
      this.journal.event(id,'RESEARCH_UPDATED',{runId:research.runId,reportHash:selection.reportHash,candidateId:selection.candidate?.id??null});
      return {accepted:true,reportHash:selection.reportHash};
    });
  }
  feedStrategy(owner,research) {
    const rows=this.journal.db.prepare("SELECT id FROM ongoing_mandates WHERE owner=? AND phase IN ('DRAFT','ACTIVE','PAUSED','RISK_EXIT')").all(owner);
    const accepted=[];
    for(const row of rows) {
      const r=this.journal.row(row.id);
      if(r.config.strategyId!==research.strategy?.id||r.config.briefHash!==research.input?.briefHash)continue;
      this.feed(owner,row.id,research);accepted.push(row.id);
    }
    return {accepted};
  }
  status(owner,id) {
    const r=this.journal.row(id,owner),orders=this.journal.orders(id);
    return {id,owner,wallet:r.config.wallet,phase:r.phase,config:r.config,authorized:!!r.approvalSignature,
      progress:r.progress??'AWAITING_INITIAL_AUTHORIZATION',reason:r.reason??null,nextAt:r.nextAt,
      usage:r.usage,drawdownBps:r.risk?.drawdownBps??null,riskLatched:r.risk?.latched??false,
      holdings:r.risk?.observation??null,reportHash:r.research?.result.reportHash??null,
      orders:orders.slice(-50).map(o=>({id:o.id,sequence:o.sequence,phase:o.phase,side:o.facts.side,
        instrument:o.facts.instrument,inputAtoms:o.facts.inputAtoms,signature:o.signature,receipt:o.receipt??null,
        engineReconciled:o.engineReconciled===true}))};
  }
  update(id,patch,phase=null) {
    return this.journal.transaction(()=>{
      const current=this.journal.row(id);
      // Stop/revoke can arrive while a network request is outstanding. Never
      // overwrite the owner's latest authority state with an old snapshot.
      const nextPhase=phase&&['ACTIVE','RISK_EXIT'].includes(current.phase)?phase:current.phase;
      return this.journal.save({...current,...patch},nextPhase);
    });
  }
  async tick(id) {
    if(this.busy.has(id))return;
    this.busy.add(id);
    try {
      let r=this.journal.row(id),orders=this.journal.orders(id);
      const pending=orders.find(o=>!settledPhase(o.phase));
      if(pending) {
        // Receipts remain recoverable even after pause, expiry or revocation.
        if(pending.phase==='PREPARED') {
          if(Date.parse(pending.prepared.expiresAt)<=Date.now())this.journal.expireUnsigned(pending.id);
          else if(['ACTIVE','RISK_EXIT'].includes(r.phase)&&mandateActive(r.config))await this.runtime.execute(pending.id);
        } else {
          const checked=await this.runtime.check(pending.id);
          r=this.journal.row(id);
          if(['SIGNED','UNKNOWN'].includes(checked.phase)&&checked.relayAttempts<3&&Date.now()-(checked.lastRelayAt??0)>=5000&&
             ['ACTIVE','RISK_EXIT'].includes(r.phase)&&mandateActive(r.config))await this.runtime.relay(checked.id);
        }
        this.update(id,{progress:'RECONCILING_ORDER',nextAt:Date.now()+r.config.pollMs});return;
      }
      if(!['ACTIVE','RISK_EXIT'].includes(r.phase))return;
      if(!mandateActive(r.config)) {
        this.journal.transaction(()=>{const current=this.journal.row(id);this.journal.save({...current,binding:{...current.binding,enabled:false},reason:'MANDATE_EXPIRED'},'EXPIRED');});return;
      }
      if(r.nextAt>Date.now())return;
      const observation=await this.observe(r.config,this.stockmesh);
      orders=this.journal.orders(id);
      const receipts=orders.filter(o=>o.sequence>(r.receiptCursor??0)&&o.receipt&&settledPhase(o.phase)).map(o=>o.receipt);
      const settledSlot=Math.max(0,...receipts.filter(x=>x.phase==='RECONCILED').map(x=>x.slot));
      need(observation.stateSlot>=settledSlot,'HOLDINGS_CATCHING_UP');
      const risk=operatingRisk(r.risk,observation,receipts,r.config.maxLossBps);
      this.journal.transaction(()=>{
        const current=this.journal.row(id);
        if(!['ACTIVE','RISK_EXIT'].includes(current.phase))return;
        let usage=current.usage;
        if(risk.latched&&!current.risk?.latched) {
          usage={...usage,riskTargets:Object.fromEntries(observation.holdings.map(h=>[h.mint,
            String(BigInt(h.atoms)*BigInt(10000-r.config.riskReductionBps)/10000n)]))};
          this.journal.event(id,'AUTOMATIC_RISK_EXIT',{drawdownBps:risk.drawdownBps,action:r.config.riskAction});
        }
        this.journal.save({...current,risk,usage,receiptCursor:orders.at(-1)?.sequence??0},risk.latched?'RISK_EXIT':current.phase);
      });
      r=this.journal.assertActive(id);
      let research=null,researchError=null;
      try{research=chooseOperatingResearch(r.config,r.research);}catch(e){researchError=e.code??'RESEARCH_UNAVAILABLE';}
      const decision=decideOperatingTrade(r.config,observation,research,risk,r.usage);
      if(decision.action==='HOLD') {
        this.update(id,{progress:'WATCHING',reason:researchError??decision.reason,nextAt:Date.now()+r.config.pollMs});return;
      }
      decision.balanceHash=observation.balanceHash;decision.stateSlot=observation.stateSlot;
      decision.reportHash=research?.reportHash??null;
      const order=await this.runtime.prepare(id,decision);
      this.update(id,{progress:'EXECUTING',reason:decision.leg.reason,nextAt:Date.now()+r.config.pollMs});
      await this.runtime.execute(order.id);
    } catch(e) {
      const r=this.journal.row(id),code=typeof e.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'DEPENDENCY_UNAVAILABLE';
      this.update(id,{progress:'WAITING_DEPENDENCY',reason:code,nextAt:Date.now()+Math.max(r.config.pollMs,5000)});
    } finally {this.busy.delete(id);}
  }
  async tickNext() {
    const rows=this.journal.db.prepare(`SELECT m.id FROM ongoing_mandates m WHERE
      (m.phase IN ('ACTIVE','RISK_EXIT') AND json_extract(m.document,'$.nextAt')<=?) OR
      EXISTS(SELECT 1 FROM ongoing_execution_orders o WHERE o.mandate=m.id AND o.phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_NO_FILL','EXPIRED_UNSIGNED') AND json_extract(m.document,'$.nextAt')<=?)
      ORDER BY json_extract(m.document,'$.nextAt'),m.id LIMIT 1`).all(Date.now(),Date.now());
    if(rows[0])await this.tick(rows[0].id);
  }
}
