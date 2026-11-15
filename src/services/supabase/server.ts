import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '../env';
import type { Database } from './database.types';

let client: SupabaseClient<Database> | undefined;

/** Cliente de servidor con clave secreta y sin sesión de usuario. Nunca importar desde el navegador. */
export function getServerSupabase(): SupabaseClient<Database> {
  if (client) return client;
  const url = serverEnv('PUBLIC_SUPABASE_URL');
  const key = serverEnv('SUPABASE_SECRET_KEY');
  if (!url || !key) throw new Error('Faltan PUBLIC_SUPABASE_URL o SUPABASE_SECRET_KEY');
  client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
