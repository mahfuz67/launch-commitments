//! Fixed little-endian account layouts (see INTERFACE.md).
use crate::error::LcError;
use solana_program::pubkey::Pubkey;

pub const CAMPAIGN_TAG: [u8; 8] = *b"LCCAMP01";
pub const RECEIPT_TAG: [u8; 8] = *b"LCRCPT01";
pub const CAMPAIGN_SIZE: usize = 568;
pub const RECEIPT_SIZE: usize = 88;
pub const VERSION: u8 = 1;

pub const STATE_OPEN: u8 = 1;
pub const STATE_SETTLED: u8 = 2;

pub const MAX_NAME: usize = 32;
pub const MAX_SYMBOL: usize = 10;
pub const MAX_URI: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Campaign {
    pub state: u8,
    pub bump_campaign: u8,
    pub bump_vault: u8,
    pub bump_budget: u8,
    pub bump_mint: u8,
    pub name_len: u8,
    pub symbol_len: u8,
    pub uri_len: u8,
    pub organizer: Pubkey,
    pub nonce: u64,
    pub beneficiary: Pubkey,
    pub config: Pubkey,
    pub config_hash: [u8; 32],
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub target: u64,
    pub min_tokens: u64,
    pub close_time: i64,
    pub expiry: i64,
    pub total_contributed: u64,
    pub receipt_count: u64,
    pub tokens_bought: u64,
    pub settled_at: i64,
    pub tokens_claimed: u64,
    pub excess_paid: u64,
    pub refunded: u64,
    pub created_at: i64,
    pub name: [u8; MAX_NAME],
    pub symbol: [u8; MAX_SYMBOL],
    pub uri: [u8; MAX_URI],
}

