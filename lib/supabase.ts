import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || supabaseServiceKey;

function assertSupabaseEnv() {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[supabase] Missing env:', {
      url: !!supabaseUrl,
      key: !!supabaseServiceKey,
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    });
    throw new Error('Missing Supabase environment variables');
  }
}

const fallbackUrl = 'https://example.supabase.co';
const fallbackKey = 'build-time-placeholder-key';

// Service-side client. API routes validate env at request time, while Next build
// can still import this module during route analysis.
export const supabaseAdmin = createClient(supabaseUrl || fallbackUrl, supabaseServiceKey || fallbackKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  },
  global: {
    fetch: async (input, init) => {
      assertSupabaseEnv();
      return fetch(input, init);
    }
  }
});

export const supabaseAnon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || fallbackUrl,
  supabaseAnonKey || fallbackKey
);

export function isProjectPoolV2Enabled() {
  return process.env.PROJECT_POOL_V2_ENABLED === 'true';
}
