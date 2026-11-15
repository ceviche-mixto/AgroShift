import { createClient } from '@supabase/supabase-js';

// Cliente público (anon). Se parametriza con `Database` en Fase 2.
// Perezoso: el shell y el build funcionan sin variables definidas.
export function getPublicSupabase() {
  const url = import.meta.env.PUBLIC_SUPABASE_URL;
  const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Faltan PUBLIC_SUPABASE_URL o PUBLIC_SUPABASE_ANON_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}
