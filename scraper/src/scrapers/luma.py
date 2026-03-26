from __future__ import annotations

from datetime import datetime

import httpx
import structlog

from src.models import RawEvent
from src.scrapers.base import BaseScraper

logger = structlog.get_logger()

# Known Luma hackathon URLs and search queries to find more
SEED_URLS = [
    "https://lu.ma/4uq8yejo",  # Midnight Hackathon Buenos Aires
    "https://lu.ma/fizpni10",  # HackAvax Road to Avalanche Summit Argentina
    "https://lu.ma/6kluo21l",  # Hack Day Based Argentina Weekend
    "https://lu.ma/do4zysjd",  # Bitcoin Virtual Hackathon
    "https://lu.ma/e12138qh",  # Hackathon @Aleph de Verano
    "https://lu.ma/m1vu0bde",  # AI Hackathon: Model Routing | BAISH
    "https://lu.ma/uds2l1td",  # Aleph Hackaton @ Aleph March '25
]

HACKATHON_KEYWORDS = [
    "hackathon", "hackatón", "hackaton", "datathon", "buildathon",
    "ideathon", "codeathon", "game jam", "startup weekend", "code jam",
    "hack day", "hack week",
]

ARGENTINA_KEYWORDS = [
    "argentina", "buenos aires", "córdoba", "cordoba", "rosario",
    "mendoza", "tucumán", "tucuman", "la plata", "bariloche",
]


class LumaScraper(BaseScraper):
    """Scraper that fetches Luma events via their URL API + discover feed."""

    URL_API = "https://api.lu.ma/url"
    DISCOVER_API = "https://api.lu.ma/discover/get-paginated-events"

    async def _fetch_event(self, client: httpx.AsyncClient, event_url: str) -> RawEvent | None:
        """Fetch a single event by its Luma URL slug."""
        slug = event_url.rstrip("/").split("/")[-1]
        try:
            resp = await client.get(self.URL_API, params={"url": slug})
            if resp.status_code != 200:
                return None

            data = resp.json()
            event = data.get("data", {}).get("event", {})
            if not event:
                return None

            name = event.get("name", "")
            geo = event.get("geo_address_info") or {}
            city = geo.get("city", "")
            country = geo.get("country", "")
            address = geo.get("address", "")
            start = event.get("start_at", "")
            end = event.get("end_at", "")
            timezone = event.get("timezone", "")
            location_type = event.get("location_type", "")
            description_raw = event.get("description_mirror")
            description_md = str(description_raw)[:500] if description_raw else ""

            parts = [name]
            if start:
                parts.append(f"Fecha: {start[:10]}")
            if end and end[:10] != start[:10]:
                parts.append(f"Fin: {end[:10]}")
            if city:
                parts.append(f"Ciudad: {city}")
            if country:
                parts.append(f"Pais: {country}")
            if address:
                parts.append(f"Lugar: {address}")
            if location_type:
                parts.append(f"Tipo: {location_type}")
            if timezone:
                parts.append(f"Zona: {timezone}")
            if description_md:
                parts.append(description_md)

            full_url = f"https://lu.ma/{slug}"

            return RawEvent(
                source="luma",
                raw_text=" | ".join(parts),
                url=full_url,
                scraped_at=datetime.now(),
            )

        except Exception:
            logger.debug("luma.fetch_error", url=event_url, exc_info=True)
            return None

    async def _discover_events(self, client: httpx.AsyncClient) -> list[str]:
        """Scan discover feed for hackathon-like events in Argentina."""
        urls: list[str] = []
        cursor = None

        for page in range(10):
            params: dict = {"pagination_limit": 50}
            if cursor:
                params["pagination_cursor"] = cursor

            try:
                resp = await client.get(self.DISCOVER_API, params=params)
                if resp.status_code != 200:
                    break

                data = resp.json()
                for entry in data.get("entries", []):
                    event = entry.get("event", entry)
                    name = (event.get("name") or "").lower()
                    geo = event.get("geo_address_info") or {}
                    combined = f"{name} {(geo.get('country') or '').lower()} {(geo.get('city') or '').lower()}"

                    is_hackathon = any(kw in name for kw in HACKATHON_KEYWORDS)
                    is_argentina = any(kw in combined for kw in ARGENTINA_KEYWORDS)

                    if is_hackathon and is_argentina:
                        slug = event.get("url", "")
                        if slug:
                            urls.append(f"https://lu.ma/{slug}")

                if not data.get("has_more"):
                    break
                cursor = data.get("next_cursor")
                if not cursor:
                    break

            except Exception:
                break

        return urls

    async def scrape(self) -> list[RawEvent]:
        events: list[RawEvent] = []
        seen_urls: set[str] = set()

        headers = {
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "accept": "application/json",
        }

        async with httpx.AsyncClient(headers=headers, timeout=15) as client:
            # Collect URLs from discover feed
            discover_urls = await self._discover_events(client)
            logger.info("luma.discover", found=len(discover_urls))

            # Combine seed URLs + discovered URLs
            all_urls = list(SEED_URLS) + discover_urls

            # Fetch each event
            for event_url in all_urls:
                normalized = event_url.rstrip("/").split("/")[-1]
                if normalized in seen_urls:
                    continue
                seen_urls.add(normalized)

                event = await self._fetch_event(client, event_url)
                if event:
                    events.append(event)
                    logger.info("luma.event", name=event.raw_text[:60])

        return events
