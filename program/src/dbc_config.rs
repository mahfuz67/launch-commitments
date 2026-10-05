//! The single supported DBC `PoolConfig` preset.
//!
//! Offsets include the 8-byte Anchor discriminator and were checked against
//! `programs/dynamic-bonding-curve/src/state/config.rs` at commit f552f20 (program 0.2.1)
//! and against the SDK 1.5.13 decoder (see sdk/selftest.cjs). The curve, supply,
//! threshold and fee recipients are not constrained here; they are bound by hash.
use crate::{error::LcError, ids};

pub const CONFIG_SIZE: usize = 1048;
pub const POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];

pub const OFF_QUOTE_MINT: usize = 8;
pub const OFF_CLIFF_FEE_NUMERATOR: usize = 104;
pub const OFF_SECOND_FACTOR: usize = 112;
pub const OFF_THIRD_FACTOR: usize = 120;
pub const OFF_FIRST_FACTOR: usize = 128;
pub const OFF_BASE_FEE_MODE: usize = 130;
pub const OFF_DYNAMIC_FEE_INITIALIZED: usize = 136;
pub const OFF_LP_VESTING: usize = 184; // partner (16) then creator (16)
pub const OFF_COLLECT_FEE_MODE: usize = 232;
pub const OFF_MIGRATION_OPTION: usize = 233;
pub const OFF_TOKEN_TYPE: usize = 237;
pub const OFF_QUOTE_TOKEN_FLAG: usize = 238;
pub const OFF_PARTNER_PERMANENT_LOCKED: usize = 239;
pub const OFF_PARTNER_LIQUIDITY: usize = 240;
pub const OFF_CREATOR_PERMANENT_LOCKED: usize = 241;
pub const OFF_CREATOR_LIQUIDITY: usize = 242;
pub const OFF_MIGRATION_FEE_OPTION: usize = 243;
pub const OFF_FIXED_SUPPLY_FLAG: usize = 244;
pub const OFF_TOKEN_UPDATE_AUTHORITY: usize = 246;
pub const OFF_MIGRATION_FEE_PCT: usize = 247;
pub const OFF_CREATOR_MIGRATION_FEE_PCT: usize = 248;
pub const OFF_SWAP_BASE_AMOUNT: usize = 256;
pub const OFF_MIGRATION_QUOTE_THRESHOLD: usize = 264;
pub const OFF_MIGRATION_BASE_THRESHOLD: usize = 272;
pub const OFF_POST_MIGRATION_SUPPLY: usize = 352;
pub const OFF_LOCKED_VESTING: usize = 296; // 48 bytes
pub const OFF_ENABLE_FIRST_SWAP_MIN_FEE: usize = 365;
pub const OFF_POOL_CREATION_FEE: usize = 368;

/// 1% of DBC's 1e9 fee denominator.
pub const REQUIRED_CLIFF_FEE_NUMERATOR: u64 = 10_000_000;

/// At most 1/1000 of post-migration supply may be neither sold on the curve nor placed
/// in the migrated pool. DBC sends that remainder to the config's leftover receiver, so
/// without this bound an organizer could keep a large free allocation.
pub const MAX_UNALLOCATED_SUPPLY_DIVISOR: u128 = 1_000;

fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn all_zero(d: &[u8]) -> bool {
    d.iter().all(|b| *b == 0)
}

