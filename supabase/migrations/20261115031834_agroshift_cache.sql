-- agroshift_cache: caché compartida de evidencia científica y derivados genéricos.
-- Sin datos personales: las respuestas de la parcela permanecen en el navegador.
-- Solo el servidor (service_role) lee y escribe. anon y authenticated quedan sin acceso.

create table public.climate_cache (
  id bigint generated always as identity primary key,
  source text not null check (source in ('power', 'smap', 'giovanni', 'firms', 'complement')),
  product_version text not null,
  schema_version integer not null,
  cell_id text not null,
  window_start date not null,
  window_end date not null,
  -- null = fila reservada por una concesión de refresco, todavía sin datos
  payload jsonb,
  observed_until date,
  retrieved_at timestamptz,
  expires_at timestamptz,
  -- último uso permitido como instantánea previa
  usable_until timestamptz,
  refresh_holder uuid,
  refresh_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint climate_cache_key
    unique (source, product_version, schema_version, cell_id, window_start, window_end),
  constraint climate_cache_window check (window_start <= window_end),
  constraint climate_cache_filled check (
    payload is null
    or (retrieved_at is not null and expires_at is not null and usable_until is not null
        and expires_at <= usable_until)
  )
);
create index climate_cache_cleanup on public.climate_cache (usable_until);

create table public.crop_cache (
  id bigint generated always as identity primary key,
  cell_id text not null,
  crop_id text not null,
  period_start date not null,
  period_end date not null,
  engine_version text not null,
  evidence_version text not null,
  -- firma de versiones de insumos públicos que afectan el resultado
  inputs_signature text not null default '',
  payload jsonb not null,
  retrieved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  usable_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crop_cache_key
    unique (cell_id, crop_id, period_start, period_end, engine_version, evidence_version, inputs_signature),
  constraint crop_cache_period check (period_start <= period_end),
  constraint crop_cache_expiry check (expires_at <= usable_until)
);
create index crop_cache_cleanup on public.crop_cache (usable_until);

create table public.request_budget (
  operation text not null,
  interval_start timestamptz not null,
  used integer not null check (used >= 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (operation, interval_start)
);
create index request_budget_cleanup on public.request_budget (expires_at);

-- Concesión atómica de refresco por clave. Devuelve el id de la fila o null si otra
-- instancia tiene la concesión vigente, o si el dato sigue vigente y no se fuerza.
create function public.acquire_climate_refresh(
  p_source text,
  p_product_version text,
  p_schema_version integer,
  p_cell_id text,
  p_window_start date,
  p_window_end date,
  p_holder uuid,
  p_lease_seconds integer,
  p_force boolean default false
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_holder is null or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 900 then
    raise exception 'concesion invalida';
  end if;
  insert into public.climate_cache as c
    (source, product_version, schema_version, cell_id, window_start, window_end,
     refresh_holder, refresh_expires_at)
  values
    (p_source, p_product_version, p_schema_version, p_cell_id, p_window_start, p_window_end,
     p_holder, now() + make_interval(secs => p_lease_seconds))
  on conflict on constraint climate_cache_key do update
    set refresh_holder = excluded.refresh_holder,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at = now()
    where (c.refresh_expires_at is null or c.refresh_expires_at <= now())
      and (coalesce(p_force, false) or c.expires_at is null or c.expires_at <= now())
  returning c.id into v_id;
  return v_id;
end;
$$;

-- Publica y libera solo si p_holder es el titular de la concesión vigente.
-- Conserva la observación más reciente: un dato más antiguo no reemplaza al guardado.
create function public.publish_climate_refresh(
  p_id bigint,
  p_holder uuid,
  p_payload jsonb,
  p_observed_until date,
  p_retrieved_at timestamptz,
  p_expires_at timestamptz,
  p_usable_until timestamptz
) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_payload is null then
    raise exception 'payload requerido';
  end if;
  update public.climate_cache c
     set refresh_holder = null, refresh_expires_at = null, updated_at = now()
   where c.id = p_id and c.refresh_holder = p_holder and c.refresh_expires_at > now();
  if not found then
    return false;
  end if;
  update public.climate_cache c
     set payload = p_payload,
         observed_until = p_observed_until,
         retrieved_at = p_retrieved_at,
         expires_at = p_expires_at,
         usable_until = p_usable_until
   where c.id = p_id
     and (c.payload is null
          or coalesce(p_observed_until, '-infinity'::date) >= coalesce(c.observed_until, '-infinity'::date));
  return true;
end;
$$;

create function public.release_climate_refresh(p_id bigint, p_holder uuid) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.climate_cache c
     set refresh_holder = null, refresh_expires_at = null, updated_at = now()
   where c.id = p_id and c.refresh_holder = p_holder;
  return found;
end;
$$;

-- Presupuesto compartido por operación e intervalo. true = queda cupo y se contó.
create function public.consume_request_budget(
  p_operation text,
  p_interval_seconds integer,
  p_limit integer
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_start timestamptz;
begin
  if p_operation is null or p_interval_seconds is null or p_interval_seconds < 1
     or p_limit is null or p_limit < 1 then
    return false;
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_interval_seconds) * p_interval_seconds);
  insert into public.request_budget as b (operation, interval_start, used, expires_at)
  values (p_operation, v_start, 1, v_start + make_interval(secs => p_interval_seconds * 2))
  on conflict (operation, interval_start) do update
    set used = b.used + 1, updated_at = now()
    where b.used < p_limit;
  return found;
end;
$$;

create function public.purge_agroshift_cache() returns void
language sql
set search_path = ''
as $$
  delete from public.climate_cache
   where (refresh_expires_at is null or refresh_expires_at <= now())
     and (usable_until < now() or (payload is null and updated_at < now() - interval '1 hour'));
  delete from public.crop_cache where usable_until < now();
  delete from public.request_budget where expires_at < now();
$$;

alter table public.climate_cache enable row level security;
alter table public.crop_cache enable row level security;
alter table public.request_budget enable row level security;

revoke all on table public.climate_cache, public.crop_cache, public.request_budget
  from public, anon, authenticated;
grant select, insert, update, delete on table public.climate_cache, public.crop_cache, public.request_budget
  to service_role;

create policy climate_cache_deny_public on public.climate_cache
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy crop_cache_deny_public on public.crop_cache
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy request_budget_deny_public on public.request_budget
  as restrictive for all to anon, authenticated using (false) with check (false);

revoke execute on function
  public.acquire_climate_refresh(text, text, integer, text, date, date, uuid, integer, boolean),
  public.publish_climate_refresh(bigint, uuid, jsonb, date, timestamptz, timestamptz, timestamptz),
  public.release_climate_refresh(bigint, uuid),
  public.consume_request_budget(text, integer, integer),
  public.purge_agroshift_cache()
  from public, anon, authenticated;
grant execute on function
  public.acquire_climate_refresh(text, text, integer, text, date, date, uuid, integer, boolean),
  public.publish_climate_refresh(bigint, uuid, jsonb, date, timestamptz, timestamptz, timestamptz),
  public.release_climate_refresh(bigint, uuid),
  public.consume_request_budget(text, integer, integer),
  public.purge_agroshift_cache()
  to service_role;
