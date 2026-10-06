//! DEVNET evidence/reservation only. This program has NO mainnet authority.
//! A separately trusted gate validates the actual mainnet wire and exclusively
//! holds the delegated signing capability. Receipts here are its attestations,
//! not cross-chain proofs. Never release an ambiguous reservation on a timeout.
use solana_program::{account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult,
    program::invoke_signed, program_error::ProgramError, pubkey::Pubkey, rent::Rent, sysvar::Sysvar};
use solana_sdk_ids::system_program;
use solana_system_interface::instruction as system_instruction;
#[cfg(not(feature="no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const LEN: usize = 616;
pub const SEED: &[u8] = b"xtxc-demo-policy1";
pub const TAG: &[u8;8] = b"XTXCDMP1";
pub const TAG2: &[u8;8] = b"XTXCDMP2";
pub const INVALID:u32=8101;
pub const AUTH:u32=8102;
pub const INACTIVE:u32=8103;
pub const BUDGET:u32=8104;
pub const PENDING:u32=8105;
pub const REPLAY:u32=8106;
fn need(ok:bool,code:u32)->ProgramResult { if ok {Ok(())} else {Err(ProgramError::Custom(code))} }
pub fn num(d:&[u8],p:usize)->Result<u64,ProgramError>{Ok(u64::from_le_bytes(d.get(p..p+8).ok_or(ProgramError::InvalidInstructionData)?.try_into().map_err(|_|ProgramError::InvalidInstructionData)?))}
fn key(d:&[u8],p:usize)->Result<Pubkey,ProgramError>{Ok(Pubkey::new_from_array(d.get(p..p+32).ok_or(ProgramError::InvalidInstructionData)?.try_into().map_err(|_|ProgramError::InvalidInstructionData)?))}
fn put(d:&mut[u8],p:usize,n:u64){d[p..p+8].copy_from_slice(&n.to_le_bytes())}
pub fn validate(d:&[u8])->ProgramResult{
    need(d.len()==LEN && (&d[..8]==TAG || &d[..8]==TAG2),INVALID)?;
    let v2=&d[..8]==TAG2;
    need(key(d,8)?!=Pubkey::default() && key(d,40)?!=Pubkey::default() && key(d,72)?!=Pubkey::default() && key(d,8)?!=key(d,40)?,INVALID)?;
    need(d[104..136]!=[0;32] && d[136..168]!=[0;32] && if v2 {d[226]==0 && d[344..376]!=[0;32] && num(d,208)?<=128} else {(1..=8).contains(&d[226])},INVALID)?;
    need((v2 || num(d,184)?>0) && num(d,192)?<=num(d,184)? && num(d,208)?>0 && num(d,200)?<=num(d,208)?,INVALID)?;
    need((v2 || num(d,216)?>0) && num(d,216)?<=num(d,184)? && (num(d,176)?==0 || num(d,176)?>num(d,168)?) && d[224]<=1 && d[225]<=1 && d[336]<=2,INVALID)?;
    need(d[228]<=if v2 {1} else {0} && d[229..232]==[0;3] && d[337..344]==[0;7] && d[if v2 {376} else {344+usize::from(d[226])*32}..LEN].iter().all(|x|*x==0),INVALID)?;
    for i in 0..usize::from(d[226]) {need(key(d,344+i*32)?!=Pubkey::default(),INVALID)?; for j in 0..i {need(key(d,344+i*32)?!=key(d,344+j*32)?,INVALID)?;}}
    Ok(())
}
/// Deterministic state transition, shared verbatim by the SBF entrypoint/tests.
pub fn transition(d:&mut[u8],actor:&Pubkey,ix:&[u8],now:u64)->ProgramResult{
    validate(d)?;
    match ix.first().copied() {
        Some(1)=>{
            need(&d[..8]==TAG,INVALID)?;
            need(ix.len()==81 && *actor==key(d,40)?,AUTH)?;
            need(d[225]==0 && now>=num(d,168)? && (num(d,176)?==0 || now<num(d,176)?),INACTIVE)?;
            need(d[224]==0,PENDING)?;
            let count=num(d,200)?;
            need(num(ix,1)?==count,REPLAY)?;
            need(count<num(d,208)?,BUDGET)?;
            let amount=num(ix,9)?;
            need(amount>0 && amount<=num(d,216)?,BUDGET)?;
            need((0..usize::from(d[226])).any(|i|d[344+i*32..376+i*32]==ix[17..49]) && ix[49..81]!=[0;32],INVALID)?;
            let reserved=num(d,192)?.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)?;
            need(reserved<=num(d,184)?,BUDGET)?;
            put(d,192,reserved);put(d,200,count+1);put(d,264,amount);
            d[232..264].copy_from_slice(&ix[49..81]);d[272..304].copy_from_slice(&ix[17..49]);
            d[304..336].fill(0);d[224]=1;d[336]=0;
        }
        Some(5)=>{
            need(&d[..8]==TAG2 && ix.len()>=91 && *actor==key(d,40)?,AUTH)?;
            let depth=usize::from(ix[90]);
            need(depth<=7 && ix.len()==91+32*depth && ix[81]<=1 && ix[49..81]!=[0;32],INVALID)?;
            need(d[225]==0 && now>=num(d,168)? && (num(d,176)?==0 || now<num(d,176)?),INACTIVE)?;
            need(d[224]==0,PENDING)?;
            let count=num(d,200)?;let amount=num(ix,9)?;
            need(num(ix,1)?==count,REPLAY)?;need(count<num(d,208)?,BUDGET)?;
            need(amount>0 && key(ix,17)?!=Pubkey::default(),INVALID)?;
            let sell=ix[81]==1;let minimum=num(ix,82)?;
            need(if sell {minimum>0} else {minimum==0 && amount<=num(d,216)?},BUDGET)?;
            let mut h=solana_program::hash::hashv(&[b"STA:trade:v2",&ix[1..9],&ix[81..82],&ix[17..49],&ix[9..17],&ix[82..90]]).to_bytes();
            let mut position=count;let mut width=num(d,208)?;let mut expected_depth=0;
            while width>1 {width=(width+1)/2;expected_depth+=1;}
            need(depth==expected_depth,INVALID)?;
            for sibling in ix[91..].chunks_exact(32){
                h=if position&1==0 {solana_program::hash::hashv(&[b"STA:branch:v2",&h,sibling])} else {solana_program::hash::hashv(&[b"STA:branch:v2",sibling,&h])}.to_bytes();
                position>>=1;
            }
            need(d[344..376]==h,INVALID)?;
            let reserved=num(d,192)?.checked_add(if sell {0} else {amount}).ok_or(ProgramError::ArithmeticOverflow)?;
            need(reserved<=num(d,184)?,BUDGET)?;
            put(d,192,reserved);put(d,200,count+1);put(d,264,amount);
            d[232..264].copy_from_slice(&ix[49..81]);d[272..304].copy_from_slice(&ix[17..49]);
            d[304..336].fill(0);d[224]=1;d[228]=ix[81];d[336]=0;
        }
        Some(2)=>{
            need(ix.len()==66 && *actor==key(d,40)?,AUTH)?;
            need(d[224]==1 && d[232..264]==ix[1..33],REPLAY)?;
            need(ix[33..65]!=[0;32] && (ix[65]==1 || ix[65]==2),INVALID)?;
            // Revoke may occur while a mainnet transaction is in flight. Keep
            // its evidence writable, but never allow a new reservation.
            d[304..336].copy_from_slice(&ix[33..65]);d[224]=0;d[336]=ix[65];
        }
        Some(3)=>{need(ix.len()==1 && *actor==key(d,8)?,AUTH)?;d[225]=1;}
        _=>return Err(ProgramError::InvalidInstructionData)
    }
    validate(d)
}
pub fn process_instruction(program:&Pubkey,accounts:&[AccountInfo],ix:&[u8])->ProgramResult {
    need(accounts.len()>=2,INVALID)?;
    let actor=&accounts[0];let state=&accounts[1];
    need(actor.is_signer && state.is_writable && actor.key!=state.key,AUTH)?;
    if ix.first()==Some(&0) || ix.first()==Some(&4) {
        let v2=ix[0]==4;
        need(accounts.len()==3 && if v2 {ix.len()==201} else {ix.len()>=202 && ix[169]>=1 && ix[169]<=8 && ix.len()==170+usize::from(ix[169])*32},INVALID)?;
        need(actor.is_writable && accounts[2].key==&system_program::id() && state.owner==&system_program::id() && state.data_is_empty(),INVALID)?;
        let (pda,bump)=Pubkey::find_program_address(&[SEED,actor.key.as_ref(),&ix[65..97]],program);
        need(state.key==&pda,INVALID)?;
        let mut d=vec![0u8;LEN];d[..8].copy_from_slice(if v2 {TAG2} else {TAG});d[8..40].copy_from_slice(actor.key.as_ref());
        d[40..168].copy_from_slice(&ix[1..129]);d[168..184].copy_from_slice(&ix[129..145]);
        d[184..192].copy_from_slice(&ix[145..153]);d[216..224].copy_from_slice(&ix[153..161]);
        d[208..216].copy_from_slice(&ix[161..169]);
        d[227]=bump;
        if v2 {d[344..376].copy_from_slice(&ix[169..201]);} else {d[226]=ix[169];d[344..344+usize::from(ix[169])*32].copy_from_slice(&ix[170..]);}
        validate(&d)?;
        // No account close/reset instruction. Reusing this PDA cannot reset its
        // budget. The signing gateway separately rejects a devnet reset.
        invoke_signed(&system_instruction::create_account(actor.key,state.key,Rent::get()?.minimum_balance(LEN),LEN as u64,program),
            &[actor.clone(),state.clone(),accounts[2].clone()],&[&[SEED,actor.key.as_ref(),&ix[65..97],&[bump]]])?;
        state.try_borrow_mut_data()?.copy_from_slice(&d);
    } else {
        need(accounts.len()==2 && state.owner==program && !state.executable,INVALID)?;
        let mut d=state.try_borrow_data()?.to_vec();validate(&d)?;
        let (pda,bump)=Pubkey::find_program_address(&[SEED,&d[8..40],&d[104..136]],program);
        need(state.key==&pda && d[227]==bump,INVALID)?;
        let now=u64::try_from(Clock::get()?.unix_timestamp).map_err(|_|ProgramError::InvalidArgument)?;
        transition(&mut d,actor.key,ix,now)?;state.try_borrow_mut_data()?.copy_from_slice(&d);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state()->Vec<u8>{let mut d=vec![0;LEN];d[..8].copy_from_slice(TAG);d[8..40].fill(1);d[40..72].fill(2);d[72..104].fill(3);d[104..136].fill(4);d[136..168].fill(5);put(&mut d,184,3_000_000);put(&mut d,208,2);put(&mut d,216,2_000_000);d[226]=1;d[344..376].fill(6);d}
    fn reserve(n:u64,amount:u64)->Vec<u8>{let mut ix=vec![1];ix.extend(n.to_le_bytes());ix.extend(amount.to_le_bytes());ix.extend([6;32]);ix.extend([7+n as u8;32]);ix}
    fn settle(hash:u8)->Vec<u8>{let mut ix=vec![2];ix.extend([hash;32]);ix.extend([9;32]);ix.push(1);ix}
    #[test] fn two_buys_then_rejection(){let mut d=state();let a=Pubkey::new_from_array([2;32]);transition(&mut d,&a,&reserve(0,2_000_000),1).unwrap();transition(&mut d,&a,&settle(7),1).unwrap();transition(&mut d,&a,&reserve(1,1_000_000),2).unwrap();transition(&mut d,&a,&settle(8),2).unwrap();assert_eq!(num(&d,192).unwrap(),3_000_000);assert_eq!(transition(&mut d,&a,&reserve(2,1),3),Err(ProgramError::Custom(BUDGET)));}
    #[test] fn pending_cannot_refill_or_reset(){let mut d=state();let a=Pubkey::new_from_array([2;32]);transition(&mut d,&a,&reserve(0,2_000_000),1).unwrap();assert_eq!(transition(&mut d,&a,&reserve(1,1_000_000),999999),Err(ProgramError::Custom(PENDING)));assert_eq!(num(&d,192).unwrap(),2_000_000);}
    #[test] fn wrong_actor_amount_mint_hash(){let d=state();let a=Pubkey::new_from_array([2;32]);assert!(transition(&mut d.clone(),&Pubkey::new_unique(),&reserve(0,2_000_000),1).is_err());assert!(transition(&mut d.clone(),&a,&reserve(0,2_000_001),1).is_err());let mut ix=reserve(0,2_000_000);ix[17]=44;assert!(transition(&mut d.clone(),&a,&ix,1).is_err());ix=reserve(0,2_000_000);ix[49..].fill(0);assert!(transition(&mut d.clone(),&a,&ix,1).is_err());}
    #[test] fn limits_are_configuration_not_demo_steps(){let mut d=state();put(&mut d,184,100_000_000);put(&mut d,216,20_000_000);put(&mut d,208,50);let a=Pubkey::new_from_array([2;32]);for n in 0..4 {transition(&mut d,&a,&reserve(n,7_000_000),1).unwrap();transition(&mut d,&a,&settle(7+n as u8),1).unwrap();}assert_eq!(num(&d,192).unwrap(),28_000_000);assert_eq!(num(&d,200).unwrap(),4);}
    #[test] fn revoke_stops_new_signing_not_receipts(){let mut d=state();let a=Pubkey::new_from_array([2;32]);transition(&mut d,&a,&reserve(0,2_000_000),1).unwrap();transition(&mut d,&Pubkey::new_from_array([1;32]),&[3],1).unwrap();transition(&mut d,&a,&settle(7),2).unwrap();assert!(transition(&mut d,&a,&reserve(1,1_000_000),3).is_err());}
    #[test] fn expiry_optional_not_implicit_one_hour(){let a=Pubkey::new_from_array([2;32]);transition(&mut state(),&a,&reserve(0,2_000_000),9_000_000).unwrap();let mut d=state();put(&mut d,176,20);assert!(transition(&mut d,&a,&reserve(0,2_000_000),20).is_err());}
}
