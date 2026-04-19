# lca-nlp-engine (Python)

Shared Python NLP library for the LCA Normalization Engine.

## Responsibilities

| Module | Purpose |
|---|---|
| `soc_classifier.py` | BERT-based classification of free-text job titles → SOC codes |
| `entity_resolution.py` | Probabilistic company name deduplication (`dedupe`) |
| `worker.py` | Async BullMQ-compatible Redis queue consumer |

## Quick Start

```bash
# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install (editable, with dev extras)
pip install -e ".[dev]"

# Run the NLP worker
NLP_MODEL_PATH=/app/models/soc-bert \
REDIS_URL=redis://localhost:6379 \
nlp-worker
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `DATABASE_URL` | — | PostgreSQL DSN (for entity resolution DB writes) |
| `NLP_MODEL_PATH` | `/app/models/soc-bert` | Path to fine-tuned BERT checkpoint |
| `NLP_WORKER_CONCURRENCY` | `2` | Parallel job slots |
| `NLP_DEVICE` | `cpu` | `cpu` or `cuda` |

## Model Training (SOC Classifier)

The classifier expects a HuggingFace `text-classification` checkpoint fine-tuned on
a dataset of `(job_title, soc_code)` pairs. To fine-tune:

1. Export labelled pairs from `lca_records` where `soc_code` is already known
2. Fine-tune `bert-base-uncased` using `transformers` `Trainer`
3. Save with `model.save_pretrained()` and point `NLP_MODEL_PATH` at the output directory

## Entity Resolution Training

The `dedupe` library uses active learning. On first run it will prompt for labelled
pairs interactively. The trained settings file is then saved and reused for subsequent
incremental runs without requiring re-training.
