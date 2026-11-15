import type { APIRoute, GetStaticPaths } from 'astro';
import chiclayo from '../../../data/nasa/chiclayo.json' with { type: 'json' };
import india from '../../../data/nasa/india.json' with { type: 'json' };
import kenia from '../../../data/nasa/kenia.json' with { type: 'json' };

// Sirve cada instantánea científica como archivo estático /data/nasa/<nombre>.json (sin duplicarla en public/).
// El navegador las pide para calcular sin red (src/services/browser/local.ts) y el service worker las guarda.
const FILES = { chiclayo, india, kenia } as const;

export const getStaticPaths: GetStaticPaths = () => Object.keys(FILES).map((name) => ({ params: { name } }));

export const GET: APIRoute = ({ params }) =>
  new Response(JSON.stringify(FILES[params.name as keyof typeof FILES]), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
