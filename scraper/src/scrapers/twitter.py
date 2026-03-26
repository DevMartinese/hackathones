from __future__ import annotations

import json
import os
from datetime import datetime
from urllib.parse import quote_plus

import structlog

from src.config import MAX_SCROLLS_PER_QUERY, PAGE_LOAD_TIMEOUT_MS, X_QUERIES
from src.models import RawEvent
from src.scrapers.base import BaseScraper

logger = structlog.get_logger()


class TwitterScraper(BaseScraper):
    BASE_URL = "https://x.com/search"

    def _get_cookies_path(self) -> str | None:
        path = os.environ.get("X_COOKIES_PATH")
        if path and os.path.exists(path):
            return path
        default = os.path.join(os.path.dirname(__file__), "..", "..", "cookies", "x_cookies.json")
        if os.path.exists(default):
            return default
        return None

    async def _load_cookies(self, context) -> bool:
        cookies_path = self._get_cookies_path()
        if not cookies_path:
            logger.warning("twitter.no_cookies", msg="No cookies file found. X search requires authentication.")
            return False

        with open(cookies_path) as f:
            cookies = json.load(f)

        await context.add_cookies(cookies)
        logger.info("twitter.cookies_loaded", path=cookies_path)
        return True

    async def scrape(self) -> list[RawEvent]:
        browser = await self._launch_browser()
        events: list[RawEvent] = []
        seen_texts: set[str] = set()

        try:
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 900},
            )

            has_cookies = await self._load_cookies(context)
            if not has_cookies:
                logger.warning("twitter.skip", msg="Skipping X scraper — no cookies available")
                await browser.close()
                return []

            page = await context.new_page()

            for query in X_QUERIES:
                logger.info("twitter.query", query=query)
                try:
                    url = f"{self.BASE_URL}?q={quote_plus(query)}&src=typed_query&f=live"
                    await page.goto(url, timeout=PAGE_LOAD_TIMEOUT_MS)

                    # Wait for tweets to appear
                    try:
                        await page.wait_for_selector('[data-testid="tweet"]', timeout=15000)
                    except Exception:
                        logger.warning("twitter.no_tweets", query=query)
                        continue

                    # Scroll to load more
                    for _ in range(MAX_SCROLLS_PER_QUERY):
                        await page.evaluate("window.scrollBy(0, window.innerHeight)")
                        await page.wait_for_timeout(2000)

                    # Extract tweets
                    tweets = await page.query_selector_all('[data-testid="tweet"]')

                    for tweet in tweets:
                        try:
                            # Get tweet text
                            text_el = await tweet.query_selector('[data-testid="tweetText"]')
                            if not text_el:
                                continue
                            text = await text_el.inner_text()
                            if not text.strip():
                                continue

                            # Deduplicate by content
                            text_key = text.strip()[:100]
                            if text_key in seen_texts:
                                continue
                            seen_texts.add(text_key)

                            # Get author
                            author = None
                            author_el = await tweet.query_selector('[data-testid="User-Name"] a')
                            if author_el:
                                author = await author_el.get_attribute("href")
                                if author:
                                    author = author.strip("/")

                            # Get links from tweet
                            links = await tweet.query_selector_all("a[href]")
                            tweet_url = None
                            for link in links:
                                href = await link.get_attribute("href")
                                if href and ("http" in href) and ("x.com" not in href) and ("twitter.com" not in href):
                                    tweet_url = href
                                    break

                            events.append(
                                RawEvent(
                                    source="x",
                                    raw_text=text.strip(),
                                    url=tweet_url,
                                    author=author,
                                    scraped_at=datetime.now(),
                                )
                            )
                        except Exception:
                            logger.debug("twitter.tweet_error", exc_info=True)
                            continue

                    logger.info("twitter.query_done", query=query, found=len(tweets))

                except Exception:
                    logger.warning("twitter.query_error", query=query, exc_info=True)
                    continue

                await self._random_delay()

        finally:
            await browser.close()

        return events
