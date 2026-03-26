from __future__ import annotations

import json
import os
from datetime import datetime
from urllib.parse import quote_plus

import structlog
from playwright.async_api import Page, BrowserContext

from src.config import X_QUERIES, MAX_SCROLLS_PER_QUERY, PAGE_LOAD_TIMEOUT_MS
from src.models import RawEvent
from src.scrapers.base import BaseScraper

logger = structlog.get_logger()


class TwitterScraper(BaseScraper):
    """Scraper that uses Playwright to automate X search and intercept GraphQL responses."""

    def _get_cookies(self) -> list[dict] | None:
        """Build cookie list from env vars."""
        auth_token = os.environ.get("X_AUTH_TOKEN")
        ct0 = os.environ.get("X_CT0")

        if not auth_token or not ct0:
            logger.warning("twitter.no_credentials", msg="Set X_AUTH_TOKEN and X_CT0 env vars")
            return None

        return [
            {"name": "auth_token", "value": auth_token, "domain": ".x.com", "path": "/"},
            {"name": "ct0", "value": ct0, "domain": ".x.com", "path": "/"},
        ]

    def _extract_tweets_from_response(self, data: dict) -> list[dict]:
        """Extract tweet data from a GraphQL SearchTimeline response."""
        tweets: list[dict] = []
        try:
            instructions = (
                data.get("data", {})
                .get("search_by_raw_query", {})
                .get("search_timeline", {})
                .get("timeline", {})
                .get("instructions", [])
            )
            for instruction in instructions:
                entries = instruction.get("entries", [])
                for entry in entries:
                    result = (
                        entry.get("content", {})
                        .get("itemContent", {})
                        .get("tweet_results", {})
                        .get("result", {})
                    )
                    if not result:
                        continue
                    if result.get("__typename") == "TweetWithVisibilityResults":
                        result = result.get("tweet", {})

                    legacy = result.get("legacy", {})
                    full_text = legacy.get("full_text", "")
                    if not full_text:
                        continue

                    user_legacy = (
                        result.get("core", {})
                        .get("user_results", {})
                        .get("result", {})
                        .get("legacy", {})
                    )
                    screen_name = user_legacy.get("screen_name")

                    urls = legacy.get("entities", {}).get("urls", [])
                    external_url = None
                    for u in urls:
                        expanded = u.get("expanded_url", "")
                        if expanded and "x.com" not in expanded and "twitter.com" not in expanded:
                            external_url = expanded
                            break

                    tweets.append({
                        "text": full_text,
                        "author": f"@{screen_name}" if screen_name else None,
                        "url": external_url,
                    })
        except Exception:
            logger.debug("twitter.parse_error", exc_info=True)

        return tweets

    async def scrape(self) -> list[RawEvent]:
        cookies = self._get_cookies()
        if not cookies:
            return []

        browser = await self._launch_browser()
        events: list[RawEvent] = []
        seen_texts: set[str] = set()
        captured_tweets: list[dict] = []

        try:
            context: BrowserContext = await browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 900},
            )
            await context.add_cookies(cookies)

            page: Page = await context.new_page()

            # Intercept GraphQL responses to capture tweet data
            async def handle_response(response):
                if "SearchTimeline" in response.url and response.status == 200:
                    try:
                        data = await response.json()
                        tweets = self._extract_tweets_from_response(data)
                        captured_tweets.extend(tweets)
                        logger.debug("twitter.intercepted", count=len(tweets))
                    except Exception:
                        pass

            page.on("response", handle_response)

            for query in X_QUERIES:
                logger.info("twitter.query", query=query)
                captured_tweets.clear()

                try:
                    url = f"https://x.com/search?q={quote_plus(query)}&src=typed_query&f=live"
                    await page.goto(url, timeout=PAGE_LOAD_TIMEOUT_MS)

                    # Wait for content to load
                    try:
                        await page.wait_for_selector('[data-testid="tweet"]', timeout=15000)
                    except Exception:
                        logger.warning("twitter.no_tweets", query=query)
                        continue

                    # Scroll to trigger more API requests
                    for _ in range(min(MAX_SCROLLS_PER_QUERY, 5)):
                        await page.evaluate("window.scrollBy(0, window.innerHeight)")
                        await page.wait_for_timeout(2000)

                    # Process captured tweets from intercepted responses
                    for tweet in captured_tweets:
                        text_key = tweet["text"][:100]
                        if text_key in seen_texts:
                            continue
                        seen_texts.add(text_key)

                        events.append(
                            RawEvent(
                                source="x",
                                raw_text=tweet["text"],
                                url=tweet["url"],
                                author=tweet["author"],
                                scraped_at=datetime.now(),
                            )
                        )

                    logger.info("twitter.query_done", query=query, found=len(captured_tweets))

                except Exception:
                    logger.warning("twitter.query_error", query=query, exc_info=True)
                    continue

                await self._random_delay()

        finally:
            await browser.close()

        return events
