//! Instruction data parsing. First byte is the tag; trailing bytes are rejected.
use crate::{
    error::LcError,
    state::{MAX_NAME, MAX_SYMBOL, MAX_URI},
};

#[derive(Debug, PartialEq, Eq)]
pub enum Ix<'a> {
    CreateCampaign {
        nonce: u64,
        target: u64,
        min_tokens: u64,
        close_time: i64,
        expiry: i64,
        budget_lamports: u64,
        name: &'a str,
        symbol: &'a str,
        uri: &'a str,
    },
    Contribute { amount: u64 },
    Withdraw { amount: u64 },
    Settle,
    Claim,
    Refund,
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], LcError> {
        if self.0.len() < n {
            return Err(LcError::InvalidInstructionData);
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, LcError> {
        Ok(self.take(1)?[0])
    }
    fn u64(&mut self) -> Result<u64, LcError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, LcError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// One length byte, then 1..=max bytes of UTF-8.
    fn text(&mut self, max: usize) -> Result<&'a str, LcError> {
        let n = self.u8()? as usize;
        if n == 0 || n > max {
            return Err(LcError::InvalidInstructionData);
        }
        core::str::from_utf8(self.take(n)?).map_err(|_| LcError::InvalidInstructionData)
    }
    fn end(&self) -> Result<(), LcError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(LcError::InvalidInstructionData)
        }
    }
}

pub fn parse(data: &[u8]) -> Result<Ix<'_>, LcError> {
    let mut r = Reader(data);
    let ix = match r.u8()? {
        0 => Ix::CreateCampaign {
            nonce: r.u64()?,
            target: r.u64()?,
            min_tokens: r.u64()?,
            close_time: r.i64()?,
            expiry: r.i64()?,
            budget_lamports: r.u64()?,
            name: r.text(MAX_NAME)?,
            symbol: r.text(MAX_SYMBOL)?,
            uri: r.text(MAX_URI)?,
        },
        1 => Ix::Contribute { amount: r.u64()? },
        2 => Ix::Withdraw { amount: r.u64()? },
        3 => Ix::Settle,
        4 => Ix::Claim,
        5 => Ix::Refund,
        _ => return Err(LcError::InvalidInstructionData),
    };
    r.end()?;
    Ok(ix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_bytes(name: &[u8], symbol: &[u8], uri: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8];
        for v in [1u64, 2, 3] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        for v in [4i64, 5] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(&6u64.to_le_bytes());
        for t in [name, symbol, uri] {
            d.push(t.len() as u8);
            d.extend_from_slice(t);
        }
        d
    }

    #[test]
    fn parses_create() {
        let d = create_bytes(b"Name", b"SYM", b"https://x/y.json");
        assert_eq!(
            parse(&d).unwrap(),
            Ix::CreateCampaign {
                nonce: 1,
                target: 2,
                min_tokens: 3,
                close_time: 4,
                expiry: 5,
                budget_lamports: 6,
                name: "Name",
                symbol: "SYM",
                uri: "https://x/y.json"
            }
        );
    }

    #[test]
    fn rejects_bad_text_lengths_and_utf8() {
        assert!(parse(&create_bytes(b"", b"S", b"u")).is_err());
        assert!(parse(&create_bytes(&[b'a'; 33], b"S", b"u")).is_err());
        assert!(parse(&create_bytes(b"N", &[b'a'; 11], b"u")).is_err());
        assert!(parse(&create_bytes(b"N", b"S", &[b'a'; 201])).is_err());
        assert!(parse(&create_bytes(&[0xff, 0xfe], b"S", b"u")).is_err());
        assert!(parse(&create_bytes(&[b'a'; 32], &[b'a'; 10], &[b'a'; 200])).is_ok());
    }

    #[test]
    fn simple_instructions_and_trailing_bytes() {
        let mut d = vec![1u8];
        d.extend_from_slice(&9u64.to_le_bytes());
        assert_eq!(parse(&d).unwrap(), Ix::Contribute { amount: 9 });
        d[0] = 2;
        assert_eq!(parse(&d).unwrap(), Ix::Withdraw { amount: 9 });
        d.push(0);
        assert!(parse(&d).is_err());
        assert_eq!(parse(&[3]).unwrap(), Ix::Settle);
        assert_eq!(parse(&[4]).unwrap(), Ix::Claim);
        assert_eq!(parse(&[5]).unwrap(), Ix::Refund);
        assert!(parse(&[3, 0]).is_err());
        assert!(parse(&[6]).is_err());
        assert!(parse(&[]).is_err());
        assert!(parse(&[1, 0, 0]).is_err());
    }
}
