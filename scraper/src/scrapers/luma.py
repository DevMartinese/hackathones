from __future__ import annotations

from datetime import datetime
from urllib.parse import quote_plus

import structlog

from src.config import LUMA_QUERIES, MAX_SCROLLS_PER_QUERY, PAGE_LOAD_TIMEOUT_MS
from src.models import RawEvent
from src.scrapers.base import BaseScraper

logger = structlog.get_logger()


class LumaScraper(BaseScraper):
    BASE_URL = "https://lu.ma/search"

    async def scrape(self) -> list[RawEvent]:
        browser = await self._launch_browser()
        events: list[RawEvent] = []
        seen_urls: set[str] = set()

        try:
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page = await context.new_page()

            for query in LUMA_QUERIES:
                logger.info("luma.query", query=query)
                try:
                    url = f"{self.BASE_URL}?q={quote_plus(query)}"
                    await page.goto(url, timeout=PAGE_LOAD_TIMEOUT_MS)
                    await page.wait_for_timeout(3000)

                    # Scroll to load more results
                    for _ in range(MAX_SCROLLS_PER_QUERY):
                        await page.evaluate("window.scrollBy(0, window.innerHeight)")
                        await page.wait_for_timeout(1500)

                    # Extract event cards
                    cards = await page.query_selector_all("[class*='event-link'], a[href*='/event/']")
                    if not cards:
                        # Try alternative selectors
                        cards = await page.query_selector_all("a[href^='/']")

                    for card in cards:
                        try:
                            href = await card.get_attribute("href")
                            if not href or "/event/" not in href:
                                continue

                            event_url = f"https://lu.ma{href}" if href.startswith("/") else href
                            if event_url in seen_urls:
                                continue
                            seen_urls.add(event_url)

                            text = await card.inner_text()
                            if not text.strip():
                                continue

                            events.append(
                                RawEvent(
                                    source="luma",
                                    raw_text=text.strip(),
                                    url=event_url,
                                    scraped_at=datetime.now(),
                                )
                            )
                        except Exception:
                            logger.debug("luma.card_error", exc_info=True)
                            continue

                    logger.info("luma.query_done", query=query, found=len(cards))
                except Exception:
                    logger.warning("luma.query_error", query=query, exc_info=True)
                    continue

                await self._random_delay()

        finally:
            await browser.close()

        return events