fn key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn i64_at(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

impl Campaign {
    pub fn unpack(d: &[u8]) -> Result<Self, LcError> {
        if d.len() != CAMPAIGN_SIZE || d[..8] != CAMPAIGN_TAG || d[8] != VERSION {
            return Err(LcError::InvalidAccountData);
        }
        let c = Campaign {
            state: d[9],
            bump_campaign: d[10],
            bump_vault: d[11],
            bump_budget: d[12],
            bump_mint: d[13],
            name_len: d[14],
            symbol_len: d[15],
            uri_len: d[16],
            organizer: key(d, 24),
            nonce: u64_at(d, 56),
            beneficiary: key(d, 64),
            config: key(d, 96),
            config_hash: d[128..160].try_into().unwrap(),
            mint: key(d, 160),
            token_account: key(d, 192),
            target: u64_at(d, 224),
            min_tokens: u64_at(d, 232),
            close_time: i64_at(d, 240),
            expiry: i64_at(d, 248),
            total_contributed: u64_at(d, 256),
            receipt_count: u64_at(d, 264),
            tokens_bought: u64_at(d, 272),
            settled_at: i64_at(d, 280),
            tokens_claimed: u64_at(d, 288),
            excess_paid: u64_at(d, 296),
            refunded: u64_at(d, 304),
            created_at: i64_at(d, 312),
            name: d[320..352].try_into().unwrap(),
            symbol: d[352..362].try_into().unwrap(),
            uri: d[362..562].try_into().unwrap(),
        };
        if (c.state != STATE_OPEN && c.state != STATE_SETTLED)
            || c.name_len as usize > MAX_NAME
            || c.symbol_len as usize > MAX_SYMBOL
            || c.uri_len as usize > MAX_URI
        {
            return Err(LcError::InvalidAccountData);
        }
        Ok(c)
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), LcError> {
        if d.len() != CAMPAIGN_SIZE {
            return Err(LcError::InvalidAccountData);
        }
        d.fill(0);
        d[..8].copy_from_slice(&CAMPAIGN_TAG);
        d[8] = VERSION;
        d[9] = self.state;
        d[10] = self.bump_campaign;
        d[11] = self.bump_vault;
        d[12] = self.bump_budget;
        d[13] = self.bump_mint;
        d[14] = self.name_len;
        d[15] = self.symbol_len;
        d[16] = self.uri_len;
        d[24..56].copy_from_slice(&self.organizer.to_bytes());
        d[56..64].copy_from_slice(&self.nonce.to_le_bytes());
        d[64..96].copy_from_slice(&self.beneficiary.to_bytes());
        d[96..128].copy_from_slice(&self.config.to_bytes());
        d[128..160].copy_from_slice(&self.config_hash);
        d[160..192].copy_from_slice(&self.mint.to_bytes());
        d[192..224].copy_from_slice(&self.token_account.to_bytes());
        d[224..232].copy_from_slice(&self.target.to_le_bytes());
        d[232..240].copy_from_slice(&self.min_tokens.to_le_bytes());
        d[240..248].copy_from_slice(&self.close_time.to_le_bytes());
        d[248..256].copy_from_slice(&self.expiry.to_le_bytes());
        d[256..264].copy_from_slice(&self.total_contributed.to_le_bytes());
        d[264..272].copy_from_slice(&self.receipt_count.to_le_bytes());
        d[272..280].copy_from_slice(&self.tokens_bought.to_le_bytes());
        d[280..288].copy_from_slice(&self.settled_at.to_le_bytes());
        d[288..296].copy_from_slice(&self.tokens_claimed.to_le_bytes());
        d[296..304].copy_from_slice(&self.excess_paid.to_le_bytes());
        d[304..312].copy_from_slice(&self.refunded.to_le_bytes());
        d[312..320].copy_from_slice(&self.created_at.to_le_bytes());
        d[320..352].copy_from_slice(&self.name);
        d[352..362].copy_from_slice(&self.symbol);
        d[362..562].copy_from_slice(&self.uri);
        Ok(())
    }

    pub fn funding_open(&self, now: i64) -> bool {
        self.state == STATE_OPEN && now < self.close_time
    }

    /// Underfunded at close, or unsettled at expiry.
    pub fn refundable(&self, now: i64) -> bool {
        self.state == STATE_OPEN
            && ((now >= self.close_time && self.total_contributed < self.target) || now >= self.expiry)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub campaign: Pubkey,
    pub contributor: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl Receipt {
    pub fn unpack(d: &[u8]) -> Result<Self, LcError> {
        if d.len() != RECEIPT_SIZE || d[..8] != RECEIPT_TAG {
            return Err(LcError::InvalidAccountData);
        }
        Ok(Receipt { campaign: key(d, 8), contributor: key(d, 40), amount: u64_at(d, 72), bump: d[80] })
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), LcError> {
        if d.len() != RECEIPT_SIZE {
            return Err(LcError::InvalidAccountData);
        }
        d.fill(0);
        d[..8].copy_from_slice(&RECEIPT_TAG);
        d[8..40].copy_from_slice(&self.campaign.to_bytes());
        d[40..72].copy_from_slice(&self.contributor.to_bytes());
        d[72..80].copy_from_slice(&self.amount.to_le_bytes());
        d[80] = self.bump;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Campaign {
        let mut name = [0u8; MAX_NAME];
        name[..4].copy_from_slice(b"Test");
        let mut symbol = [0u8; MAX_SYMBOL];
        symbol[..3].copy_from_slice(b"TST");
        let mut uri = [0u8; MAX_URI];
        uri[..5].copy_from_slice(b"ipfs:");
        Campaign {
            state: STATE_OPEN,
            bump_campaign: 255,
            bump_vault: 254,
            bump_budget: 253,
            bump_mint: 252,
            name_len: 4,
            symbol_len: 3,
            uri_len: 5,
            organizer: Pubkey::new_from_array([1; 32]),
            nonce: 42,
            beneficiary: Pubkey::new_from_array([2; 32]),
            config: Pubkey::new_from_array([3; 32]),
            config_hash: [4; 32],
            mint: Pubkey::new_from_array([5; 32]),
            token_account: Pubkey::new_from_array([6; 32]),
            target: 10,
            min_tokens: 11,
            close_time: 100,
            expiry: 200,
            total_contributed: 12,
            receipt_count: 13,
            tokens_bought: 14,
            settled_at: 15,
            tokens_claimed: 16,
            excess_paid: 17,
            refunded: 18,
            created_at: 19,
            name,
            symbol,
            uri,
        }
    }

    #[test]
    fn campaign_round_trip_and_offsets() {
        let c = sample();
        let mut d = vec![0xffu8; CAMPAIGN_SIZE];
        c.pack(&mut d).unwrap();
        assert_eq!(Campaign::unpack(&d).unwrap(), c);
        // offsets promised in INTERFACE.md
        assert_eq!(&d[..8], b"LCCAMP01");
        assert_eq!(d[9], STATE_OPEN);
        assert_eq!(u64_at(&d, 56), 42);
        assert_eq!(u64_at(&d, 224), 10);
        assert_eq!(u64_at(&d, 232), 11);
        assert_eq!(i64_at(&d, 240), 100);
        assert_eq!(i64_at(&d, 248), 200);
        assert_eq!(u64_at(&d, 256), 12);
        assert_eq!(u64_at(&d, 272), 14);
        assert_eq!(&d[320..324], b"Test");
        assert_eq!(&d[352..355], b"TST");
        assert_eq!(&d[362..367], b"ipfs:");
        assert!(d[562..].iter().all(|b| *b == 0));
    }

    #[test]
    fn campaign_rejects_bad_tag_size_state() {
        let mut d = vec![0u8; CAMPAIGN_SIZE];
        sample().pack(&mut d).unwrap();
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert!(Campaign::unpack(&bad).is_err());
        let mut bad = d.clone();
        bad[9] = 0;
        assert!(Campaign::unpack(&bad).is_err());
        let mut bad = d.clone();
        bad[8] = 2;
        assert!(Campaign::unpack(&bad).is_err());
        assert!(Campaign::unpack(&d[..CAMPAIGN_SIZE - 1]).is_err());
        // a receipt is never a campaign
        assert!(Campaign::unpack(&vec![0u8; RECEIPT_SIZE]).is_err());
    }

    #[test]
    fn phase_boundaries() {
        let mut c = sample(); // close 100, expiry 200, target 10, total 12
        assert!(c.funding_open(99));
        assert!(!c.funding_open(100));
        // funded: not refundable until expiry
        assert!(!c.refundable(100));
        assert!(!c.refundable(199));
        assert!(c.refundable(200));
        // underfunded: refundable from close
        c.total_contributed = 9;
        assert!(!c.refundable(99));
        assert!(c.refundable(100));
        // settled: never refundable, never open
        c.state = STATE_SETTLED;
        assert!(!c.refundable(1_000));
        assert!(!c.funding_open(0));
    }

    #[test]
    fn receipt_round_trip() {
        let r = Receipt { campaign: Pubkey::new_from_array([9; 32]), contributor: Pubkey::new_from_array([8; 32]), amount: 77, bump: 250 };
        let mut d = vec![0xffu8; RECEIPT_SIZE];
        r.pack(&mut d).unwrap();
        assert_eq!(Receipt::unpack(&d).unwrap(), r);
        assert_eq!(u64_at(&d, 72), 77);
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert!(Receipt::unpack(&bad).is_err());
        assert!(Receipt::unpack(&vec![0u8; CAMPAIGN_SIZE]).is_err());
    }
}
