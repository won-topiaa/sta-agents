import {reject} from './research-agent-core.mjs';

// One gateway drives one Agentic Wallet for the whole deployment, so only the operator named by XTXC_AGENTIC_OWNER may
// sign it in, bind it or start trading with it. Without that setting nobody can (fail closed), whatever the binding
// says. Stopping a run is always allowed: it is scoped to the plan's owner and only ends trading.
export function agenticOperatorGate(address,operation,operator=process.env.XTXC_AGENTIC_OWNER){
  if(operation==='STOP')return;
  if(!operator||!/^0x[0-9a-fA-F]{40}$/.test(operator))reject('The Agentic Wallet is not set up on this server.',403);
  if(String(address).toLowerCase()!==`eip155:56:${operator.toLowerCase()}`)reject('The Agentic Wallet is reserved for the operator account.',403);
}
