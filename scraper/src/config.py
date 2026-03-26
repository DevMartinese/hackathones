from __future__ import annotations

# --- X/Twitter search queries ---
X_QUERIES: list[str] = [
    # Core
    "hackathon argentina",
    "hackatón argentina",
    "hackaton argentina",
    "hackathon buenos aires",
    "hackathon córdoba",
    "hackathon rosario",
    "hackathon mendoza",
    "hackathon LATAM",
    # Web3/Crypto
    "hackathon web3 argentina",
    "hackathon blockchain argentina",
    "hackathon ethereum argentina",
    "hackathon solana argentina",
    "ETHLatam hackathon",
    # AI
    "hackathon IA argentina",
    "hackathon AI argentina",
    "hackathon inteligencia artificial argentina",
    # Related events
    "datathon argentina",
    "buildathon argentina",
    "startup weekend argentina",
    # Discovery patterns
    '"hackathon" "argentina" inscribite',
    '"hackathon" "argentina" registrate',
    '"próximo hackathon" argentina',
]

# --- Luma search queries ---
LUMA_QUERIES: list[str] = [
    "hackathon argentina",
    "hackatón argentina",
    "hackathon buenos aires",
    "hackathon",
]

# --- Argentine cities for detection ---
AR_CITIES: dict[str, str] = {
    "buenos aires": "Buenos Aires",
    "caba": "Buenos Aires",
    "capital federal": "Buenos Aires",
    "ba": "Buenos Aires",
    "córdoba": "Cordoba",
    "cordoba": "Cordoba",
    "cba": "Cordoba",
    "rosario": "Rosario",
    "mendoza": "Mendoza",
    "la plata": "La Plata",
    "tucumán": "Tucuman",
    "tucuman": "Tucuman",
    "mar del plata": "Mar del Plata",
    "bariloche": "Bariloche",
    "santa fe": "Santa Fe",
    "neuquén": "Neuquen",
    "neuquen": "Neuquen",
    "misiones": "Misiones",
    "posadas": "Posadas",
    "salta": "Salta",
}

# --- Tag keywords for detection ---
TAG_KEYWORDS: dict[str, list[str]] = {
    "AI": ["ai", "ia", "inteligencia artificial", "machine learning", "ml", "llm", "gpt", "agentes"],
    "web3": ["web3", "blockchain", "crypto", "defi", "nft", "dao"],
    "ethereum": ["ethereum", "eth", "solidity"],
    "solana": ["solana", "sol"],
    "fintech": ["fintech", "pagos", "payments"],
    "datos": ["datos", "data", "datathon", "open data"],
    "cloud": ["cloud", "aws", "gcp", "azure"],
    "IoT": ["iot", "internet of things", "sensores"],
    "startups": ["startup", "emprendimiento", "startup weekend"],
    "gaming": ["game jam", "gaming", "juegos"],
    "ciencia": ["ciencia", "science", "nasa", "espacio", "space"],
    "gobierno": ["gobierno", "gov", "público", "ciudadano"],
}

# --- Type keywords for detection ---
TYPE_KEYWORDS: dict[str, list[str]] = {
    "presencial": ["presencial", "in-person", "in person", "sede"],
    "online": ["online", "virtual", "remoto", "remote"],
    "hibrido": ["híbrido", "hibrido", "hybrid"],
}

# --- Rate limiting ---
MIN_DELAY_SECONDS: float = 3.0
MAX_DELAY_SECONDS: float = 8.0
MAX_SCROLLS_PER_QUERY: int = 10
PAGE_LOAD_TIMEOUT_MS: int = 30_000
