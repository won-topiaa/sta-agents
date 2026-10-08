import {MAINNET,integer,requirePolicy as need} from './research-autonomy-policy.mjs';
import {inspectStockMeshTrade} from './research-autonomy-wire.mjs';
import {normalizeTradeQuote,verifyMainnetReceipt} from './research-autonomy-runtime.mjs';
import {atomsDecimal} from './research-rebalance.mjs';
import {checkedOperatingPortfolio} from './research-ongoing-decision.mjs';
import {settledPhase} from './research-ongoing-journal.mjs';

export class OngoingRuntime {
  constructor({journal,mainnet,stockmesh,signer}) {Object.assign(this,{journal,mainnet,stockmesh,signer});}
  async funds(config,leg,expectedHash=null,minSlot=0) {
    const p=checkedOperatingPortfolio(config,await this.stockmesh.portfolio(config.wallet));
    need(p.stateSlot>=minSlot,'HOLDINGS_CATCHING_UP');
    if(expectedHash!==null)need(p.balanceHash===expectedHash,'DECISION_STATE_CHANGED');
    if(leg.side==='SELL')need(p.holdings.some(h=>h.mint===leg.mint&&h.rawDecimals===leg.inputDecimals&&integer(h.atoms)>=integer(leg.inputAtoms)), 'INSUFFICIENT_HELD_ASSET');
    else {
      const r=this.journal.row(config.id),o=r.risk?.observation;
      need(o&&o.balanceHash===p.balanceHash&&!r.risk.latched,'FRESH_RISK_STATE_REQUIRED');
      const managed=integer(o.equityAtoms)<integer(config.capitalAtoms)?integer(o.equityAtoms):integer(config.capitalAtoms);
      const floor=integer(o.equityAtoms)-managed+managed*BigInt(config.minCashBps)/10000n;
      need(integer(p.cashAtoms)>=integer(leg.inputAtoms)+floor+this.journal.legacyReserved(config.wallet),'CASH_RESERVED');
    }
    return p;
  }
  async prepare(id,decision) {
    const r=this.journal.assertActive(id,decision.leg.side),c=r.config,l=decision.leg,signer=this.signer(r.binding);
    await signer.assertBinding(c);await this.mainnet.pin(MAINNET);
    const p=await this.funds(c,l,decision.balanceHash,decision.stateSlot);
    const raw=await this.stockmesh.quote({instrument:l.instrument,side:l.side,inputAtoms:l.inputAtoms,productMint:l.side==='SELL'?l.mint:undefined,
      notional:atomsDecimal(l.inputAtoms,l.inputDecimals),notionalAsset:'USDC',maxSlippageBps:c.maxSlippageBps});
    need(Date.parse(raw.expiresAt)>Date.now()+4000,'QUOTE_TOO_OLD');
    const quote=normalizeTradeQuote(raw,{...l,maxSlippageBps:c.maxSlippageBps});
    const prepared=await this.stockmesh.prepare({owner:c.wallet,quoteId:quote.quoteId});
    need(prepared.quoteId===quote.quoteId,'PREPARED_QUOTE_CHANGED');
    const facts=await inspectStockMeshTrade(prepared.transactionBase64,c.wallet,{...l,minimumOutputAtoms:quote.minimumOutputAtoms},a=>this.mainnet.lookup(a));
    const simulation=await this.mainnet.simulate(prepared.transactionBase64,facts);
    need(simulation.genesisHash===MAINNET&&simulation.messageHash===facts.messageHash&&simulation.err===null,'SIMULATION_REJECTED');
    await this.funds(c,l,p.balanceHash,p.stateSlot);
    return this.journal.stage(id,decision,prepared,{...facts,instrument:l.instrument});
  }
  async execute(id) {
    let order=this.journal.order(id);need(order.phase==='PREPARED','SIGNING_ALREADY_ATTEMPTED');
    const r=this.journal.assertActive(order.mandate,order.facts.side),signer=this.signer(r.binding);
    await this.mainnet.pin(MAINNET);await signer.assertBinding(r.config);
    await this.funds(r.config,order.decision.leg,order.decision.balanceHash,order.decision.stateSlot);
    need(Date.parse(order.prepared.expiresAt)>Date.now()+4000&&await this.mainnet.blockhashValid(order.facts.blockhash),'PREPARED_TRANSACTION_EXPIRED');
    order=this.journal.beginSigning(id);
    try {order=this.journal.signed(id,await signer.signTransaction(r.config,order.prepared.transactionBase64,id,{expiresAt:order.prepared.expiresAt}));}
    catch(e){this.journal.signingUnknown(id);throw e;}
    return this.relay(id);
  }
  async relay(id) {
    const old=this.journal.order(id);await this.mainnet.pin(MAINNET);
    need(await this.mainnet.blockhashValid(old.facts.blockhash),'SIGNED_TRANSACTION_EXPIRED');
    const order=this.journal.beginRelay(id);
    const response=await this.stockmesh.submit({owner:order.wallet,quoteId:order.prepared.quoteId,preparedId:order.prepared.preparedId,signedTransactionBase64:order.signedTransactionBase64});
    need(response.signature===order.signature,'SUBMISSION_SIGNATURE_MISMATCH');return this.check(id);
  }
  async check(id) {
    let r=this.journal.order(id);if(settledPhase(r.phase))return r;
    if(r.phase==='SIGNING')return this.journal.signingUnknown(id);
    need(r.signature,'SIGNING_OUTCOME_UNKNOWN');await this.mainnet.pin(MAINNET);
    if(!r.receipt) {
      const tx=await this.mainnet.transaction(r.signature);
      if(tx)r=this.journal.receipt(id,verifyMainnetReceipt(r,tx));
      else {
        const proof=await this.mainnet.expiredNoFill(r);if(!proof)return r;
        const engine=await this.stockmesh.order(r.wallet,r.prepared.preparedId);
        need(!engine||['EXPIRED_NO_FILL','EXPIRED_UNSENT','FAILED','PREFLIGHT_REJECTED'].includes(engine.phase),'STOCKMESH_RECONCILIATION_PENDING');
        return this.journal.expiredSigned(id,proof);
      }
    }
    return this.journal.reconciled(id,await this.stockmesh.order(r.wallet,r.prepared.preparedId));
  }
}
