//! A module's own saved records for one server (the `module_data` table), read and written the way Good Boy 3 does.

use crate::Db;
use serde_json::Value;

pub struct Data<'a> {
    pub db: &'a Db,
    pub guild: &'a str,
    pub module: &'static str,
}
impl Data<'_> {
    pub fn get(&self, key: &str) -> Option<Value> {
        self.db.get().data_get(self.guild, self.module, key).ok().flatten()
    }
    pub fn set(&self, key: &str, value: &Value) {
        let _ = self.db.get().data_set(self.guild, self.module, key, value);
    }
    pub fn delete(&self, key: &str) {
        let _ = self.db.get().data_delete(self.guild, self.module, key);
    }
    pub fn list(&self, prefix: &str) -> Vec<(String, Value)> {
        self.db.get().data_list(self.guild, self.module, prefix, 10_000).unwrap_or_default()
    }
    /// Adds one to a counter and gives the new number (case numbers, reminder numbers).
    pub fn next(&self, key: &str) -> i64 {
        let n = self.get(key).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        self.set(key, &Value::from(n));
        n
    }
    pub fn add(&self, key: &str, by: i64) -> i64 {
        let n = self.get(key).and_then(|v| v.as_i64()).unwrap_or(0) + by;
        self.set(key, &Value::from(n));
        n
    }
}
