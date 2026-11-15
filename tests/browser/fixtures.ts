import chiclayo from '../../src/data/nasa/chiclayo.json' with { type: 'json' };
import india from '../../src/data/nasa/india.json' with { type: 'json' };
import kenia from '../../src/data/nasa/kenia.json' with { type: 'json' };
import type { AnalyzeResponse, FarmInput } from '../../src/domain/contracts.ts';
import { computeLocal } from '../../src/services/browser/local.ts';
import type { Snapshot } from '../../src/services/nasa/match.ts';

// Reloj fijo: la ventana de referencia es 2025, la de las instantáneas reales.
export const NOW = new Date('2026-11-15T12:00:00Z');
export const SNAPSHOTS: Snapshot[] = [chiclayo, india, kenia];
export const FILES = { chiclayo, india, kenia };

export const CASES = [
  { name: 'Chiclayo', lat: -6.77, lon: -79.84 },
  { name: 'India', lat: 12.97, lon: 77.59 },
  { name: 'Kenia', lat: -1.29, lon: 36.82 },
] as const;

export const farm = (lat: number, lon: number, extra: Partial<FarmInput> = {}): FarmInput => ({
  location: { lat, lon, origin: 'manual_coordinates', accuracyM: null },
  crop: { status: 'known', stage: 'last_harvested', name: 'Maíz' },
  goal: 'next_crop',
  water: 'enough',
  planting: { status: 'known', date: '2027-03-01', precision: 'day' },
  ...extra,
});

export const OUTSIDE = farm(40.4, -3.7); // sin cobertura local

export function responseFor(input: FarmInput): AnalyzeResponse {
  const r = computeLocal(input, SNAPSHOTS, NOW);
  if (!r) throw new Error('fixture sin cobertura');
  return r;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Sirve los JSON científicos como lo haría /data/nasa/<nombre>.json. */
export function serveData(url: string): Response | null {
  const name = /\/data\/nasa\/(\w+)\.json$/.exec(url)?.[1] as keyof typeof FILES | undefined;
  return name && FILES[name] ? json(200, FILES[name]) : null;
}
