//! Isolated SVM verification, NOT devnet deployment/mainnet trade evidence.
use mollusk_svm::{Mollusk,program::create_program_account_loader_v3};
use solana_account::Account;
use solana_instruction::{AccountMeta,Instruction};
use solana_pubkey::{Pubkey,pubkey};
use serde_json::{json,Value};
use sha2::{Sha256,Digest};
use std::fs;
const P:Pubkey=Pubkey::new_from_array([191;32]);
const OWNER:Pubkey=Pubkey::new_from_array([192;32]);
const VERIFIER:Pubkey=Pubkey::new_from_array([193;32]);
type Accounts=Vec<(Pubkey,Account)>;
fn pda()->Pubkey{Pubkey::find_program_address(&[b"xtxc-demo-policy1",OWNER.as_ref(),&[171;32]],&P).0}
fn ix(actor:Pubkey,data:Vec<u8>)->Instruction{let init=data[0]==0||data[0]==4;let mut a=vec![if init{AccountMeta::new(actor,true)}else{AccountMeta::new_readonly(actor,true)},AccountMeta::new(pda(),false)];if init{a.push(AccountMeta::new_readonly(Pubkey::default(),false));}Instruction{program_id:P,accounts:a,data}}
fn init(budget:u64,per:u64,count:u64)->Instruction{let mut d=vec![0];for k in [VERIFIER.to_bytes(),[194;32],[171;32],[205;32]]{d.extend(k);}for n in [0,0,budget,per,count]{d.extend(n.to_le_bytes());}d.push(1);d.extend([195;32]);ix(OWNER,d)}
fn reserve(counter:u64,amount:u64)->Instruction{let mut d=vec![1];d.extend(counter.to_le_bytes());d.extend(amount.to_le_bytes());d.extend([195;32]);d.extend([counter as u8+1;32]);ix(VERIFIER,d)}
fn settle(counter:u64)->Instruction{let mut d=vec![2];d.extend([counter as u8+1;32]);d.extend([220;32]);d.push(1);ix(VERIFIER,d)}
fn run(m:&Mollusk,label:&str,i:Instruction,a:&Accounts,success:bool,rows:&mut Vec<Value>)->Accounts{let r=m.process_transaction_instructions(&[i],a);assert_eq!(r.program_result.is_ok(),success,"{label}: {:?}",r.program_result);if !success{assert_eq!(&r.resulting_accounts,a,"rollback {label}");}rows.push(json!({"case":label,"passed":true,"expectedSuccess":success,"cu":r.compute_units_consumed,"programResult":format!("{:?}",r.program_result)}));r.resulting_accounts}
fn main(){assert_eq!(std::env::consts::OS,"linux");let root=std::env::var("STA_SVM_ROOT").expect("STA_SVM_ROOT must identify an isolated directory containing sbf/ and evidence/");std::env::set_var("SBF_OUT_DIR",format!("{root}/sbf"));let mut m=Mollusk::new(&P,"xtxc_demo_policy");m.sysvars.clock.unix_timestamp=100;m.sysvars.clock.slot=1000;
 let base=vec![(OWNER,Account{lamports:10_000_000_000,..Account::default()}),(VERIFIER,Account{lamports:100_000_000,..Account::default()}),(pda(),Account::default()),(P,create_program_account_loader_v3(&P)),(Pubkey::default(),Account{lamports:1,executable:true,owner:pubkey!("NativeLoader1111111111111111111111111111111"),..Account::default()})];
 let mut rows=vec![];let a=run(&m,"owner initializes configurable policy",init(3_000_000,2_000_000,2),&base,true,&mut rows);
 run(&m,"PDA cannot be reinitialized to reset budget",init(3_000_000,2_000_000,2),&a,false,&mut rows);
 let mut wrong=reserve(0,2_000_000);wrong.accounts[0]=AccountMeta::new_readonly(OWNER,true);run(&m,"wrong verifier",wrong,&a,false,&mut rows);
 let mut unsigned=reserve(0,2_000_000);unsigned.accounts[0].is_signer=false;run(&m,"missing verifier signature",unsigned,&a,false,&mut rows);
 run(&m,"order limit checked from config",reserve(0,2_000_001),&a,false,&mut rows);
 let mut wrongmint=reserve(0,2_000_000);wrongmint.data[17]^=1;run(&m,"unapproved mint",wrongmint,&a,false,&mut rows);
 let pending=run(&m,"reserve actual first request",reserve(0,2_000_000),&a,true,&mut rows);
 run(&m,"pending exposure blocks next order",reserve(1,1_000_000),&pending,false,&mut rows);
 run(&m,"unrelated receipt rejected",settle(1),&pending,false,&mut rows);
 let first=run(&m,"receipt attestation releases pending lock",settle(0),&pending,true,&mut rows);
 let second=run(&m,"reserve actual second request",reserve(1,1_000_000),&first,true,&mut rows);
 let complete=run(&m,"second receipt",settle(1),&second,true,&mut rows);
 run(&m,"third request rejected by exhausted limits",reserve(2,1),&complete,false,&mut rows);
 let mut recovered=Mollusk::new(&P,"xtxc_demo_policy");recovered.sysvars.clock=m.sysvars.clock.clone();run(&recovered,"restart preserves spent state",reserve(2,1),&complete,false,&mut rows);
 let stopped=run(&m,"owner revokes while pending",ix(OWNER,vec![3]),&pending,true,&mut rows);let stopped=run(&m,"receipt remains recordable after revoke",settle(0),&stopped,true,&mut rows);run(&m,"revoke prevents new reserve",reserve(1,1_000_000),&stopped,false,&mut rows);
 let mut general=run(&m,"different user-approved budget and count",init(100_000_000,20_000_000,50),&base,true,&mut rows);
 for n in 0..4 {general=run(&m,&format!("generic request {n}"),reserve(n,7_000_000),&general,true,&mut rows);general=run(&m,&format!("generic receipt {n}"),settle(n),&general,true,&mut rows);}
 // These exact instruction bytes come from the JavaScript policy encoder.
 // Testing the compiled ELF catches ABI/hash/layout drift, not only Rust logic.
 let vectors:Value=serde_json::from_slice(&fs::read(format!("{root}/evidence/v2-wire.json")).unwrap()).unwrap();
 let bytes=|v:&Value|->Vec<u8>{v.as_array().unwrap().iter().map(|n|u8::try_from(n.as_u64().unwrap()).unwrap()).collect()};
 let approval=ix(OWNER,bytes(&vectors["approval"]));
 let mut v2=run(&m,"v2 JS approval commits 58 distinct stocks",approval.clone(),&base,true,&mut rows);
 run(&m,"v2 approval cannot reset",approval,&v2,false,&mut rows);
 run(&m,"v1 reserve cannot bypass v2 commitment",reserve(0,1),&v2,false,&mut rows);
 let instructions=vectors["reserve"].as_array().unwrap();
 for n in 0..58 {
  let instruction=ix(VERIFIER,bytes(&instructions[n]));
  if n==0||n==29||n==57 {
   for offset in [1,9,17,49,81,82,90,91] {
    let mut tamper=instruction.clone();
    // messageHash may vary for the exact approved trade; test zero, not a new hash.
    if offset==49 {tamper.data[49..81].fill(0)} else {tamper.data[offset]^=1;}
    run(&m,&format!("v2 step {n} rejects tamper at {offset}"),tamper,&v2,false,&mut rows);
   }
  }
  v2=run(&m,&format!("v2 exact step {n}"),instruction.clone(),&v2,true,&mut rows);
  run(&m,&format!("v2 pending prevents replay {n}"),instruction,&v2,false,&mut rows);
  v2=run(&m,&format!("v2 result {n}"),settle(n as u64),&v2,true,&mut rows);
  let state=&v2.iter().find(|(k,_)|*k==pda()).unwrap().1.data;
  assert_eq!(u64::from_le_bytes(state[192..200].try_into().unwrap()),if n<29{0}else{(n as u64-28)*1_000_000});
 }
 let report=json!({"schema":"xtxc.autonomy-svm-evidence/v2","mainnetTrades":0,"devnetDeployment":false,"fixtureProgram":P.to_string(),"elfSha256":format!("{:x}",Sha256::digest(fs::read(format!("{root}/sbf/xtxc_demo_policy.so")).unwrap())),"rows":rows});fs::write(format!("{root}/evidence/svm.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();println!("SVM checks passed: {}",report["rows"].as_array().unwrap().len());
}
