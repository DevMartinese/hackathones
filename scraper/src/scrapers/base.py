from __future__ import annotations

import asyncio
import random
from abc import ABC, abstractmethod

import structlog
from playwright.async_api import Browser, async_playwright

from src.config import MAX_DELAY_SECONDS, MIN_DELAY_SECONDS
from src.models import RawEvent

logger = structlog.get_logger()


class BaseScraper(ABC):
    def __init__(self, headed: bool = False) -> None:
        self.headed = headed

    async def _launch_browser(self) -> Browser:
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(headless=not self.headed)
        return browser

    async def _random_delay(self) -> None:
        delay = random.uniform(MIN_DELAY_SECONDS, MAX_DELAY_SECONDS)
        await asyncio.sleep(delay)

    @abstractmethod
    async def scrape(self) -> list[RawEvent]:
        ...

    async def run(self) -> list[RawEvent]:
        logger.info("scraper.start", scraper=self.__class__.__name__)
        try:
            events = await self.scrape()
            logger.info("scraper.done", scraper=self.__class__.__name__, count=len(events))
            return events
        except Exception:
            logger.exception("scraper.error", scraper=self.__class__.__name__)
            return []