/// Checks account data only. The caller checks the account owner.
pub fn validate_preset(d: &[u8], target: u64) -> Result<(), LcError> {
    let bad = Err(LcError::ConfigNotSupported);
    if d.len() != CONFIG_SIZE || d[..8] != POOL_CONFIG_DISCRIMINATOR {
        return bad;
    }
    if d[OFF_QUOTE_MINT..OFF_QUOTE_MINT + 32] != ids::WSOL_MINT.to_bytes() {
        return bad;
    }
    // fixed 1% fee, no schedule, no dynamic fee
    if u64_at(d, OFF_CLIFF_FEE_NUMERATOR) != REQUIRED_CLIFF_FEE_NUMERATOR
        || u64_at(d, OFF_SECOND_FACTOR) != 0
        || u64_at(d, OFF_THIRD_FACTOR) != 0
        || d[OFF_FIRST_FACTOR] != 0
        || d[OFF_FIRST_FACTOR + 1] != 0
        || d[OFF_BASE_FEE_MODE] != 0
        || d[OFF_DYNAMIC_FEE_INITIALIZED] != 0
    {
        return bad;
    }
    // no LP vesting for either side
    if !all_zero(&d[OFF_LP_VESTING..OFF_LP_VESTING + 32]) {
        return bad;
    }
    if d[OFF_COLLECT_FEE_MODE] != 0
        || d[OFF_MIGRATION_OPTION] != 1
        || d[OFF_TOKEN_TYPE] != 0
        || d[OFF_QUOTE_TOKEN_FLAG] != 0
    {
        return bad;
    }
    // all migrated liquidity permanently locked
    if d[OFF_PARTNER_LIQUIDITY] != 0
        || d[OFF_CREATOR_LIQUIDITY] != 0
        || d[OFF_PARTNER_PERMANENT_LOCKED] as u16 + d[OFF_CREATOR_PERMANENT_LOCKED] as u16 != 100
    {
        return bad;
    }
    if d[OFF_MIGRATION_FEE_OPTION] > 5
        || d[OFF_FIXED_SUPPLY_FLAG] != 1
        || d[OFF_TOKEN_UPDATE_AUTHORITY] != 1
        || d[OFF_MIGRATION_FEE_PCT] != 0
        || d[OFF_CREATOR_MIGRATION_FEE_PCT] != 0
    {
        return bad;
    }
    if !all_zero(&d[OFF_LOCKED_VESTING..OFF_LOCKED_VESTING + 48]) {
        return bad;
    }
    if d[OFF_ENABLE_FIRST_SWAP_MIN_FEE] != 0 || u64_at(d, OFF_POOL_CREATION_FEE) != 0 {
        return bad;
    }
    // nearly all supply is either sold on the curve or locked in the migrated pool
    let post_supply = u64_at(d, OFF_POST_MIGRATION_SUPPLY) as u128;
    let allocated = u64_at(d, OFF_SWAP_BASE_AMOUNT) as u128 + u64_at(d, OFF_MIGRATION_BASE_THRESHOLD) as u128;
    if post_supply == 0 || allocated == 0 {
        return bad;
    }
    if post_supply.saturating_sub(allocated) > post_supply / MAX_UNALLOCATED_SUPPLY_DIVISOR {
        return bad;
    }
    // the pooled buy must leave the curve open for public trading
    if u64_at(d, OFF_MIGRATION_QUOTE_THRESHOLD) <= target {
        return bad;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn good_config() -> Vec<u8> {
        let mut d = vec![0u8; CONFIG_SIZE];
        d[..8].copy_from_slice(&POOL_CONFIG_DISCRIMINATOR);
        d[OFF_QUOTE_MINT..OFF_QUOTE_MINT + 32].copy_from_slice(&ids::WSOL_MINT.to_bytes());
        d[40..72].copy_from_slice(&[7u8; 32]); // fee_claimer: free
        d[72..104].copy_from_slice(&[8u8; 32]); // leftover_receiver: free
        d[OFF_CLIFF_FEE_NUMERATOR..OFF_CLIFF_FEE_NUMERATOR + 8]
            .copy_from_slice(&REQUIRED_CLIFF_FEE_NUMERATOR.to_le_bytes());
        d[OFF_MIGRATION_OPTION] = 1;
        d[234] = 1; // activation_type: free
        d[235] = 6; // token_decimal: free
        d[OFF_PARTNER_PERMANENT_LOCKED] = 100;
        d[OFF_MIGRATION_FEE_OPTION] = 2;
        d[OFF_FIXED_SUPPLY_FLAG] = 1;
        d[245] = 50; // creator_trading_fee_percentage: free
        d[OFF_TOKEN_UPDATE_AUTHORITY] = 1;
        d[OFF_MIGRATION_QUOTE_THRESHOLD..OFF_MIGRATION_QUOTE_THRESHOLD + 8]
            .copy_from_slice(&100_000_000_000u64.to_le_bytes());
        // 1e15 supply: 81% sold on the curve, 19% to the migrated pool
        set_supply(&mut d, 810_000_000_000_000, 190_000_000_000_000, 1_000_000_000_000_000);
        d
    }

    fn set_supply(d: &mut [u8], sold: u64, pooled: u64, post: u64) {
        d[OFF_SWAP_BASE_AMOUNT..OFF_SWAP_BASE_AMOUNT + 8].copy_from_slice(&sold.to_le_bytes());
        d[OFF_MIGRATION_BASE_THRESHOLD..OFF_MIGRATION_BASE_THRESHOLD + 8].copy_from_slice(&pooled.to_le_bytes());
        d[OFF_POST_MIGRATION_SUPPLY..OFF_POST_MIGRATION_SUPPLY + 8].copy_from_slice(&post.to_le_bytes());
    }

    #[test]
    fn bounds_supply_kept_outside_curve_and_pool() {
        let post = 1_000_000_000_000_000u64;
        let mut d = good_config();
        // exactly 0.1% unallocated is the limit
        set_supply(&mut d, 809_000_000_000_000, 190_000_000_000_000, post);
        assert!(validate_preset(&d, 1).is_ok());
        set_supply(&mut d, 808_999_999_999_999, 190_000_000_000_000, post);
        assert!(validate_preset(&d, 1).is_err());
        // a 20% leftover allocation, as the SDK builds with leftover = 200M of 1B
        set_supply(&mut d, 648_534_858_303_189, 151_465_121_336_875, post);
        assert!(validate_preset(&d, 1).is_err());
        // the measured zero-leftover preset
        set_supply(&mut d, 810_668_572_878_985, 189_331_401_671_094, post);
        assert!(validate_preset(&d, 1).is_ok());
        // degenerate values
        set_supply(&mut d, 0, 0, post);
        assert!(validate_preset(&d, 1).is_err());
        set_supply(&mut d, 1, 1, 0);
        assert!(validate_preset(&d, 1).is_err());
        // more allocated than post supply (burn difference) is not an organizer allocation
        set_supply(&mut d, u64::MAX, u64::MAX, post);
        assert!(validate_preset(&d, 1).is_ok());
    }

    #[test]
    fn accepts_the_preset() {
        assert_eq!(validate_preset(&good_config(), 1_000_000_000), Ok(()));
        let mut split = good_config();
        split[OFF_PARTNER_PERMANENT_LOCKED] = 60;
        split[OFF_CREATOR_PERMANENT_LOCKED] = 40;
        assert_eq!(validate_preset(&split, 1), Ok(()));
    }

    #[test]
    fn rejects_every_constrained_field() {
        // (offset, bad value)
        let cases: &[(usize, u8)] = &[
            (0, 0),                              // discriminator
            (OFF_QUOTE_MINT, 0xff),              // quote mint
            (OFF_CLIFF_FEE_NUMERATOR, 0x01),     // fee not 1%
            (OFF_SECOND_FACTOR, 1),
            (OFF_THIRD_FACTOR, 1),
            (OFF_FIRST_FACTOR, 1),
            (OFF_FIRST_FACTOR + 1, 1),
            (OFF_BASE_FEE_MODE, 1),
            (OFF_BASE_FEE_MODE, 2),
            (OFF_DYNAMIC_FEE_INITIALIZED, 1),
            (OFF_LP_VESTING, 1),                 // partner LP vesting
            (OFF_LP_VESTING + 16, 1),            // creator LP vesting
            (OFF_COLLECT_FEE_MODE, 1),
            (OFF_MIGRATION_OPTION, 0),
            (OFF_TOKEN_TYPE, 1),
            (OFF_QUOTE_TOKEN_FLAG, 1),
            (OFF_PARTNER_PERMANENT_LOCKED, 99),
            (OFF_PARTNER_LIQUIDITY, 1),
            (OFF_CREATOR_LIQUIDITY, 1),
            (OFF_CREATOR_PERMANENT_LOCKED, 1),
            (OFF_MIGRATION_FEE_OPTION, 6),
            (OFF_FIXED_SUPPLY_FLAG, 0),
            (OFF_TOKEN_UPDATE_AUTHORITY, 0),
            (OFF_TOKEN_UPDATE_AUTHORITY, 2),
            (OFF_TOKEN_UPDATE_AUTHORITY, 3),
            (OFF_MIGRATION_FEE_PCT, 1),
            (OFF_CREATOR_MIGRATION_FEE_PCT, 1),
            (OFF_LOCKED_VESTING, 1),
            (OFF_LOCKED_VESTING + 47, 1),
            (OFF_ENABLE_FIRST_SWAP_MIN_FEE, 1),
            (OFF_POOL_CREATION_FEE, 1),
        ];
        for &(off, v) in cases {
            let mut d = good_config();
            d[off] = v;
            assert_eq!(
                validate_preset(&d, 1_000_000_000),
                Err(LcError::ConfigNotSupported),
                "offset {off} value {v} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_wrong_size_and_target_at_or_above_threshold() {
        let d = good_config();
        assert!(validate_preset(&d[..CONFIG_SIZE - 1], 1).is_err());
        let mut longer = d.clone();
        longer.push(0);
        assert!(validate_preset(&longer, 1).is_err());
        assert!(validate_preset(&d, 100_000_000_000).is_err());
        assert!(validate_preset(&d, 100_000_000_001).is_err());
        assert!(validate_preset(&d, 99_999_999_999).is_ok());
    }

    #[test]
    fn unconstrained_fields_do_not_matter() {
        let mut d = good_config();
        d[40] = 0xaa; // fee_claimer
        d[72] = 0xbb; // leftover_receiver
        d[234] = 0; // activation_type
        d[235] = 9; // token_decimal
        d[245] = 0; // creator trading fee share
        d[408] = 0xcc; // curve
        assert!(validate_preset(&d, 1).is_ok());
    }
}
