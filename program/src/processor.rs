//! Instruction handlers. Every CPI is built here from fixed shapes; no caller-supplied
//! instruction is ever forwarded. Every CPI target is checked against `ids` before use,
//! because the vault, budget and mint PDAs sign those calls.
use crate::{
    dbc_config,
    error::LcError,
    ids,
    instruction::{parse, Ix},
    math::allocation,
    state::{
        Campaign, Receipt, CAMPAIGN_SIZE, MAX_NAME, MAX_SYMBOL, MAX_URI, RECEIPT_SIZE, STATE_OPEN,
        STATE_SETTLED,
    },
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

/// Lamports the organizer must place in the budget PDA at creation.
/// One local settlement spent 29,077,360 lamports of it (program/selftest-result.json);
/// the rest is headroom and the budget account's own rent floor. Not recoverable in v1.
pub const MIN_SETUP_BUDGET_LAMPORTS: u64 = 50_000_000;

const SEED_CAMPAIGN: &[u8] = b"campaign";
const SEED_VAULT: &[u8] = b"vault";
const SEED_BUDGET: &[u8] = b"budget";
const SEED_MINT: &[u8] = b"mint";
const SEED_RECEIPT: &[u8] = b"receipt";

const DBC_IX_INITIALIZE_POOL_SPL: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
const DBC_IX_TRANSFER_POOL_CREATOR: [u8; 8] = [20, 7, 169, 33, 58, 147, 166, 33];
const DBC_IX_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
const DBC_SWAP_MODE_EXACT_IN: u8 = 0;
/// `creator` in a DBC pool account: 8 discriminator + 64 volatility tracker + 32 config.
const DBC_POOL_CREATOR_OFFSET: usize = 104;

const TOKEN_ACCOUNT_SIZE: usize = 165;
const TOKEN_IX_TRANSFER: u8 = 3;
const TOKEN_IX_SYNC_NATIVE: u8 = 17;
const ATA_IX_CREATE_IDEMPOTENT: u8 = 1;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match parse(data)? {
        Ix::CreateCampaign { nonce, target, min_tokens, close_time, expiry, budget_lamports, name, symbol, uri } => {
            create_campaign(program_id, accounts, nonce, target, min_tokens, close_time, expiry, budget_lamports, name, symbol, uri)
        }
        Ix::Contribute { amount } => contribute(program_id, accounts, amount),
        Ix::Withdraw { amount } => withdraw(program_id, accounts, amount),
        Ix::Settle => settle(program_id, accounts),
        Ix::Claim => claim(program_id, accounts),
        Ix::Refund => refund(program_id, accounts),
    }
}

// ---------------------------------------------------------------- helpers

fn require(cond: bool, e: LcError) -> ProgramResult {
    if cond {
        Ok(())
    } else {
        Err(e.into())
    }
}

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

fn is_uninitialized(a: &AccountInfo) -> bool {
    *a.owner == ids::SYSTEM_PROGRAM && a.data_is_empty()
}

/// A program-owned campaign at its canonical address.
///
/// Only CreateCampaign can produce a program-owned account with this tag, and it only
/// does so at the canonical PDA, so the address check is defence in depth.
fn load_campaign(program_id: &Pubkey, a: &AccountInfo) -> Result<Campaign, ProgramError> {
    require(a.owner == program_id, LcError::InvalidAccountOwner)?;
    let c = Campaign::unpack(&a.try_borrow_data()?)?;
    check_pda(
        a,
        &[SEED_CAMPAIGN, c.organizer.as_ref(), &c.nonce.to_le_bytes(), &[c.bump_campaign]],
        program_id,
    )?;
    Ok(c)
}

fn store_campaign(a: &AccountInfo, c: &Campaign) -> ProgramResult {
    Ok(c.pack(&mut a.try_borrow_mut_data()?)?)
}

