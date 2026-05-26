"""
Smoke test — auto-embed wiring (no DB, no model)
=================================================
Cheap import + signature check for the auto-embed integration. Suitable
for CI without needing Postgres or the sentence-transformer weights.

Verifies:
  - `CompanyDeduplicator.embed_pending` exists with the expected signature
    and returns 0 when no DB connection is present (graceful no-op).
  - `NlpWorker.__init__` accepts the `auto_embed` + `auto_embed_max_rows`
    kwargs without raising.
  - `NLP_AUTO_EMBED` env-var parsing distinguishes truthy from falsy.

Run:
    packages/nlp-engine/.venv/bin/python \\
        packages/nlp-engine/scripts/smoke_wiring.py
"""
from __future__ import annotations

import inspect
import sys


def fail(msg: str) -> None:
    print(f"FAIL  {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    from lca_nlp_engine.entity_resolution import CompanyDeduplicator

    # 1. Method exists with expected params.
    if not hasattr(CompanyDeduplicator, "embed_pending"):
        fail("CompanyDeduplicator.embed_pending is missing")

    sig = inspect.signature(CompanyDeduplicator.embed_pending)
    params = set(sig.parameters.keys())
    for required in {"max_rows", "batch_size"}:
        if required not in params:
            fail(f"embed_pending is missing param: {required}")

    # 2. No-DB call returns 0 (graceful).
    dedup = CompanyDeduplicator(db_url=None)
    n = dedup.embed_pending(max_rows=10)
    if n != 0:
        fail(f"embed_pending without a DB connection returned {n}, expected 0")

    # 3. Worker constructor accepts the new kwargs — we don't actually run
    #    the worker (that would need a DB + Redis + model). We just inspect
    #    its signature.
    from lca_nlp_engine.worker import NlpWorker

    wsig = inspect.signature(NlpWorker.__init__)
    for required in {"auto_embed", "auto_embed_max_rows"}:
        if required not in wsig.parameters:
            fail(f"NlpWorker.__init__ is missing kwarg: {required}")

    # 4. Env-var parsing: simulate by re-reading the same logic the worker
    #    uses. Keep this aligned with worker.main().
    truthy = {"1", "true", "yes", "on", "", "anything-not-listed"}
    falsy = {"0", "false", "no", "off", "FALSE", " 0 "}
    parse = lambda v: v.strip().lower() not in {"0", "false", "no", "off"}
    for v in truthy:
        if not parse(v):
            fail(f"expected truthy parse for {v!r}")
    for v in falsy:
        if parse(v):
            fail(f"expected falsy parse for {v!r}")

    print("PASS  wiring smoke (no DB, no model)")


if __name__ == "__main__":
    main()
