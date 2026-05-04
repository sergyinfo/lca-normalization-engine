"""
BERT viability experiment for SOC sub-code classification.

Goal
----
Decide whether fine-tuning bert-base-uncased on bootstrap-style (title, SOC)
labels is worth committing to as Stage 3 of the classifier. Compares against
the existing Stage 2 (sentence-transformer retrieval) on the *same* held-out
set so the baseline is honest.

Honest split
------------
We hold out 20% of EMPLOYER_FEINs (not records). Train and test never see the
same employer. This prevents the model from memorising employer-specific
title→SOC quirks.

Decision rule
-------------
- ≥ 60% exact-match on held-out: commit to fine-tuned BERT path.
- 45–60%: marginal, deeper experiments needed.
- < 45%: labels too noisy; pivot to LLM-on-residual.

Run
---
    DATABASE_URL=postgresql://lca_user:lca_pass@localhost:5432/lca_db \
        .venv/bin/python experiments/train_viability.py
"""

from __future__ import annotations

import os
import random
import time
from collections import Counter
from typing import Optional

import psycopg
import torch
from torch.utils.data import DataLoader, Dataset
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    get_linear_schedule_with_warmup,
)

SEED = 42
MAX_LEN = 64
BATCH_SIZE = 32
EPOCHS = 2
LR = 2e-5
SAMPLE_LIMIT = 60000   # cap rows pulled for speed; held-out is sampled from this
HELDOUT_FEIN_FRAC = 0.20
MIN_HITS_PER_TITLE = 2  # filter singletons
DEVICE = (
    "mps" if torch.backends.mps.is_available()
    else ("cuda" if torch.cuda.is_available() else "cpu")
)

random.seed(SEED)
torch.manual_seed(SEED)


