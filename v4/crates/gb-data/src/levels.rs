//! Levels from XP: the same rule as Good Boy 3 (`levelOf` in the community module), so nobody's level changes.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Level {
    /// The level reached.
    pub level: u32,
    /// XP earned inside this level so far.
    pub into: i64,
    /// XP this level needs in total.
    pub needed: i64,
}

/// XP needed to go from `level` to `level + 1`.
fn need(level: u32) -> i64 {
    let l = level as i64;
    5 * l * l + 50 * l + 100
}

pub fn level_of(total_xp: i64) -> Level {
    let (mut level, mut rem) = (0u32, total_xp.max(0));
    while level < 1000 && rem >= need(level) {
        rem -= need(level);
        level += 1;
    }
    Level { level, into: rem, needed: need(level) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_first_levels() {
        assert_eq!(level_of(0), Level { level: 0, into: 0, needed: 100 });
        assert_eq!(level_of(99).level, 0);
        assert_eq!(level_of(100), Level { level: 1, into: 0, needed: 155 });
        assert_eq!(level_of(-5).level, 0);
    }
}
