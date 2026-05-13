/**
 * Database queries for the three operator review queues.
 *
 * Queues:
 *   1. Reviews   — lca_records where data->>'requires_review' = 'true'
 *   2. Quarantine — staging.quarantine_records WHERE reprocessed_at IS NULL
 *   3. Unresolved — staging.unresolved_employers WHERE resolved_at IS NULL
 */

import { getPool } from '@lca/db-lib';

// ---------------------------------------------------------------------------
// SOC autocomplete dictionary
// ---------------------------------------------------------------------------
//
// One distinct (soc_code, soc_title) pair per code, mined from soc_aliases.
// Used to render a <datalist> for the SOC inputs on Reviews and Quarantine
// inspect pages so the operator can type a job-title fragment ("software")
// and pick the canonical SOC instead of looking it up on bls.gov.
//
// Cached for the lifetime of the process — the dictionary is effectively
// static (DMTF + thesis-bootstrapped aliases don't change between deploys).
// If you load a fresh DMTF release, restart the app to pick it up.

let _socListCache = null;
let _socListPromise = null;

export async function listSocCodes() {
  if (_socListCache) return _socListCache;
  if (_socListPromise) return _socListPromise;
  _socListPromise = (async () => {
    const pool = getPool();
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (soc_code)
             soc_code,
             soc_title
      FROM   soc_aliases
      WHERE  soc_code IS NOT NULL
        AND  soc_title IS NOT NULL
      ORDER  BY soc_code, length(soc_title) ASC
    `);
    _socListCache = rows;
    return rows;
  })();
  return _socListPromise;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getQueueCounts() {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM lca_records WHERE data->>'requires_review' = 'true')        AS reviews,
      (SELECT COUNT(*) FROM staging.quarantine_records WHERE reprocessed_at IS NULL)    AS quarantine,
      (SELECT COUNT(*) FROM staging.unresolved_employers WHERE resolved_at IS NULL)     AS unresolved
  `);
  const r = rows[0];
  return {
    reviews: Number(r.reviews),
    quarantine: Number(r.quarantine),
    unresolved: Number(r.unresolved),
  };
}

// ---------------------------------------------------------------------------
// Queue 1: Reviews (requires_review = true)
// ---------------------------------------------------------------------------

export async function listReviews({ limit = 50, offset = 0, reason = null } = {}) {
  const pool = getPool();
  const where = [`data->>'requires_review' = 'true'`];
  const params = [];
  if (reason) {
    params.push(reason);
    where.push(`data->>'review_reason' = $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `
    SELECT id, filing_year,
           data->>'_nlp_id'         AS nlp_id,
           data->>'JOB_TITLE'       AS job_title,
           data->>'EMPLOYER_NAME'   AS employer_name,
           data->>'EMPLOYER_STATE'  AS employer_state,
           data->>'soc_code'        AS soc_code,
           data->>'soc_title'       AS soc_title,
           data->>'soc_confidence'  AS soc_confidence,
           data->>'soc_source'      AS soc_source,
           data->>'review_reason'   AS review_reason
    FROM   lca_records
    WHERE  ${where.join(' AND ')}
    ORDER  BY filing_year DESC, id ASC
    LIMIT  $${params.length - 1}
    OFFSET $${params.length}
    `,
    params,
  );
  return rows;
}

export async function getReview({ filingYear, id }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, filing_year, data, created_at
     FROM   lca_records
     WHERE  filing_year = $1 AND id = $2`,
    [filingYear, id],
  );
  return rows[0] ?? null;
}

/**
 * Patch the JSONB `data` column on a single review record.
 *
 * Always merges in `requires_review=false`, `review_reason=null`, and
 * an audit trail (`operator_action`, `operator_decided_at`).
 */
export async function patchReview({ filingYear, id, patch }) {
  const pool = getPool();
  const merged = {
    requires_review: false,
    review_reason: null,
    operator_decided_at: new Date().toISOString(),
    ...patch,
  };
  const { rowCount } = await pool.query(
    `UPDATE lca_records
     SET    data = data || $1::jsonb
     WHERE  filing_year = $2 AND id = $3`,
    [JSON.stringify(merged), filingYear, id],
  );
  return rowCount;
}

/**
 * Reject a review: clear SOC fields, then move a copy into quarantine.
 */
export async function rejectReviewToQuarantine({ filingYear, id, reason }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT data FROM lca_records WHERE filing_year = $1 AND id = $2 FOR UPDATE`,
      [filingYear, id],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return 0;
    }
    const row = rows[0].data;

    await client.query(
      `INSERT INTO staging.quarantine_records (filing_year, raw_data, errors)
       VALUES ($1, $2::jsonb, $3::jsonb)`,
      [
        filingYear,
        JSON.stringify({
          _nlp_id: row._nlp_id,
          job_title: row.JOB_TITLE,
          employer_name: row.EMPLOYER_NAME,
          employer_state: row.EMPLOYER_STATE,
          soc_code: row.soc_code,
        }),
        JSON.stringify({
          type: 'operator_rejected_review',
          reason: reason ?? null,
          rejected_at: new Date().toISOString(),
        }),
      ],
    );

    await client.query(
      `UPDATE lca_records
       SET    data = data || $1::jsonb
       WHERE  filing_year = $2 AND id = $3`,
      [
        JSON.stringify({
          requires_review: false,
          review_reason: null,
          soc_code: null,
          soc_title: null,
          soc_confidence: null,
          soc_source: null,
          operator_action: 'rejected_to_quarantine',
          operator_decided_at: new Date().toISOString(),
        }),
        filingYear,
        id,
      ],
    );

    await client.query('COMMIT');
    return 1;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Queue 2: Quarantine
// ---------------------------------------------------------------------------

export async function listQuarantine({ limit = 50, offset = 0 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT id, filing_year, raw_data, errors, created_at
    FROM   staging.quarantine_records
    WHERE  reprocessed_at IS NULL
    ORDER  BY created_at DESC, id DESC
    LIMIT  $1 OFFSET $2
    `,
    [limit, offset],
  );
  return rows;
}

export async function getQuarantineRecord(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, filing_year, raw_data, errors, created_at, reprocessed_at
     FROM   staging.quarantine_records
     WHERE  id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Look up the originating lca_record by _nlp_id stored in raw_data.
 * Returns null if not found (the record may have been deleted or the
 * quarantine entry may predate _nlp_id assignment).
 */
async function getLcaByNlpId(client, nlpId, filingYear) {
  if (!nlpId) return null;
  const { rows } = await client.query(
    `SELECT id, filing_year, data
     FROM   lca_records
     WHERE  data->>'_nlp_id' = $1 AND filing_year = $2`,
    [nlpId, filingYear],
  );
  return rows[0] ?? null;
}

/**
 * Assign a SOC manually for a quarantined record. Writes back to lca_records
 * (if the originating record can be found) and marks reprocessed_at.
 */
export async function assignQuarantineSoc({ id, socCode, socTitle, note }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, filing_year, raw_data
       FROM   staging.quarantine_records
       WHERE  id = $1 AND reprocessed_at IS NULL
       FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { updated: 0, lcaUpdated: false };
    }
    const q = rows[0];
    const nlpId = q.raw_data?._nlp_id;
    const lca = await getLcaByNlpId(client, nlpId, q.filing_year);

    let lcaUpdated = false;
    if (lca) {
      await client.query(
        `UPDATE lca_records
         SET    data = data || $1::jsonb
         WHERE  filing_year = $2 AND id = $3`,
        [
          JSON.stringify({
            soc_code: socCode,
            soc_title: socTitle ?? null,
            soc_confidence: 1.0,
            soc_source: 'operator',
            requires_review: false,
            review_reason: null,
            operator_action: 'quarantine_assigned',
            operator_note: note ?? null,
            operator_decided_at: new Date().toISOString(),
          }),
          lca.filing_year,
          lca.id,
        ],
      );
      lcaUpdated = true;
    }

    await client.query(
      `UPDATE staging.quarantine_records
       SET    reprocessed_at = NOW(),
              errors = errors || $2::jsonb
       WHERE  id = $1`,
      [
        id,
        JSON.stringify({
          operator_action: 'assigned',
          operator_soc_code: socCode,
          operator_soc_title: socTitle ?? null,
          operator_note: note ?? null,
          lca_record_updated: lcaUpdated,
        }),
      ],
    );

    await client.query('COMMIT');
    return { updated: 1, lcaUpdated };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function dropQuarantine({ id, note }) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE staging.quarantine_records
     SET    reprocessed_at = NOW(),
            errors = errors || $2::jsonb
     WHERE  id = $1 AND reprocessed_at IS NULL`,
    [
      id,
      JSON.stringify({
        operator_action: 'dropped',
        operator_note: note ?? null,
      }),
    ],
  );
  return rowCount;
}

// ---------------------------------------------------------------------------
// Queue 3: Unresolved employers
// ---------------------------------------------------------------------------

export async function listUnresolved({ limit = 50, offset = 0 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT id, employer_name, employer_state, employer_fein, employer_city,
           hits, first_filing_year, created_at, updated_at
    FROM   staging.unresolved_employers
    WHERE  resolved_at IS NULL
    ORDER  BY hits DESC, updated_at DESC
    LIMIT  $1 OFFSET $2
    `,
    [limit, offset],
  );
  return rows;
}