def fetch_pairs(db_url: str) -> list[tuple[str, str, str]]:
    """Pull (title, soc_code, fein) triples that pass basic quality filters."""
    sql = """
        WITH base AS (
            SELECT
                trim(data->>'JOB_TITLE')                            AS title,
                regexp_replace(data->>'SOC_CODE', '\\.\\d+$', '')   AS soc_code,
                data->>'EMPLOYER_FEIN'                              AS fein
            FROM lca_records
            WHERE data->>'JOB_TITLE' IS NOT NULL
              AND length(trim(data->>'JOB_TITLE')) BETWEEN 2 AND 200
              AND data->>'SOC_CODE' ~ '^\\d{2}-\\d{4}'
              AND data->>'EMPLOYER_FEIN' IS NOT NULL
        ),
        title_counts AS (
            SELECT lower(title) AS lt, count(*) AS n FROM base GROUP BY 1
        )
        SELECT b.title, b.soc_code, b.fein
        FROM base b
        JOIN title_counts tc ON tc.lt = lower(b.title)
        WHERE tc.n >= %s
        ORDER BY random()
        LIMIT %s;
    """
    with psycopg.connect(db_url) as conn, conn.cursor() as cur:
        cur.execute(sql, (MIN_HITS_PER_TITLE, SAMPLE_LIMIT))
        rows = cur.fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def split_by_fein(
    rows: list[tuple[str, str, str]], heldout_frac: float
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Hold out heldout_frac of distinct FEINs entirely."""
    feins = sorted({r[2] for r in rows})
    random.Random(SEED).shuffle(feins)
    cut = int(len(feins) * heldout_frac)
    heldout_set = set(feins[:cut])
    train, test = [], []
    for title, soc, fein in rows:
        (test if fein in heldout_set else train).append((title, soc))
    return train, test


class TitleDataset(Dataset):
    def __init__(self, examples, tokenizer, label2id):
        self.examples = examples
        self.tok = tokenizer
        self.label2id = label2id

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        title, soc = self.examples[idx]
        enc = self.tok(
            title,
            truncation=True,
            padding="max_length",
            max_length=MAX_LEN,
            return_tensors="pt",
        )
        return {
            "input_ids": enc["input_ids"].squeeze(0),
            "attention_mask": enc["attention_mask"].squeeze(0),
            "labels": torch.tensor(self.label2id[soc], dtype=torch.long),
        }


def evaluate(model, loader, id2label, device) -> dict:
    model.eval()
    preds: list[str] = []
    golds: list[str] = []
    with torch.no_grad():
        for batch in loader:
            input_ids = batch["input_ids"].to(device)
            mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)
            logits = model(input_ids=input_ids, attention_mask=mask).logits
            pred_ids = logits.argmax(dim=-1)
            for p, g in zip(pred_ids.tolist(), labels.tolist()):
                preds.append(id2label[p])
                golds.append(id2label[g])
    n = len(preds)
    exact = sum(1 for p, g in zip(preds, golds) if p == g)
    major = sum(1 for p, g in zip(preds, golds) if p[:2] == g[:2])
    return {
        "n": n,
        "exact": exact,
        "exact_pct": round(100.0 * exact / n, 1),
        "major": major,
        "major_pct": round(100.0 * major / n, 1),
    }


def stage2_baseline(test_examples: list[tuple[str, str]], db_url: str) -> dict:
    """Run the existing Stage 2 (sentence-transformer) retrieval over the
    same held-out titles for direct comparison."""
    from lca_nlp_engine.soc_classifier import SocClassifier

    classifier = SocClassifier.from_pretrained(db_url=db_url)
    titles = [t for t, _ in test_examples]
    golds = [g for _, g in test_examples]
    preds = classifier.predict_batch(titles)
    n = len(preds)
    pred_codes = [p.code for p in preds]
    exact = sum(1 for p, g in zip(pred_codes, golds) if p == g)
    major = sum(1 for p, g in zip(pred_codes, golds) if p[:2] == g[:2])
    classifier.close()
    return {
        "n": n,
        "exact": exact,
        "exact_pct": round(100.0 * exact / n, 1),
        "major": major,
        "major_pct": round(100.0 * major / n, 1),
    }


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit("DATABASE_URL is required")

    print(f"=== BERT Viability Experiment ===")
    print(f"device: {DEVICE}")
    print(f"sample_limit: {SAMPLE_LIMIT}, heldout_fein_frac: {HELDOUT_FEIN_FRAC}")
    print(f"epochs: {EPOCHS}, batch_size: {BATCH_SIZE}, lr: {LR}")
    print()

    t0 = time.time()
    rows = fetch_pairs(db_url)
    print(f"[{time.time()-t0:5.1f}s] fetched {len(rows)} (title, soc, fein) rows")

    train, test = split_by_fein(rows, HELDOUT_FEIN_FRAC)
    print(f"[{time.time()-t0:5.1f}s] split: train={len(train)} test={len(test)}")

    # Restrict test labels to those present in train (otherwise they're unscorable)
    train_labels = {soc for _, soc in train}
    test = [(t, s) for t, s in test if s in train_labels]
    print(f"[{time.time()-t0:5.1f}s] test after label-clip: {len(test)}")

    if len(test) < 500 or len(train) < 5000:
        raise SystemExit("not enough data after filtering")

    label_list = sorted(train_labels)
    label2id = {lbl: i for i, lbl in enumerate(label_list)}
    id2label = {i: lbl for lbl, i in label2id.items()}
    print(f"[{time.time()-t0:5.1f}s] num_labels: {len(label_list)}")

    print(f"\n--- Stage 2 baseline (sentence-transformer retrieval) ---")
    baseline = stage2_baseline(test, db_url)
    print(f"  n={baseline['n']}  exact={baseline['exact_pct']}%  major={baseline['major_pct']}%")

    print(f"\n--- Loading bert-base-uncased ---")
    tokenizer = AutoTokenizer.from_pretrained("bert-base-uncased")
    model = AutoModelForSequenceClassification.from_pretrained(
        "bert-base-uncased",
        num_labels=len(label_list),
    ).to(DEVICE)

    train_ds = TitleDataset(train, tokenizer, label2id)
    test_ds = TitleDataset(test, tokenizer, label2id)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    optim = torch.optim.AdamW(model.parameters(), lr=LR)
    total_steps = len(train_loader) * EPOCHS
    sched = get_linear_schedule_with_warmup(optim, num_warmup_steps=int(0.1 * total_steps), num_training_steps=total_steps)

    print(f"\n--- Training: {len(train_loader)} steps/epoch x {EPOCHS} epochs = {total_steps} total ---")
    model.train()
    step = 0
    t_train = time.time()
    for epoch in range(EPOCHS):
        running = 0.0
        for batch in train_loader:
            input_ids = batch["input_ids"].to(DEVICE)
            mask = batch["attention_mask"].to(DEVICE)
            labels = batch["labels"].to(DEVICE)
            logits = model(input_ids=input_ids, attention_mask=mask, labels=labels)
            loss = logits.loss
            loss.backward()
            optim.step()
            sched.step()
            optim.zero_grad()
            running += loss.item()
            step += 1
            if step % 100 == 0:
                avg = running / 100
                running = 0.0
                print(f"  step {step}/{total_steps}  loss={avg:.3f}  elapsed={time.time()-t_train:5.0f}s")
        print(f"  -- epoch {epoch+1} done in {time.time()-t_train:5.0f}s")

    print(f"\n--- Evaluating fine-tuned BERT on held-out ---")
    bert = evaluate(model, test_loader, id2label, DEVICE)
    print(f"  n={bert['n']}  exact={bert['exact_pct']}%  major={bert['major_pct']}%")

    print(f"\n=== SUMMARY ===")
    print(f"  Stage 2 retrieval:   exact={baseline['exact_pct']:5.1f}%  major={baseline['major_pct']:5.1f}%")
    print(f"  Fine-tuned BERT:     exact={bert['exact_pct']:5.1f}%  major={bert['major_pct']:5.1f}%")
    print(f"  Δ exact:             {bert['exact_pct'] - baseline['exact_pct']:+.1f} pp")
    print(f"  Δ major:             {bert['major_pct'] - baseline['major_pct']:+.1f} pp")

    if bert["exact_pct"] >= 60:
        print(f"\n  Decision: COMMIT — fine-tuned BERT clears the 60% bar.")
    elif bert["exact_pct"] >= 45:
        print(f"\n  Decision: MARGINAL — try longer training / better encoder before committing.")
    else:
        print(f"\n  Decision: PIVOT — labels too noisy. Use LLM on residual quarantine instead.")


if __name__ == "__main__":
    main()
