from datetime import date, datetime

from src.models import RawEvent
from src.processing.parser import (
    extract_city,
    extract_dates,
    extract_name,
    extract_tags,
    extract_type,
    extract_urls,
    parse_raw_event,
)


def test_extract_urls():
    text = "Registrate en https://hackit.com.ar y también en https://luma.com/event"
    urls = extract_urls(text)
    assert len(urls) == 2
    assert "https://hackit.com.ar" in urls


def test_extract_city_buenos_aires():
    assert extract_city("Hackathon en Buenos Aires este finde") == "Buenos Aires"


def test_extract_city_caba():
    assert extract_city("Evento en CABA, imperdible") == "Buenos Aires"


def test_extract_city_cordoba():
    assert extract_city("Hackathon Córdoba 2026") == "Cordoba"


def test_extract_city_none():
    assert extract_city("Hackathon online para todos") is None


def test_extract_tags_ai():
    tags = extract_tags("Hackathon de inteligencia artificial y machine learning")
    assert "AI" in tags


def test_extract_tags_web3():
    tags = extract_tags("Construi en blockchain y web3")
    assert "web3" in tags


def test_extract_tags_multiple():
    tags = extract_tags("Hackathon de AI con datos abiertos y blockchain")
    assert "AI" in tags
    assert "datos" in tags
    assert "web3" in tags


def test_extract_type_presencial():
    assert extract_type("Evento presencial en Buenos Aires") == "presencial"


def test_extract_type_online():
    assert extract_type("Hackathon 100% virtual") == "online"


def test_extract_type_hibrido():
    assert extract_type("Formato híbrido") == "hibrido"


def test_extract_type_none():
    assert extract_type("Hackathon copada") is None


def test_extract_dates_spanish():
    start, end = extract_dates("15-16 de abril")
    assert start == date(2026, 4, 15)
    assert end == date(2026, 4, 16)


def test_extract_dates_single():
    start, end = extract_dates("25 de mayo gran evento")
    assert start == date(2026, 5, 25)
    assert end == date(2026, 5, 25)


def test_extract_dates_iso():
    start, end = extract_dates("Del 2026-06-10 al 2026-06-12")
    assert start == date(2026, 6, 10)
    assert end == date(2026, 6, 12)


def test_extract_dates_english():
    start, end = extract_dates("April 15-16, 2026")
    assert start == date(2026, 4, 15)
    assert end == date(2026, 4, 16)


def test_extract_name():
    text = "HackIT BA 2026\nRegistrate ahora en hackit.com.ar"
    assert extract_name(text) == "HackIT BA 2026"


def test_extract_name_removes_rt():
    text = "RT @someone: Gran hackathon este finde"
    assert extract_name(text) == "Gran hackathon este finde"


def test_parse_raw_event():
    event = RawEvent(
        source="x",
        raw_text="HackIT BA 2026\n15-16 de abril en Buenos Aires\nRegistrate en https://hackit.com.ar\nHackathon presencial de AI y web3",
        url=None,
        author="@hackitba",
        scraped_at=datetime.now(),
    )
    h = parse_raw_event(event)
    assert h.name == "HackIT BA 2026"
    assert h.date_start == date(2026, 4, 15)
    assert h.city == "Buenos Aires"
    assert h.source == "x"
    assert h.type == "presencial"
    assert "AI" in h.tags
    assert h.url == "https://hackit.com.ar"