/// A live receipt for exactly this campaign and contributor, at its canonical address.
fn load_receipt(program_id: &Pubkey, a: &AccountInfo, campaign: &Pubkey, contributor: &Pubkey) -> Result<Receipt, ProgramError> {
    require(a.owner == program_id, LcError::InvalidAccountOwner)?;
    let r = Receipt::unpack(&a.try_borrow_data()?)?;
    require(r.campaign == *campaign && r.contributor == *contributor, LcError::InvalidAccountData)?;
    check_pda(a, &[SEED_RECEIPT, campaign.as_ref(), contributor.as_ref(), &[r.bump]], program_id)?;
    Ok(r)
}

fn check_pda(a: &AccountInfo, seeds: &[&[u8]], program_id: &Pubkey) -> ProgramResult {
    let expected = Pubkey::create_program_address(seeds, program_id).map_err(|_| LcError::InvalidPda)?;
    require(*a.key == expected, LcError::InvalidPda)
}

fn system_transfer<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    lamports: u64,
    signers: &[&[&[u8]]],
) -> ProgramResult {
    if lamports == 0 {
        return Ok(());
    }
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    let ix = Instruction {
        program_id: ids::SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*from.key, true), AccountMeta::new(*to.key, false)],
        data,
    };
    invoke_signed(&ix, &[from.clone(), to.clone(), system.clone()], signers)
}

/// Create a program-owned PDA account. Works even if someone pre-funded the address.
fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    new: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    require(is_uninitialized(new), LcError::InvalidAccountData)?;
    let rent = Rent::get()?.minimum_balance(space);
    if new.lamports() == 0 {
        let mut data = Vec::with_capacity(52);
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(&rent.to_le_bytes());
        data.extend_from_slice(&(space as u64).to_le_bytes());
        data.extend_from_slice(&owner.to_bytes());
        let ix = Instruction {
            program_id: ids::SYSTEM_PROGRAM,
            accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*new.key, true)],
            data,
        };
        return invoke_signed(&ix, &[payer.clone(), new.clone(), system.clone()], &[seeds]);
    }
    system_transfer(payer, new, system, rent.saturating_sub(new.lamports()), &[])?;
    let mut allocate = Vec::with_capacity(12);
    allocate.extend_from_slice(&8u32.to_le_bytes());
    allocate.extend_from_slice(&(space as u64).to_le_bytes());
    invoke_signed(
        &Instruction { program_id: ids::SYSTEM_PROGRAM, accounts: vec![AccountMeta::new(*new.key, true)], data: allocate },
        &[new.clone(), system.clone()],
        &[seeds],
    )?;
    let mut assign = Vec::with_capacity(36);
    assign.extend_from_slice(&1u32.to_le_bytes());
    assign.extend_from_slice(&owner.to_bytes());
    invoke_signed(
        &Instruction { program_id: ids::SYSTEM_PROGRAM, accounts: vec![AccountMeta::new(*new.key, true)], data: assign },
        &[new.clone(), system.clone()],
        &[seeds],
    )
}

/// Close a program-owned account and send its lamports to `dest`. Call after all CPIs.
fn close_account(a: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    let lamports = a.lamports();
    let credited = dest.lamports().checked_add(lamports).ok_or(LcError::MathOverflow)?;
    **dest.try_borrow_mut_lamports()? = credited;
    **a.try_borrow_mut_lamports()? = 0;
    a.resize(0)?;
    a.assign(&ids::SYSTEM_PROGRAM);
    Ok(())
}

/// (mint, owner, amount) of an initialized legacy SPL token account.
fn token_account(a: &AccountInfo) -> Result<(Pubkey, Pubkey, u64), ProgramError> {
    require(*a.owner == ids::TOKEN_PROGRAM, LcError::InvalidTokenAccount)?;
    let d = a.try_borrow_data()?;
    require(d.len() == TOKEN_ACCOUNT_SIZE && d[108] == 1, LcError::InvalidTokenAccount)?;
    Ok((
        Pubkey::new_from_array(d[0..32].try_into().unwrap()),
        Pubkey::new_from_array(d[32..64].try_into().unwrap()),
        u64::from_le_bytes(d[64..72].try_into().unwrap()),
    ))
}

