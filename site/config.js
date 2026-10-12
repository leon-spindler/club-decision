// Shared ratings backend (Supabase free tier). Fill both in — see README.
// The anon key is meant to be public; access is limited by the table's RLS policies.
// Leave empty to run in local-only mode (ratings stay in your own browser).
window.CONFIG = {
  SUPABASE_URL: "https://mqwqqajotkyrcwwfjwbg.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_x7cMtzKxJVWZ9aSCtJvxQA_jWystJet",
};
