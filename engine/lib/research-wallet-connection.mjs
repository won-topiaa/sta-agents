import {canonical,hash,keyBytes,requirePolicy as need} from './research-autonomy-policy.mjs';
import {verifyPrivyConnection,verifyStoredPrivyConnection,PRIVY_APP_ID} from './research-autonomy-privy.mjs';

// A separate registry, not an autonomy journal. A connected wallet never
// becomes an active policy merely because login/delegation succeeded.
export class WalletConnectionService {
 constructor({db,client,settings}){
  Object.assign(this,{db,client,settings});
  need(settings.appId===PRIVY_APP_ID,'WRONG_APP');
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS wallet_connections(owner TEXT PRIMARY KEY,wallet_id TEXT UNIQUE NOT NULL,address TEXT UNIQUE NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS connection_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 }
 publicSettings(){return {appId:this.settings.appId,signerId:this.settings.signerId,policyId:this.settings.policyId};}
 async verifiedBinding(owner){
  keyBytes(owner);const row=this.db.prepare("SELECT document FROM wallet_connections WHERE owner=? AND phase='CONNECTED'").get(owner);
  need(row,'DELEGATED_WALLET_NOT_CONNECTED');
  return verifyStoredPrivyConnection(this.client,JSON.parse(row.document));
 }
 get(owner){keyBytes(owner);const r=this.db.prepare('SELECT * FROM wallet_connections WHERE owner=?').get(owner);if(!r)return null;
  return {owner,address:r.address,walletId:r.wallet_id,phase:r.phase,verifiedAt:r.updated_at,tradingEnabled:false};}
 async connect(owner,input){
  keyBytes(owner);keyBytes(input?.address);
  need(typeof input.walletId==='string'&&/^[a-z0-9]{8,100}$/.test(input.walletId),'INVALID_WALLET_ID');
  const binding=await verifyPrivyConnection({client:this.client,settings:this.settings,sessionOwner:owner,
   accessToken:input.accessToken,walletId:input.walletId,address:input.address});
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const old=this.get(owner);
   need(!old||old.walletId===binding.walletId,'EXISTING_AGENT_WALLET');
   this.db.prepare(`INSERT INTO wallet_connections VALUES(?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET phase=excluded.phase,document=excluded.document,updated_at=excluded.updated_at`).run(owner,binding.walletId,binding.address,'CONNECTED',canonical(binding),Date.now());
   this.db.prepare('INSERT INTO connection_events(owner,kind,document,created_at) VALUES(?,?,?,?)').run(owner,'CONNECTED',JSON.stringify({walletId:binding.walletId,bindingHash:hash(canonical(binding))}),Date.now());
   this.db.exec('COMMIT');return this.get(owner);
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 disconnect(owner){keyBytes(owner);this.db.exec('BEGIN IMMEDIATE');try{
  const old=this.get(owner);need(old,'NO_AGENT_WALLET');
  this.db.prepare("UPDATE wallet_connections SET phase='DISCONNECTED',updated_at=? WHERE owner=?").run(Date.now(),owner);
  this.db.prepare('INSERT INTO connection_events(owner,kind,document,created_at) VALUES(?,?,?,?)').run(owner,'DISCONNECTED','{}',Date.now());
  this.db.exec('COMMIT');return this.get(owner);
 }catch(e){this.db.exec('ROLLBACK');throw e;}}
}
