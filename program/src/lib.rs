//! Launch commitments: pooled, fixed-terms contributions to a Meteora DBC launch.
//!
//! Contributions are held until a funding window closes. A funded round is settled by
//! one instruction that creates the token and DBC pool and buys with exactly the target;
//! contributors then claim tokens and excess pro rata. An underfunded or expired round
//! refunds principal without calling DBC. See INTERFACE.md. Not audited.
pub mod dbc_config;
pub mod error;
pub mod ids;
pub mod instruction;
pub mod math;
pub mod processor;
pub mod state;

use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};

entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    processor::process(program_id, accounts, data)
}