/// SPL Token `SyncNative`: set a wrapped-SOL account's token amount from its lamports.
fn sync_native<'a>(wsol_account: &AccountInfo<'a>, token_program: &AccountInfo<'a>) -> ProgramResult {
    invoke(
        &Instruction {
            program_id: ids::TOKEN_PROGRAM,
            accounts: vec![AccountMeta::new(*wsol_account.key, false)],
            data: vec![TOKEN_IX_SYNC_NATIVE],
        },
        &[wsol_account.clone(), token_program.clone()],
    )
}

fn borsh_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s);
}

// ---------------------------------------------------------------- create

#[allow(clippy::too_many_arguments)]
fn create_campaign(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    nonce: u64,
    target: u64,
    min_tokens: u64,
    close_time: i64,
    expiry: i64,
    budget_lamports: u64,
    name: &str,
    symbol: &str,
    uri: &str,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let organizer = next_account_info(it)?;
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let budget = next_account_info(it)?;
    let beneficiary = next_account_info(it)?;
    let config = next_account_info(it)?;
    let system = next_account_info(it)?;

    require(organizer.is_signer, LcError::MissingSignature)?;
    require(*system.key == ids::SYSTEM_PROGRAM, LcError::InvalidProgramId)?;

    let now = now()?;
    require(target > 0 && min_tokens > 0, LcError::InvalidTerms)?;
    require(close_time > now && expiry > close_time, LcError::InvalidTerms)?;
    require(budget_lamports >= MIN_SETUP_BUDGET_LAMPORTS, LcError::BudgetTooSmall)?;

    let nonce_bytes = nonce.to_le_bytes();
    let (campaign_key, bump_campaign) =
        Pubkey::find_program_address(&[SEED_CAMPAIGN, organizer.key.as_ref(), &nonce_bytes], program_id);
    let (vault_key, bump_vault) = Pubkey::find_program_address(&[SEED_VAULT, campaign_key.as_ref()], program_id);
    let (budget_key, bump_budget) = Pubkey::find_program_address(&[SEED_BUDGET, campaign_key.as_ref()], program_id);
    let (mint_key, bump_mint) = Pubkey::find_program_address(&[SEED_MINT, campaign_key.as_ref()], program_id);
    require(
        *campaign_ai.key == campaign_key && *vault.key == vault_key && *budget.key == budget_key,
        LcError::InvalidPda,
    )?;
    require(is_uninitialized(vault) && is_uninitialized(budget), LcError::InvalidAccountData)?;
    // the beneficiary is an outside party: never one of this campaign's own addresses
    require(
        *beneficiary.key != Pubkey::default()
            && *beneficiary.key != vault_key
            && *beneficiary.key != campaign_key
            && *beneficiary.key != budget_key
            && *beneficiary.key != mint_key,
        LcError::InvalidTerms,
    )?;

    // the config must be a real DBC PoolConfig that passes the preset; bind its bytes
    require(*config.owner == ids::DBC_PROGRAM, LcError::InvalidAccountOwner)?;
    let config_hash = {
        let d = config.try_borrow_data()?;
        dbc_config::validate_preset(&d, target)?;
        hashv(&[&d]).to_bytes()
    };

    create_pda_account(
        organizer,
        campaign_ai,
        system,
        CAMPAIGN_SIZE,
        program_id,
        &[SEED_CAMPAIGN, organizer.key.as_ref(), &nonce_bytes, &[bump_campaign]],
    )?;
    // the vault keeps a rent floor that is never counted as principal
    let floor = Rent::get()?.minimum_balance(0);
    system_transfer(organizer, vault, system, floor.saturating_sub(vault.lamports()), &[])?;
    system_transfer(organizer, budget, system, budget_lamports, &[])?;

    let mut name_buf = [0u8; MAX_NAME];
    name_buf[..name.len()].copy_from_slice(name.as_bytes());
    let mut symbol_buf = [0u8; MAX_SYMBOL];
    symbol_buf[..symbol.len()].copy_from_slice(symbol.as_bytes());
    let mut uri_buf = [0u8; MAX_URI];
    uri_buf[..uri.len()].copy_from_slice(uri.as_bytes());

    let c = Campaign {
        state: STATE_OPEN,
        bump_campaign,
        bump_vault,
        bump_budget,
        bump_mint,
        name_len: name.len() as u8,
        symbol_len: symbol.len() as u8,
        uri_len: uri.len() as u8,
        organizer: *organizer.key,
        nonce,
        beneficiary: *beneficiary.key,
        config: *config.key,
        config_hash,
        mint: mint_key,
        token_account: Pubkey::default(),
        target,
        min_tokens,
        close_time,
        expiry,
        total_contributed: 0,
        receipt_count: 0,
        tokens_bought: 0,
        settled_at: 0,
        tokens_claimed: 0,
        excess_paid: 0,
        refunded: 0,
        created_at: now,
        name: name_buf,
        symbol: symbol_buf,
        uri: uri_buf,
    };
    store_campaign(campaign_ai, &c)
}

