//! Arithmetic for the Rust preset fixture.

/// Adds two numbers.
pub fn add(left: u64, right: u64) -> u64 {
    left + right
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_two_numbers() {
        assert_eq!(add(2, 2), 4);
    }

    #[test]
    #[ignore = "slow"]
    fn ignored_case() {
        assert_eq!(add(0, 0), 0);
    }
}
