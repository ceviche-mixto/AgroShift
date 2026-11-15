interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly NASA_API_KEY?: string;
  readonly EARTHDATA_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