// ---------------------------------------------------------------- contribute / withdraw

fn contribute(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let contributor = next_account_info(it)?;
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let receipt_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    require(contributor.is_signer, LcError::MissingSignature)?;
    require(*system.key == ids::SYSTEM_PROGRAM, LcError::InvalidProgramId)?;
    require(amount > 0, LcError::ZeroAmount)?;

    let mut c = load_campaign(program_id, campaign_ai)?;
    require(c.funding_open(now()?), LcError::FundingClosed)?;
    check_pda(vault, &[SEED_VAULT, campaign_ai.key.as_ref(), &[c.bump_vault]], program_id)?;

    let mut r = if is_uninitialized(receipt_ai) {
        let (key, bump) = Pubkey::find_program_address(
            &[SEED_RECEIPT, campaign_ai.key.as_ref(), contributor.key.as_ref()],
            program_id,
        );
        require(*receipt_ai.key == key, LcError::InvalidPda)?;
        create_pda_account(
            contributor,
            receipt_ai,
            system,
            RECEIPT_SIZE,
            program_id,
            &[SEED_RECEIPT, campaign_ai.key.as_ref(), contributor.key.as_ref(), &[bump]],
        )?;
        c.receipt_count = c.receipt_count.checked_add(1).ok_or(LcError::MathOverflow)?;
        Receipt { campaign: *campaign_ai.key, contributor: *contributor.key, amount: 0, bump }
    } else {
        load_receipt(program_id, receipt_ai, campaign_ai.key, contributor.key)?
    };

    system_transfer(contributor, vault, system, amount, &[])?;
    r.amount = r.amount.checked_add(amount).ok_or(LcError::MathOverflow)?;
    c.total_contributed = c.total_contributed.checked_add(amount).ok_or(LcError::MathOverflow)?;

    r.pack(&mut receipt_ai.try_borrow_mut_data()?)?;
    store_campaign(campaign_ai, &c)
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let contributor = next_account_info(it)?;
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let receipt_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    require(contributor.is_signer, LcError::MissingSignature)?;
    require(*system.key == ids::SYSTEM_PROGRAM, LcError::InvalidProgramId)?;
    require(amount > 0, LcError::ZeroAmount)?;

    let mut c = load_campaign(program_id, campaign_ai)?;
    require(c.funding_open(now()?), LcError::FundingClosed)?;
    let vault_seeds: &[&[u8]] = &[SEED_VAULT, campaign_ai.key.as_ref(), &[c.bump_vault]];
    check_pda(vault, vault_seeds, program_id)?;

    let mut r = load_receipt(program_id, receipt_ai, campaign_ai.key, contributor.key)?;
    require(amount <= r.amount, LcError::InsufficientReceiptBalance)?;

    system_transfer(vault, contributor, system, amount, &[vault_seeds])?;
    r.amount -= amount;
    c.total_contributed = c.total_contributed.checked_sub(amount).ok_or(LcError::MathOverflow)?;

    if r.amount == 0 {
        c.receipt_count = c.receipt_count.checked_sub(1).ok_or(LcError::MathOverflow)?;
        close_account(receipt_ai, contributor)?;
    } else {
        r.pack(&mut receipt_ai.try_borrow_mut_data()?)?;
    }
    store_campaign(campaign_ai, &c)
}

