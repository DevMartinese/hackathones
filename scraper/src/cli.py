from __future__ import annotations

import asyncio
import json
from pathlib import Path

import click
import structlog

from src.models import Hackathon, RawEvent
from src.processing.deduplicator import deduplicate
from src.processing.normalizer import normalize_all
from src.processing.parser import parse_raw_event
from src.scrapers.luma import LumaScraper
from src.scrapers.twitter import TwitterScraper

structlog.configure(
    processors=[
        structlog.dev.ConsoleRenderer(),
    ],
)
logger = structlog.get_logger()


async def _scrape(source: str | None, headed: bool) -> list[RawEvent]:
    events: list[RawEvent] = []

    if source is None or source == "luma":
        scraper = LumaScraper(headed=headed)
        events.extend(await scraper.run())

    if source is None or source == "x":
        scraper = TwitterScraper(headed=headed)
        events.extend(await scraper.run())

    return events


def _process(raw_events: list[RawEvent]) -> list[Hackathon]:
    parsed = [parse_raw_event(e) for e in raw_events]
    deduped = deduplicate(parsed)
    normalized = normalize_all(deduped)
    return normalized


def _save(hackathons: list[Hackathon], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    data = [h.model_dump(mode="json") for h in hackathons]
    output.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    logger.info("output.saved", path=str(output), count=len(hackathons))


@click.group()
def main():
    """Scraper de hackathones en Argentina."""
    pass


@main.command()
@click.option("--source", type=click.Choice(["x", "luma"]), default=None, help="Solo scrapear una fuente")
@click.option("--headed", is_flag=True, help="Ejecutar browser visible")
@click.option("--output", type=click.Path(), default="output/raw_events.json", help="Archivo de salida")
def scrape(source: str | None, headed: bool, output: str):
    """Scrapear X/Twitter y/o Luma."""
    events = asyncio.run(_scrape(source, headed))
    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = [e.model_dump(mode="json") for e in events]
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    click.echo(f"Scrapeados {len(events)} eventos -> {out}")


@main.command()
@click.option("--input", "input_file", type=click.Path(exists=True), default="output/raw_events.json")
@click.option("--output", type=click.Path(), default="output/hackathons.json")
def process(input_file: str, output: str):
    """Procesar eventos raw a hackathones limpios."""
    raw_data = json.loads(Path(input_file).read_text())
    raw_events = [RawEvent(**e) for e in raw_data]
    hackathons = _process(raw_events)
    _save(hackathons, Path(output))


@main.command()
@click.option("--source", type=click.Choice(["x", "luma"]), default=None)
@click.option("--headed", is_flag=True)
@click.option("--output", type=click.Path(), default="output/hackathons.json")
def pipeline(source: str | None, headed: bool, output: str):
    """Pipeline completo: scrape + process."""
    events = asyncio.run(_scrape(source, headed))
    click.echo(f"Scrapeados {len(events)} eventos raw")

    hackathons = _process(events)
    click.echo(f"Procesados {len(hackathons)} hackathones")

    _save(hackathons, Path(output))
