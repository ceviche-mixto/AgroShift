import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

// Cliente público (anon). Las tablas de caché le niegan todo acceso por RLS.
// Perezoso: el shell y el build funcionan sin variables definidas.
export function getPublicSupabase() {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Faltan PUBLIC_SUPABASE_URL o PUBLIC_SUPABASE_ANON_KEY');
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}
