# AgroShift

**Team OneCtrl** · NASA Space Apps Challenge 2026 · Challenge: *Field Shift: Adapting Farms with NASA Data*

Live app: <https://agroshift-mu.vercel.app> · Source: <https://github.com/ceviche-mixto/AgroShift> · License: [Apache 2.0](LICENSE)

AgroShift helps a small or medium farmer decide **what to plant next**. The farmer answers five short
questions (location, current or last crop, goal, available water, planting date) and gets **two options
side by side**: a main plan (Plan A) and a contingency plan (Plan B) for a drier or water-limited scenario.
Each statement in the result is traceable to a NASA dataset or to a documented agronomy rule. The app is
designed for people with no technical background, low-cost phones and weak connectivity.

The interface is available in **English (default)** and **Spanish**. Use the `EN | ES` switch in the header
or footer; the choice is remembered in the browser.

## Team

| Member |
| --- |
| Giancarlo Luciano Larios Infantes |
| Enzo Gabriel García Infantes |
| Sergio Anibal Tuesta Rodas |

## How it works

```
Farmer (5-step quiz, EN/ES)
        │
        ▼
  /api/analyze ──► NASA data layer ──► evidence records (value, unit, period, grid, license, limits)
        │              │  POWER · SMAP · Giovanni · FIRMS
        │              └─ Supabase: shared cache + request budget  ──► bundled NASA snapshots (offline)
        ▼
  Deterministic engine (src/domain): crop catalog (FAO ECOCROP) + rotation, thermal and rainfall rules
        │
        ▼
  Plan A + Plan B, each with reasons, restrictions, actions and "what to check"
        │
        ▼
  /api/explain (optional): Amazon Bedrock only *selects* which engine facts answer the farmer's question;
  the visible sentence always comes from templates, so the model cannot add new claims.
```

Key design decisions:

- **The engine is not generative.** Recommendations come from explicit, versioned rules and the NASA evidence.
  Generative AI never writes agronomic advice.
- **Honest about uncertainty.** Hypothetical scenarios are labelled "Assumption: not a forecast"; stale or
  missing data is shown with a neutral state instead of a false alarm (for example, when FIRMS is unavailable).
- **Works offline.** A service worker stores the pages, scripts and NASA snapshots for three demo regions
  (Peru, India, Kenya). Without internet the plan is computed on the device; plans can be saved locally.
- **Accessible by default.** Touch targets of at least 48 px, step-by-step quiz, WCAG-contrast color tokens
  (checked in tests), reduced-motion and forced-colors support, status shown with symbol + text + border.

## NASA data and resources

