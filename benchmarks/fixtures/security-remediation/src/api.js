// FORGE benchmark fixture (security-remediation): TWO intentional, real vulnerability
// patterns for FORGE to find and fix. DISPOSABLE fixture; never a real project — do not
// point any real secret scanner at forge-2 itself expecting this to be an actual leak.

// VULN 1: hardcoded secret committed straight into source.
const STRIPE_SECRET_KEY = 'sk_live_51H8x9fFAKEBENCHMARKSECRETKEYDONOTUSE00000000';

// VULN 2: SQL injection — user input concatenated directly into the query string.
export function findUserByEmail(db, email) {
  const sql = "SELECT * FROM users WHERE email = '" + email + "'"; // BUG: unparameterized
  return db.query(sql);
}

export function getStripeKey() {
  return STRIPE_SECRET_KEY; // BUG: should come from process.env, never from source
}
