// Generado con Supabase MCP `generate_typescript_types` (proyecto AgroShift,
// migración 20261115031834_agroshift_cache). Regenerar tras cada migración.
// Se omiten los genéricos auxiliares (Tables, Enums…) porque no se usan.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      climate_cache: {
        Row: {
          cell_id: string
          created_at: string
          expires_at: string | null
          id: number
          observed_until: string | null
          payload: Json | null
          product_version: string
          refresh_expires_at: string | null
          refresh_holder: string | null
          retrieved_at: string | null
          schema_version: number
          source: string
          updated_at: string
          usable_until: string | null
          window_end: string
          window_start: string
        }
        Insert: {
          cell_id: string
          created_at?: string
          expires_at?: string | null
          id?: never
          observed_until?: string | null
          payload?: Json | null
          product_version: string
          refresh_expires_at?: string | null
          refresh_holder?: string | null
          retrieved_at?: string | null
          schema_version: number
          source: string
          updated_at?: string
          usable_until?: string | null
          window_end: string
          window_start: string
        }
        Update: {
          cell_id?: string
          created_at?: string
          expires_at?: string | null
          id?: never
          observed_until?: string | null
          payload?: Json | null
          product_version?: string
          refresh_expires_at?: string | null
          refresh_holder?: string | null
          retrieved_at?: string | null
          schema_version?: number
          source?: string
          updated_at?: string
          usable_until?: string | null
          window_end?: string
          window_start?: string
        }
        Relationships: []
      }
      crop_cache: {
        Row: {
          cell_id: string
          created_at: string
          crop_id: string
          engine_version: string
          evidence_version: string
          expires_at: string
          id: number
          inputs_signature: string
          payload: Json
          period_end: string
          period_start: string
          retrieved_at: string
          updated_at: string
          usable_until: string
        }
        Insert: {
          cell_id: string
          created_at?: string
          crop_id: string
          engine_version: string
          evidence_version: string
          expires_at: string
          id?: never
          inputs_signature?: string
          payload: Json
          period_end: string
          period_start: string
          retrieved_at?: string
          updated_at?: string
          usable_until: string
        }
        Update: {
          cell_id?: string
          created_at?: string
          crop_id?: string
          engine_version?: string
          evidence_version?: string
          expires_at?: string
          id?: never
          inputs_signature?: string
          payload?: Json
          period_end?: string
          period_start?: string
          retrieved_at?: string
          updated_at?: string
          usable_until?: string
        }
        Relationships: []
      }
      request_budget: {
        Row: {
          expires_at: string
          interval_start: string
          operation: string
          updated_at: string
          used: number
        }
        Insert: {
          expires_at: string
          interval_start: string
          operation: string
          updated_at?: string
          used: number
        }
        Update: {
          expires_at?: string
          interval_start?: string
          operation?: string
          updated_at?: string
          used?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_climate_refresh: {
        Args: {
          p_cell_id: string
          p_force?: boolean
          p_holder: string
          p_lease_seconds: number
          p_product_version: string
          p_schema_version: number
          p_source: string
          p_window_end: string
          p_window_start: string
        }
        Returns: number
      }
      consume_request_budget: {
        Args: {
          p_interval_seconds: number
          p_limit: number
          p_operation: string
        }
        Returns: boolean
      }
      publish_climate_refresh: {
        Args: {
          p_expires_at: string
          p_holder: string
          p_id: number
          p_observed_until: string
          p_payload: Json
          p_retrieved_at: string
          p_usable_until: string
        }
        Returns: boolean
      }
      purge_agroshift_cache: { Args: never; Returns: undefined }
      release_climate_refresh: {
        Args: { p_holder: string; p_id: number }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