// ---------------------------------------------------------------- settle

fn settle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let budget = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let beneficiary = next_account_info(it)?;
    let config = next_account_info(it)?;
    let pool_authority = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let base_vault = next_account_info(it)?;
    let quote_vault = next_account_info(it)?;
    let metadata = next_account_info(it)?;
    let wsol_mint = next_account_info(it)?;
    let vault_wsol = next_account_info(it)?;
    let vault_token = next_account_info(it)?;
    let event_authority = next_account_info(it)?;
    let dbc = next_account_info(it)?;
    let metadata_program = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    let mut c = load_campaign(program_id, campaign_ai)?;
    let now = now()?;
    require(c.state == STATE_OPEN, LcError::WrongState)?;
    require(now >= c.close_time, LcError::FundingStillOpen)?;
    require(now < c.expiry, LcError::SettlementExpired)?;
    require(c.total_contributed >= c.target, LcError::TargetNotReached)?;

    // every program the PDAs will sign for, and every fixed address
    require(
        *dbc.key == ids::DBC_PROGRAM
            && *metadata_program.key == ids::METADATA_PROGRAM
            && *token_program.key == ids::TOKEN_PROGRAM
            && *ata_program.key == ids::ATA_PROGRAM
            && *system.key == ids::SYSTEM_PROGRAM,
        LcError::InvalidProgramId,
    )?;
    require(
        *pool_authority.key == ids::DBC_POOL_AUTHORITY && *wsol_mint.key == ids::WSOL_MINT,
        LcError::InvalidAccountData,
    )?;

    let campaign_key = *campaign_ai.key;
    let vault_seeds: &[&[u8]] = &[SEED_VAULT, campaign_key.as_ref(), &[c.bump_vault]];
    let budget_seeds: &[&[u8]] = &[SEED_BUDGET, campaign_key.as_ref(), &[c.bump_budget]];
    let mint_seeds: &[&[u8]] = &[SEED_MINT, campaign_key.as_ref(), &[c.bump_mint]];
    check_pda(vault, vault_seeds, program_id)?;
    check_pda(budget, budget_seeds, program_id)?;
    check_pda(mint, mint_seeds, program_id)?;
    require(*mint.key == c.mint, LcError::InvalidPda)?;
    require(*beneficiary.key == c.beneficiary && *config.key == c.config, LcError::InvalidAccountData)?;

    // the bound config must be byte-identical and still pass the preset
    require(*config.owner == ids::DBC_PROGRAM, LcError::InvalidAccountOwner)?;
    {
        let d = config.try_borrow_data()?;
        require(hashv(&[&d]).to_bytes() == c.config_hash, LcError::ConfigHashMismatch)?;
        dbc_config::validate_preset(&d, c.target)?;
    }

    // 1. create mint + pool. creator = vault, payer = budget; DBC enforces the pool,
    //    vault and metadata addresses from the mint and config.
    let mut data = Vec::with_capacity(8 + 12 + c.name_len as usize + c.symbol_len as usize + c.uri_len as usize);
    data.extend_from_slice(&DBC_IX_INITIALIZE_POOL_SPL);
    borsh_str(&mut data, &c.name[..c.name_len as usize]);
    borsh_str(&mut data, &c.symbol[..c.symbol_len as usize]);
    borsh_str(&mut data, &c.uri[..c.uri_len as usize]);
    invoke_signed(
        &Instruction {
            program_id: ids::DBC_PROGRAM,
            accounts: vec![
                AccountMeta::new_readonly(*config.key, false),
                AccountMeta::new_readonly(*pool_authority.key, false),
                AccountMeta::new_readonly(*vault.key, true),
                AccountMeta::new(*mint.key, true),
                AccountMeta::new_readonly(*wsol_mint.key, false),
                AccountMeta::new(*pool.key, false),
                AccountMeta::new(*base_vault.key, false),
                AccountMeta::new(*quote_vault.key, false),
                AccountMeta::new(*metadata.key, false),
                AccountMeta::new_readonly(*metadata_program.key, false),
                AccountMeta::new(*budget.key, true),
                AccountMeta::new_readonly(*token_program.key, false),
                AccountMeta::new_readonly(*token_program.key, false),
                AccountMeta::new_readonly(*system.key, false),
                AccountMeta::new_readonly(*event_authority.key, false),
                AccountMeta::new_readonly(*dbc.key, false),
            ],
            data,
        },
        &[
            config.clone(),
            pool_authority.clone(),
            vault.clone(),
            mint.clone(),
            wsol_mint.clone(),
            pool.clone(),
            base_vault.clone(),
            quote_vault.clone(),
            metadata.clone(),
            metadata_program.clone(),
            budget.clone(),
            token_program.clone(),
            system.clone(),
            event_authority.clone(),
            dbc.clone(),
        ],
        &[vault_seeds, budget_seeds, mint_seeds],
    )?;

    // 2. hand the pool creator role to the published beneficiary before any trade
    invoke_signed(
        &Instruction {
            program_id: ids::DBC_PROGRAM,
            accounts: vec![
                AccountMeta::new(*pool.key, false),
                AccountMeta::new_readonly(*config.key, false),
                AccountMeta::new_readonly(*vault.key, true),
                AccountMeta::new_readonly(*beneficiary.key, false),
                AccountMeta::new_readonly(*event_authority.key, false),
                AccountMeta::new_readonly(*dbc.key, false),
            ],
            data: DBC_IX_TRANSFER_POOL_CREATOR.to_vec(),
        },
        &[pool.clone(), config.clone(), vault.clone(), beneficiary.clone(), event_authority.clone(), dbc.clone()],
        &[vault_seeds],
    )?;
    {
        require(*pool.owner == ids::DBC_PROGRAM, LcError::InvalidAccountOwner)?;
        let d = pool.try_borrow_data()?;
        require(
            d.len() >= DBC_POOL_CREATOR_OFFSET + 32
                && d[DBC_POOL_CREATOR_OFFSET..DBC_POOL_CREATOR_OFFSET + 32] == c.beneficiary.to_bytes(),
            LcError::InvalidAccountData,
        )?;
    }

    // 3. the vault's two token accounts; the Associated Token program enforces their addresses
    for (ata, ata_mint) in [(vault_wsol, wsol_mint), (vault_token, mint)] {
        invoke_signed(
            &Instruction {
                program_id: ids::ATA_PROGRAM,
                accounts: vec![
                    AccountMeta::new(*budget.key, true),
                    AccountMeta::new(*ata.key, false),
                    AccountMeta::new_readonly(*vault.key, false),
                    AccountMeta::new_readonly(*ata_mint.key, false),
                    AccountMeta::new_readonly(*system.key, false),
                    AccountMeta::new_readonly(*token_program.key, false),
                ],
                data: vec![ATA_IX_CREATE_IDEMPOTENT],
            },
            &[budget.clone(), ata.clone(), vault.clone(), ata_mint.clone(), system.clone(), token_program.clone(), ata_program.clone()],
            &[budget_seeds],
        )?;
    }
    // Anyone can create this account early and send it lamports. Fold any such
    // donation into its token balance first, so it is part of the baseline and
    // cannot make the spend check below fail.
    sync_native(vault_wsol, token_program)?;
    let (wsol_acc_mint, wsol_acc_owner, wsol_before) = token_account(vault_wsol)?;
    let (tok_acc_mint, tok_acc_owner, tokens_before) = token_account(vault_token)?;
    require(
        wsol_acc_mint == ids::WSOL_MINT && wsol_acc_owner == *vault.key && tok_acc_mint == c.mint && tok_acc_owner == *vault.key,
        LcError::InvalidTokenAccount,
    )?;

    // 4. wrap exactly the target
    system_transfer(vault, vault_wsol, system, c.target, &[vault_seeds])?;
    sync_native(vault_wsol, token_program)?;

    // 5. first buy on the new pool: exact-in target, minimum out min_tokens
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&DBC_IX_SWAP2);
    data.extend_from_slice(&c.target.to_le_bytes());
    data.extend_from_slice(&c.min_tokens.to_le_bytes());
    data.push(DBC_SWAP_MODE_EXACT_IN);
    invoke_signed(
        &Instruction {
            program_id: ids::DBC_PROGRAM,
            accounts: vec![
                AccountMeta::new_readonly(*pool_authority.key, false),
                AccountMeta::new_readonly(*config.key, false),
                AccountMeta::new(*pool.key, false),
                AccountMeta::new(*vault_wsol.key, false),
                AccountMeta::new(*vault_token.key, false),
                AccountMeta::new(*base_vault.key, false),
                AccountMeta::new(*quote_vault.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new_readonly(*wsol_mint.key, false),
                AccountMeta::new_readonly(*vault.key, true),
                AccountMeta::new_readonly(*token_program.key, false),
                AccountMeta::new_readonly(*token_program.key, false),
                // no referral: Anchor reads the program id as "None"
                AccountMeta::new_readonly(*dbc.key, false),
                AccountMeta::new_readonly(*event_authority.key, false),
                AccountMeta::new_readonly(*dbc.key, false),
            ],
            data,
        },
        &[
            pool_authority.clone(),
            config.clone(),
            pool.clone(),
            vault_wsol.clone(),
            vault_token.clone(),
            base_vault.clone(),
            quote_vault.clone(),
            mint.clone(),
            wsol_mint.clone(),
            vault.clone(),
            token_program.clone(),
            event_authority.clone(),
            dbc.clone(),
        ],
        &[vault_seeds],
    )?;

    // 6. exactly the target was spent, and at least the promised tokens arrived
    let (_, _, wsol_after) = token_account(vault_wsol)?;
    let (_, _, tokens_after) = token_account(vault_token)?;
    require(wsol_after == wsol_before, LcError::QuoteSpendMismatch)?;
    let bought = tokens_after.checked_sub(tokens_before).ok_or(LcError::MathOverflow)?;
    require(bought >= c.min_tokens, LcError::MinTokensNotMet)?;

    // the vault still covers every excess refund above its rent floor
    let owed = c.total_contributed - c.target;
    let floor = Rent::get()?.minimum_balance(0);
    require(
        vault.lamports() >= floor.checked_add(owed).ok_or(LcError::MathOverflow)?,
        LcError::VaultInvariant,
    )?;

    c.state = STATE_SETTLED;
    c.tokens_bought = bought;
    c.settled_at = now;
    c.token_account = *vault_token.key;
    store_campaign(campaign_ai, &c)
}