export async function getUnresolved(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM staging.unresolved_employers WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Find canonical_employers similar to the given name using pg_trgm.
 * Optionally filters by state to reduce false positives.
 */
export async function findSimilarCanonicals({ name, state = null, limit = 20 }) {
  const pool = getPool();
  const params = [name];
  let stateFilter = '';
  if (state) {
    params.push(state);
    stateFilter = `AND (employer_state = $${params.length} OR employer_state IS NULL)`;
  }
  params.push(limit);
  const { rows } = await pool.query(
    `
    SELECT id, canonical_name, fein, employer_state, employer_city, record_count,
           similarity(canonical_name, $1) AS score
    FROM   canonical_employers
    WHERE  canonical_name % $1
    ${stateFilter}
    ORDER  BY score DESC, record_count DESC
    LIMIT  $${params.length}
    `,
    params,
  );
  return rows;
}

/**
 * Merge an unresolved entry into an existing canonical_employer.
 * Backfills canonical_employer_id on lca_records that match the
 * (employer_name, employer_state) pair, then marks the unresolved row resolved.
 */
export async function mergeUnresolved({ unresolvedId, canonicalId }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM staging.unresolved_employers
       WHERE id = $1 AND resolved_at IS NULL FOR UPDATE`,
      [unresolvedId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { resolved: 0, backfilled: 0 };
    }
    const u = rows[0];

    // Confirm the target canonical exists.
    const { rows: canonRows } = await client.query(
      `SELECT id FROM canonical_employers WHERE id = $1`,
      [canonicalId],
    );
    if (canonRows.length === 0) {
      await client.query('ROLLBACK');
      return { resolved: 0, backfilled: 0, error: 'canonical_not_found' };
    }

    // Backfill matching lca_records that lack a canonical_employer_id.
    const stateFilter = u.employer_state
      ? `AND data->>'EMPLOYER_STATE' = $3`
      : '';
    const stateParam = u.employer_state ? [u.employer_state] : [];
    const backfillResult = await client.query(
      `UPDATE lca_records
       SET    data = data || jsonb_build_object('canonical_employer_id', $1::text)
       WHERE  lower(data->>'EMPLOYER_NAME') = lower($2)
         ${stateFilter}
         AND  (data->>'canonical_employer_id' IS NULL OR data->>'canonical_employer_id' = '')`,
      [canonicalId, u.employer_name, ...stateParam],
    );

    // Bump record_count on the canonical employer.
    if (backfillResult.rowCount > 0) {
      await client.query(
        `UPDATE canonical_employers
         SET    record_count = record_count + $2,
                updated_at = NOW()
         WHERE  id = $1`,
        [canonicalId, backfillResult.rowCount],
      );
    }

    await client.query(
      `UPDATE staging.unresolved_employers
       SET    resolved_at = NOW(),
              resolved_to_id = $2
       WHERE  id = $1`,
      [unresolvedId, canonicalId],
    );

    await client.query('COMMIT');
    return { resolved: 1, backfilled: backfillResult.rowCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a brand-new canonical_employer from the unresolved entry, then
 * merge the unresolved row into it.
 */
export async function createCanonicalAndMerge({ unresolvedId, canonicalName }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM staging.unresolved_employers
       WHERE id = $1 AND resolved_at IS NULL FOR UPDATE`,
      [unresolvedId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { created: 0, backfilled: 0 };
    }
    const u = rows[0];
    const finalName = (canonicalName ?? u.employer_name).trim();

    // If a FEIN exists and already maps to a canonical, prefer that one
    // (FEIN is the unique key for Layer 1).
    let canonicalId = null;
    if (u.employer_fein) {
      const existing = await client.query(
        `SELECT id FROM canonical_employers WHERE fein = $1`,
        [u.employer_fein],
      );
      if (existing.rows.length > 0) canonicalId = existing.rows[0].id;
    }

    if (!canonicalId) {
      const insert = await client.query(
        `INSERT INTO canonical_employers
            (canonical_name, fein, employer_city, employer_state, record_count)
         VALUES ($1, $2, $3, $4, 0)
         RETURNING id`,
        [finalName, u.employer_fein, u.employer_city, u.employer_state],
      );
      canonicalId = insert.rows[0].id;
    }

    // Backfill matching records (delegate logic shared with mergeUnresolved).
    const stateFilter = u.employer_state
      ? `AND data->>'EMPLOYER_STATE' = $3`
      : '';
    const stateParam = u.employer_state ? [u.employer_state] : [];
    const backfillResult = await client.query(
      `UPDATE lca_records
       SET    data = data || jsonb_build_object('canonical_employer_id', $1::text)
       WHERE  lower(data->>'EMPLOYER_NAME') = lower($2)
         ${stateFilter}
         AND  (data->>'canonical_employer_id' IS NULL OR data->>'canonical_employer_id' = '')`,
      [canonicalId, u.employer_name, ...stateParam],
    );

    if (backfillResult.rowCount > 0) {
      await client.query(
        `UPDATE canonical_employers
         SET    record_count = record_count + $2,
                updated_at = NOW()
         WHERE  id = $1`,
        [canonicalId, backfillResult.rowCount],
      );
    }

    await client.query(
      `UPDATE staging.unresolved_employers
       SET    resolved_at = NOW(),
              resolved_to_id = $2
       WHERE  id = $1`,
      [unresolvedId, canonicalId],
    );

    await client.query('COMMIT');
    return { created: 1, canonicalId, backfilled: backfillResult.rowCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectUnresolved({ id, note }) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE staging.unresolved_employers
     SET    resolved_at = NOW(),
            resolved_to_id = NULL
     WHERE  id = $1 AND resolved_at IS NULL`,
    [id],
  );
  // Note is intentionally not stored — the table has no notes column.
  // Rejection is rare enough that a hits/state context in the audit log is fine.
  return rowCount;
}
