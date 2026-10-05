//! Custom error codes. Numbers are part of the interface (see INTERFACE.md).
use solana_program::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum LcError {
    InvalidInstructionData = 6000,
    MissingSignature = 6001,
    InvalidProgramId = 6002,
    InvalidPda = 6003,
    InvalidAccountOwner = 6004,
    InvalidAccountData = 6005,
    InvalidTerms = 6006,
    ConfigNotSupported = 6007,
    ConfigHashMismatch = 6008,
    FundingClosed = 6009,
    FundingStillOpen = 6010,
    TargetNotReached = 6011,
    SettlementExpired = 6012,
    WrongState = 6013,
    RefundNotAvailable = 6014,
    InsufficientReceiptBalance = 6015,
    MathOverflow = 6016,
    MinTokensNotMet = 6017,
    QuoteSpendMismatch = 6018,
    InvalidTokenAccount = 6019,
    BudgetTooSmall = 6020,
    ZeroAmount = 6021,
    VaultInvariant = 6022,
}

impl From<LcError> for ProgramError {
    fn from(e: LcError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
