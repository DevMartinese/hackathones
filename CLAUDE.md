# hackathones

Global directory of hackathons. Terminal UI that celebrates hacker culture and
lowers the barrier to CLI, GitHub issues, and open source. The experience is
deliberately terminal-shaped — commands, flags, autocomplete with Tab — and
the submit flow opens a GitHub issue as a teaching moment.

Served in three locales: English (default, at `/`), Spanish (`/es/`), and
Brazilian Portuguese (`/pt/`). Commands and flags stay in English across every
locale to preserve the CLI feel; only the UI copy is translated.

## Estructura

- `web/` — Frontend Astro + React. Single page app rendered as three static
  builds (one per locale), reading from Supabase at runtime.
- `web/scripts/ingest.mjs` — Node ingest pipeline. Pulls from Luma, DoraHacks,
  Devpost, and GitHub Issues, and upserts to Supabase.
- `web/src/i18n/{en,es,pt}.json` — Translation dicts. Flat key-value with
  `{one, other}` for plurals.
- `.github/workflows/ingest.yml` — Cron every 6h + on issue events, runs
  `ingest.mjs`.
- `.github/workflows/deploy.yml` — Builds + deploys to Vercel on push to main.

## Comandos

### Web (frontend)
```bash
cd web && pnpm dev        # Dev server on :4321
cd web && pnpm build      # Static build (4 pages: /, /es/, /pt/, /loader-logo/)
```

### Ingest (local run, requires Supabase service role)
```bash
cd web && SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/ingest.mjs
```

## Data flow

```
Luma seed URLs ─┐
DoraHacks API  ─┼─► ingest.mjs (cron 6h) ─► Supabase ─► Astro terminal (client fetch via PostgREST)
Devpost API    ─┤
GitHub Issues  ─┘
```

Supabase is the single source of truth. The frontend reads it directly from
the client on page load — no build-time data generation. The content
collection and `src/data/hackathons.json` do not exist.

## Convenciones

- Frontend: Astro components, vanilla JS inline scripts for the terminal,
  CSS custom properties. React only for `IntroLoader` (three.js shader + Tone.js audio).
- i18n: UI chrome is localized; hackathon names/descriptions are shown in
  whatever language the source published them in. No machine translation of data.
- DB enum values stay stable across locales (`type` = `presencial|online|hibrido`);
  labels are mapped client-side via `T["submit.type.<value>"]`.
- Issue bodies submitted via `submit`/`lfg` are always in English regardless
  of locale so triage is consistent.
- Commands and flags: English only, always. Never translate `list`, `submit`,
  `--country`, `--type`, etc.
