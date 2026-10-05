//! Pro-rata allocation. All intermediates are u128; results are floored.

/// floor(a * b / d), or None when d is zero or the result does not fit in u64.
pub fn mul_div_floor(a: u64, b: u64, d: u64) -> Option<u64> {
    if d == 0 {
        return None;
    }
    let v = (a as u128).checked_mul(b as u128)? / (d as u128);
    u64::try_from(v).ok()
}

/// Tokens and excess lamports owed to one receipt after settlement.
///
/// excess is floor(c * (total - target) / total), never c - floor(c * target / total):
/// the latter can sum to more than the vault holds.
pub fn allocation(contribution: u64, total: u64, target: u64, bought: u64) -> Option<(u64, u64)> {
    if total < target || contribution > total {
        return None;
    }
    let tokens = mul_div_floor(contribution, bought, total)?;
    let excess = mul_div_floor(contribution, total - target, total)?;
    Some((tokens, excess))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
    }

    #[test]
    fn exact_when_not_oversubscribed() {
        let (t, e) = allocation(40, 100, 100, 1_000).unwrap();
        assert_eq!((t, e), (400, 0));
    }

    #[test]
    fn rejects_inconsistent_inputs() {
        assert!(allocation(1, 99, 100, 10).is_none());
        assert!(allocation(101, 100, 100, 10).is_none());
        assert!(mul_div_floor(1, 1, 0).is_none());
    }

    #[test]
    fn extremes_do_not_overflow() {
        let m = u64::MAX;
        assert_eq!(allocation(m, m, m, m), Some((m, 0)));
        assert_eq!(allocation(m, m, 1, m), Some((m, m - 1)));
    }

    #[test]
    fn randomised_conservation() {
        let mut rng = Lcg(0x5eed);
        for round in 0..2_000 {
            let n = 1 + (rng.next() % 40) as usize;
            let scale = [10u64, 1_000, 1_000_000_000, 5_000_000_000_000][round % 4];
            let parts: Vec<u64> = (0..n).map(|_| 1 + rng.next() % scale).collect();
            let total: u64 = parts.iter().sum();
            let target = 1 + rng.next() % total;
            let bought = 1 + rng.next() % 1_000_000_000_000_000_000;
            let mut tokens = 0u128;
            let mut excess = 0u128;
            for &c in &parts {
                let (t, e) = allocation(c, total, target, bought).unwrap();
                // nobody is charged more than they put in
                assert!(e <= c);
                tokens += t as u128;
                excess += e as u128;
            }
            assert!(tokens <= bought as u128);
            assert!(excess <= (total - target) as u128);
            // dust is strictly less than one unit per receipt
            assert!(bought as u128 - tokens < n as u128);
            assert!((total - target) as u128 - excess < n as u128);
        }
    }
}
