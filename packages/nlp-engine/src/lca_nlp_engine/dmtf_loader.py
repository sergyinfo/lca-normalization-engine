"""
BLS Direct Match Title File (DMTF) loader
==========================================
Parses the BLS SOC Direct Match Title File and populates the `soc_aliases`
table for Stage 1 exact-match classification.

The DMTF maps ~56K free-text job titles (e.g. "Software Engineer") to official
SOC codes (e.g. "15-1252"). Stage 1 hits these with confidence=1.0, bypassing
the BERT model entirely.

Usage:
    # From a local file
    load-dmtf --db postgresql://... --file /data/soc_2018_direct_match_title_file.xlsx

    # Download automatically from BLS
    load-dmtf --db postgresql://... --url
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import urllib.request
from pathlib import Path
from typing import BinaryIO

import pandas as pd
import psycopg
import structlog
from tqdm import tqdm

log = structlog.get_logger(__name__)

BLS_DMTF_URL = "https://www.bls.gov/soc/2018/soc_2018_direct_match_title_file.xlsx"

# Column name layouts for different BLS DMTF releases
_COLUMN_MAPS: list[dict[str, str]] = [
    # 2018 SOC (primary target)
    {"code": "2018 SOC Code", "soc_title": "2018 SOC Title", "match": "2018 Direct Match Title"},
    # 2010 SOC (fallback)
    {"code": "SOC Code", "soc_title": "SOC Title", "match": "Direct Match Title"},
]


def _detect_columns(df: pd.DataFrame) -> dict[str, str]:
    cols = set(df.columns)
    for mapping in _COLUMN_MAPS:
        if all(v in cols for v in mapping.values()):
            return mapping
    raise ValueError(
        f"Unrecognised DMTF column layout. Found columns: {sorted(cols)}. "
        f"Expected one of: {_COLUMN_MAPS}"
    )


def parse_dmtf(source: str | Path | BinaryIO) -> pd.DataFrame:
    """
    Parse a BLS DMTF Excel file and return a normalised DataFrame with
    columns: job_title, soc_code, soc_title.

    Drops rows with nulls and deduplicates on job_title (case-insensitive).
    """
    df = pd.read_excel(source, sheet_name=0, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]

    mapping = _detect_columns(df)

    normalised = pd.DataFrame({
        "job_title": df[mapping["match"]].str.strip(),
        "soc_code": df[mapping["code"]].str.strip(),
        "soc_title": df[mapping["soc_title"]].str.strip(),
    })

    normalised = normalised.dropna()
    # Keep first occurrence when multiple titles map to the same lower-case form
    normalised["_key"] = normalised["job_title"].str.lower()
    normalised = normalised.drop_duplicates(subset=["_key"]).drop(columns=["_key"])

    log.info("dmtf_loader.parsed", total_rows=len(normalised))
    return normalised


def load_into_db(db_url: str, df: pd.DataFrame, batch_size: int = 500) -> int:
    """
    Upsert rows from `df` into soc_aliases.

    Uses ON CONFLICT on lower(job_title) so the function is idempotent —
    safe to re-run after downloading an updated DMTF release.

    Returns the number of rows processed.
    """
    rows = list(df.itertuples(index=False, name=None))
    total = 0

    with psycopg.connect(db_url, autocommit=True) as conn:
        for i in tqdm(range(0, len(rows), batch_size), desc="Loading SOC aliases", unit="batch"):
            batch = rows[i : i + batch_size]
            with conn.cursor() as cur:
                cur.executemany(
                    """
                    INSERT INTO soc_aliases (job_title, soc_code, soc_title, source)
                    VALUES (%s, %s, %s, 'dmtf')
                    ON CONFLICT (lower(job_title)) DO UPDATE
                        SET soc_code  = EXCLUDED.soc_code,
                            soc_title = EXCLUDED.soc_title
                    """,
                    batch,
                )
            total += len(batch)

    return total


def cli_main() -> None:
    parser = argparse.ArgumentParser(
        description="Load BLS DMTF SOC title mappings into the soc_aliases table"
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL connection string (default: $DATABASE_URL)",
    )

    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", metavar="PATH", help="Local path to DMTF .xlsx file")
    src.add_argument(
        "--url",
        nargs="?",
        const=BLS_DMTF_URL,
        metavar="URL",
        help=f"Download DMTF from URL (omit value to use BLS default: {BLS_DMTF_URL})",
    )

    args = parser.parse_args()

    if not args.db:
        print("Error: --db or DATABASE_URL env var is required.", file=sys.stderr)
        sys.exit(1)

    if args.file:
        source: str | Path | BinaryIO = Path(args.file)
        log.info("dmtf_loader.source", type="file", path=str(source))
    else:
        url = args.url or BLS_DMTF_URL
        log.info("dmtf_loader.downloading", url=url)
        with urllib.request.urlopen(url) as resp:  # noqa: S310
            source = io.BytesIO(resp.read())
        log.info("dmtf_loader.downloaded")

    df = parse_dmtf(source)
    n = load_into_db(args.db, df)
    print(f"Done — {n} SOC aliases loaded into soc_aliases.")
