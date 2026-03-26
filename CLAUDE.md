# hackathons-ar

Landing page que lista hackathones en Argentina, scrapeando X/Twitter y Luma.

## Estructura

- `web/` — Frontend Astro (estilo terminal light mode)
- `scraper/` — Python + Playwright scrapers

## Comandos

### Web (frontend)
```bash
cd web && pnpm dev        # Dev server
cd web && pnpm build      # Build estático
```

### Scraper (Python)
```bash
cd scraper && uv run hackathons-scrape pipeline   # Pipeline completo
cd scraper && uv run hackathons-scrape scrape      # Solo scraping
cd scraper && uv run pytest                        # Tests
```

## Data flow
1. Scraper genera `hackathons.json`
2. Se copia a `web/src/data/hackathons.json`
3. Astro lo consume via content collections (file loader)
4. Build estático se deploya a Vercel

## Convenciones
- Python: PEP 8, type hints, Pydantic v2
- Frontend: Astro components, vanilla JS para interactividad, CSS custom properties
- Mock data en `web/src/data/hackathons.mock.json` para desarrollo de UI