| Resource | Use in AgroShift |
| --- | --- |
| [NASA POWER](https://power.larc.nasa.gov/) (Daily API, AG community) | Temperature, rainfall, humidity and solar radiation of the reference year |
| [NASA SMAP L4](https://doi.org/10.5067/T5RUATAQREF8) (SPL4SMGP v008, NSIDC DAAC), via [AppEEARS](https://appeears.earthdatacloud.nasa.gov/) | Surface and root-zone soil moisture |
| [NASA Giovanni](https://giovanni.gsfc.nasa.gov/giovanni/) with [GLDAS Noah L4](https://doi.org/10.5067/E7TYRXPJKWOQ) (GES DISC) | Air temperature anomaly and trend |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) (VIIRS NOAA-20, near real time) | Nearby heat-spot detections (alert, not a confirmed fire) |
| [NASA Earthdata](https://www.earthdata.nasa.gov/) | Earthdata Login credentials used by the ingestion scripts and data services |

Other data and tools: [FAO ECOCROP](https://ecocrop.apps.fao.org/ecocrop/srv/en/home) crop requirements,
[Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) with [GeoNames](https://www.geonames.org/)
(CC BY 4.0) for town search, [Astro](https://astro.build/), [Tailwind CSS](https://tailwindcss.com/),
[Zod](https://zod.dev/), [Supabase](https://supabase.com/), [Vercel](https://vercel.com/) and
[Amazon Bedrock](https://aws.amazon.com/bedrock/). The in-app page `/fuentes/` lists the same sources.

AgroShift does not use, modify or generate NASA logos, insignia, flags or mission identifiers.

## Run it locally

Requirements: Node.js `>= 22.23.4`.

```bash
npm install
cp .env.example .env     # fill in your own values; never commit .env
npm run dev              # http://localhost:4321  (English)  ·  /es/  (Spanish)
```

| Command | What it does |
| --- | --- |
| `npm run check` | Type-checks the Astro and TypeScript code |
| `npm test` | Unit and API tests (Vitest); live-network tests are skipped unless you run `npm run test:live` |
| `npm run build` | Production build for Vercel |
| `npm run test:e2e` | Builds and runs the browser flow tests (Playwright, uses the installed Edge) |

When a live source or key is unavailable, the app falls back to the NASA snapshots bundled in `src/data/nasa/`
(Chiclayo/Peru, India and Kenya) and to local template explanations.

### Environment variables

See `.env.example`. Server-side only: `SUPABASE_SECRET_KEY`, `NASA_API_KEY`, `EARTHDATA_TOKEN`, `FIRMS_MAP_KEY`,
`EXPLAIN_CONTEXT_SECRET`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_MODEL_ID`. The ingestion scripts
also need `EARTHDATA_USERNAME` and `EARTHDATA_PASSWORD`. Public (browser): `PUBLIC_SUPABASE_URL`,
`PUBLIC_SUPABASE_ANON_KEY`.

## Project layout

```
src/domain/      Pure engine: schemas, crop catalog, rotation and scenario rules, fact templates
src/services/    NASA clients, Supabase cache, Bedrock fact selector, browser storage and offline helpers
src/i18n/        en.ts / es.ts (mirror dictionaries), English fact templates, language routing
src/pages/       Static pages (/, /fuentes/, /offline/ and their /es/ twins) and the /api routes
src/islands/     FarmFlow.ts: the small client script that drives the quiz, results and offline mode
public/sw.js     Service worker (precache + offline navigation)
tests/           Vitest suites (domain, NASA, API, browser, i18n) and Playwright e2e
```

## Use of Super Intelligence (SI) / AI disclosure

In line with the NASA Space Apps 2026 rules, this section states where and how AI tools were used.

| Tool | Where it was used | Notes |
| --- | --- | --- |
| **Claude Code** (Anthropic) | Writing and refactoring source code (engine, NASA clients, offline service worker, UI, bilingual support), writing tests, project documentation and this README | Every change was reviewed and run by the team through type checks, the test suite and a production build |
| **ChatGPT** (OpenAI) | Early planning: brainstorming the concept, comparing candidate NASA datasets and drafting the project description | No generated images, audio or video are used in the project |
| **Amazon Bedrock** (AWS) | Runtime feature in the app: when a farmer asks a question about the result, the model only **chooses which engine-produced facts** best answer it (JSON of fact keys, temperature 0). The sentence shown to the user is always rendered from fixed templates | If Bedrock is unavailable, over quota or returns invalid output, the app shows the deterministic local answer. The UI labels AI-assisted answers |

- **Code and data:** parts of the source code and of the written documentation were AI-generated or AI-assisted, as
  described above. The scientific data comes from the NASA and FAO sources listed in this file; it is not
  AI-generated.
- **Images, video and audio:** none are AI-generated. The app contains no AI-generated imagery.
- **NASA branding:** no AI tool was used to create or alter NASA logos, insignia, flags or mission identifiers, and
  none appear in this repository or in the app.
- **Privacy:** the repository and the app contain no personal data beyond the team member names. Farm locations
  typed by users are used only to query data for that request and are not sent to Bedrock; the signed context
  sent to the explanation service contains only crop IDs and engine facts.

## License

Copyright 2026 Team OneCtrl. Licensed under the [Apache License, Version 2.0](LICENSE).
You may use, modify and distribute this software under the terms of that license. Third-party data keeps its own
license (for example, GeoNames is CC BY 4.0).