// ---------------------------------------------------------------- claim / refund

fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let contributor = next_account_info(it)?;
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let receipt_ai = next_account_info(it)?;
    let campaign_token = next_account_info(it)?;
    let contributor_token = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    require(contributor.is_signer, LcError::MissingSignature)?;
    require(
        *token_program.key == ids::TOKEN_PROGRAM && *system.key == ids::SYSTEM_PROGRAM,
        LcError::InvalidProgramId,
    )?;

    let mut c = load_campaign(program_id, campaign_ai)?;
    require(c.state == STATE_SETTLED, LcError::WrongState)?;
    let vault_seeds: &[&[u8]] = &[SEED_VAULT, campaign_ai.key.as_ref(), &[c.bump_vault]];
    check_pda(vault, vault_seeds, program_id)?;
    require(*campaign_token.key == c.token_account, LcError::InvalidTokenAccount)?;

    let r = load_receipt(program_id, receipt_ai, campaign_ai.key, contributor.key)?;
    let (dest_mint, dest_owner, _) = token_account(contributor_token)?;
    require(
        dest_mint == c.mint && dest_owner == *contributor.key && contributor_token.key != campaign_token.key,
        LcError::InvalidTokenAccount,
    )?;

    let (tokens, excess) =
        allocation(r.amount, c.total_contributed, c.target, c.tokens_bought).ok_or(LcError::MathOverflow)?;

    c.tokens_claimed = c.tokens_claimed.checked_add(tokens).ok_or(LcError::MathOverflow)?;
    c.excess_paid = c.excess_paid.checked_add(excess).ok_or(LcError::MathOverflow)?;
    c.receipt_count = c.receipt_count.checked_sub(1).ok_or(LcError::MathOverflow)?;
    require(
        c.tokens_claimed <= c.tokens_bought && c.excess_paid <= c.total_contributed - c.target,
        LcError::VaultInvariant,
    )?;

    if tokens > 0 {
        let mut data = Vec::with_capacity(9);
        data.push(TOKEN_IX_TRANSFER);
        data.extend_from_slice(&tokens.to_le_bytes());
        invoke_signed(
            &Instruction {
                program_id: ids::TOKEN_PROGRAM,
                accounts: vec![
                    AccountMeta::new(*campaign_token.key, false),
                    AccountMeta::new(*contributor_token.key, false),
                    AccountMeta::new_readonly(*vault.key, true),
                ],
                data,
            },
            &[campaign_token.clone(), contributor_token.clone(), vault.clone(), token_program.clone()],
            &[vault_seeds],
        )?;
    }
    system_transfer(vault, contributor, system, excess, &[vault_seeds])?;

    store_campaign(campaign_ai, &c)?;
    close_account(receipt_ai, contributor)
}

