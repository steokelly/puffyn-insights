import { createClient } from '@supabase/supabase-js';

// This uses the SERVICE ROLE key, not the public/anon key.
// The service role key bypasses Row Level Security, which is correct here
// because this code only ever runs on the server (never in the browser),
// and it's the only thing that should be allowed to write to `episodes`.
export function getSupabaseServerClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
