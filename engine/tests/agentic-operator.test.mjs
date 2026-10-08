import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agenticOperatorGate} from '../../web/lib/research-agentic-operator.mjs';

const OP='0xAbC0000000000000000000000000000000000dEf';   // a placeholder operator, not a real wallet
const status=fn=>{try{fn();return 'ok';}catch(e){return e.status;}};

test('only the configured operator may sign in, bind or start the Agentic Wallet', ()=>{
  for(const op of ['SIGNIN','VERIFY','START']){
    assert.equal(status(()=>agenticOperatorGate(`eip155:56:${OP}`,op,OP)),'ok');
    assert.equal(status(()=>agenticOperatorGate(`eip155:56:${OP.toLowerCase()}`,op,OP)),'ok');   // case is not identity
    assert.equal(status(()=>agenticOperatorGate('eip155:56:0x104ecf496C93ffeCCd3f4BD3a2E225a2a6295d64',op,OP)),403);
    assert.equal(status(()=>agenticOperatorGate(`solana:${'1'.repeat(40)}`,op,OP)),403);
  }
});

test('without XTXC_AGENTIC_OWNER nobody can sign in, bind or start (fail closed); stopping stays open', ()=>{
  for(const operator of [undefined,'','not-an-address']){
    for(const op of ['SIGNIN','VERIFY','START','ANYTHING'])assert.equal(status(()=>agenticOperatorGate(`eip155:56:${OP}`,op,operator)),403);
    assert.equal(status(()=>agenticOperatorGate(`eip155:56:${OP}`,'STOP',operator)),'ok');
  }
  assert.equal(status(()=>agenticOperatorGate('eip155:56:0x104ecf496C93ffeCCd3f4BD3a2E225a2a6295d64','STOP',OP)),'ok');
});