/// Returns exactly the contribution. Touches no DBC account, so an upstream change
/// cannot block it.
fn refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let contributor = next_account_info(it)?;
    let campaign_ai = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let receipt_ai = next_account_info(it)?;
    let system = next_account_info(it)?;

    require(contributor.is_signer, LcError::MissingSignature)?;
    require(*system.key == ids::SYSTEM_PROGRAM, LcError::InvalidProgramId)?;

    let mut c = load_campaign(program_id, campaign_ai)?;
    require(c.state == STATE_OPEN, LcError::WrongState)?;
    require(c.refundable(now()?), LcError::RefundNotAvailable)?;
    let vault_seeds: &[&[u8]] = &[SEED_VAULT, campaign_ai.key.as_ref(), &[c.bump_vault]];
    check_pda(vault, vault_seeds, program_id)?;

    let r = load_receipt(program_id, receipt_ai, campaign_ai.key, contributor.key)?;

    c.refunded = c.refunded.checked_add(r.amount).ok_or(LcError::MathOverflow)?;
    c.receipt_count = c.receipt_count.checked_sub(1).ok_or(LcError::MathOverflow)?;
    require(c.refunded <= c.total_contributed, LcError::VaultInvariant)?;

    system_transfer(vault, contributor, system, r.amount, &[vault_seeds])?;

    store_campaign(campaign_ai, &c)?;
    close_account(receipt_ai, contributor)
}
