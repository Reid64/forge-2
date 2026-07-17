/**
 * Hand-written Supabase Postgres schema types for forge-2's web console.
 *
 * Scope: `profiles` only. gap_audit_runs / artifact_health_scores are NOT
 * Postgres tables -- they live in the Build Memory SQLite file and are read
 * via src/learning/database.ts, never via the Supabase client (see
 * governance/BEHAVIORAL_CONTRACTS.md API Contracts conventions).
 *
 * Shape matches what `supabase gen types typescript` emits, since
 * @supabase/supabase-js's generic helpers key off `Relationships` /
 * `Views` / `Functions` / `Enums` / `CompositeTypes` being present.
 */
export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: string;
          created_at: string;
        };
        Insert: {
          id: string;
          role?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          role?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
