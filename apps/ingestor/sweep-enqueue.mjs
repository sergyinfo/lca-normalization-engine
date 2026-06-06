/**
 * sweep-enqueue.mjs — guarantee 100% NLP coverage after an ingest.
 *
 * Why this exists: the ingestor enqueues an `nlp:classify` job per COPY batch as
 * a side-effect of ingest (apps/ingestor/index.js:flushBatch). A transient Redis
 * hiccup, a partial run, or the deferred-NLP path can leave rows in `lca_records`
 * with no NLP job — observed on the FY2018/19 backfill, where ~40% of rows were
 * never enqueued and the queue drained to empty at ~23% classified. This sweep
 * makes ingest's enqueue best-effort and coverage guaranteed: it reads the rows
 * that still need classification and enqueues them in the exact worker shape.
 *
 * It reads JSONL records from stdin (one JSON object per line) so the heavy SELECT
 * stays in Postgres and nothing buffers a million rows in Node. Pair it with a
 * base64'd COPY (text COPY escaping corrupts embedded JSON — base64 is immune):
 *
 *   SQL="COPY (SELECT replace(encode(convert_to(json_build_object(
 *          'nlp_id', data->>'_nlp_id', 'filing_year', filing_year,
 *          'job_title',      COALESCE(data->>'JOB_TITLE', data->>'job_title',''),
 *          'employer_name',  COALESCE(data->>'EMPLOYER_NAME', data->>'employer_name',''),
 *          'employer_state', COALESCE(data->>'EMPLOYER_STATE', data->>'employer_state'),
 *          'employer_city',  COALESCE(data->>'EMPLOYER_CITY', data->>'employer_city'),
 *          'fein',           COALESCE(data->>'EMPLOYER_FEIN', data->>'employer_fein')
 *        )::text,'UTF8'),'base64'), E'\n','')
 *        FROM lca_records r
 *        WHERE filing_year = ANY('{2018,2019}')
 *          AND NOT (data ? 'soc_code')                       -- not already classified
 *          AND NOT EXISTS (SELECT 1 FROM staging.quarantine_records q
 *                           WHERE q.raw_data->>'_nlp_id' = r.data->>'_nlp_id')  -- not quarantined
 *      ) TO STDOUT"
 *   docker compose exec -T db psql -U lca_user -d lca_db -tA -c "$SQL" \
 *     | node apps/ingestor/sweep-enqueue.mjs
 *
 * NOTE on --drain: obliterating a queue that workers are actively consuming wedges
 * the consumer (stale job locks → it stops pulling). If you must drain, restart the
 * nlp-worker afterwards. In the burst the sweep runs on a fresh queue right after
 * ingest, so --drain is not needed there.
 */
import { Queue } from 'bullmq';
import readline from 'node:readline';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const QUEUE = flag('queue', 'nlp-tasks');
const BATCH = Number(flag('batch', 5000));
const connection = (() => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { host: url.hostname, port: Number(url.port || 6379) };
})();

const queue = new Queue(QUEUE, { connection });
let buf = [], enqueued = 0, idx = 0;

async function flush() {
  if (!buf.length) return;
  await queue.add('nlp:classify',
    { batch_id: `sweep:${idx++}`, records: buf.map((r, i) => ({ id: i, ...r })) },
    { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
  enqueued += buf.length;
  buf = [];
  if (idx % 40 === 0) console.log(`[sweep] enqueued=${enqueued} jobs=${idx}`);
}

(async () => {
  if (has('drain')) {
    await queue.obliterate({ force: true });
    console.log(`[sweep] obliterated ${QUEUE} (restart the worker so it re-pulls)`);
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    buf.push(JSON.parse(Buffer.from(s, 'base64').toString('utf8')));
    if (buf.length >= BATCH) await flush();
  }
  await flush();
  console.log(`[sweep] DONE enqueued=${enqueued} jobs=${idx}`);
  await queue.close();
})().catch((e) => { console.error('[sweep] FAILED', e); process.exit(1); });
