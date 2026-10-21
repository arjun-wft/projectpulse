const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

const { Pool, Client } = pg;

let pool = null;
let cleanupInterval = null;

function getSslConfig(rawUri = process.env.DATABASE_URI || '') {
  const isSslExplicitlyDisabled = /[?&]sslmode=disable\b/i.test(rawUri) && !process.env.DATABASE_SSL && !process.env.CA_PEM && !process.env.DATABASE_CA_CERT;
  const caPath = process.env.CA_PEM_PATH || path.join(__dirname, 'ca.pem');
  const hasCaFile = fs.existsSync(caPath);

  // If local/VPS PostgreSQL specifies sslmode=disable and no CA certificate is present, run without SSL
  if (isSslExplicitlyDisabled && !hasCaFile) {
    return false;
  }

  // If SSL is enabled, configure SSL and read ca.pem (or environment CA string)
  const ssl = { rejectUnauthorized: false };
  if (process.env.DATABASE_CA_CERT || process.env.CA_PEM) {
    ssl.ca = (process.env.DATABASE_CA_CERT || process.env.CA_PEM).replace(/\\n/g, '\n');
  } else if (hasCaFile) {
    try {
      ssl.ca = fs.readFileSync(caPath, 'utf8');
    } catch (err) {
      console.warn('[db ssl] Warning reading ca.pem:', err.message);
    }
  }
  return ssl;
}

function getCleanConnectionUri(targetDb = 'pulse_db') {
  const rawUri = process.env.DATABASE_URI;
  if (!rawUri) return null;
  // Strip existing query params like ?sslmode=...
  let uri = rawUri.replace(/[?&]sslmode=[^&]+/g, '').replace(/\?$/, '');
  // Replace database path with targetDb
  try {
    const parsed = new URL(uri);
    parsed.pathname = `/${targetDb}`;
    parsed.search = '';
    return parsed.toString();
  } catch {
    return uri.replace(/\/[^/?]+(\?.*)?$/, `/${targetDb}`);
  }
}

async function ensureDatabaseExists() {
  const rawUri = process.env.DATABASE_URI;
  if (!rawUri) return;
  const ssl = getSslConfig(rawUri);

  // Connect to the defaultdb or cluster root to check pulse_db
  let rootUri = rawUri.replace(/[?&]sslmode=[^&]+/g, '').replace(/\?$/, '');
  const client = new Client({ connectionString: rootUri, ssl: ssl || undefined });
  try {
    await client.connect();
    const checkRes = await client.query("SELECT 1 FROM pg_database WHERE datname = 'pulse_db';");
    if (checkRes.rows.length === 0) {
      await client.query('CREATE DATABASE pulse_db;');
      console.log("[db] Created database 'pulse_db'");
    }
  } catch (err) {
    console.warn('[db] Note on database check/create:', err.message);
  } finally {
    try { await client.end(); } catch {}
  }
}

async function initDb() {
  if (!process.env.DATABASE_URI) {
    console.warn('[db] DATABASE_URI is not set. Database persistence will be bypassed.');
    return null;
  }

  await ensureDatabaseExists();

  const pulseUri = getCleanConnectionUri('pulse_db');
  const ssl = getSslConfig(pulseUri);

  pool = new Pool({
    connectionString: pulseUri,
    ssl: ssl || undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', err => {
    console.error('[db pool error]', err);
  });

  // Create tables and indexes
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pulse_jobs (
        id VARCHAR(64) PRIMARY KEY,
        script VARCHAR(64) NOT NULL,
        title VARCHAR(255),
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        stage VARCHAR(255),
        processed INT DEFAULT 0,
        total INT DEFAULT 0,
        leads_found INT DEFAULT 0,
        options JSONB,
        result JSONB,
        error TEXT,
        user_message TEXT,
        file_name VARCHAR(255),
        raw_file_name VARCHAR(255),
        partial_ready BOOLEAN DEFAULT FALSE,
        raw_ready BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        download_count INT DEFAULT 0
      );

      ALTER TABLE pulse_jobs ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
      ALTER TABLE pulse_jobs ADD COLUMN IF NOT EXISTS raw_file_name VARCHAR(255);
      ALTER TABLE pulse_jobs ADD COLUMN IF NOT EXISTS partial_ready BOOLEAN DEFAULT FALSE;
      ALTER TABLE pulse_jobs ADD COLUMN IF NOT EXISTS raw_ready BOOLEAN DEFAULT FALSE;

      CREATE INDEX IF NOT EXISTS idx_pulse_jobs_expires_at ON pulse_jobs(expires_at);

      CREATE TABLE IF NOT EXISTS pulse_candidates (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL REFERENCES pulse_jobs(id) ON DELETE CASCADE,
        candidate_id VARCHAR(128) NOT NULL,
        role_key VARCHAR(64) NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_candidates_job_id ON pulse_candidates(job_id);

      CREATE TABLE IF NOT EXISTS pulse_leads (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(64) NOT NULL REFERENCES pulse_jobs(id) ON DELETE CASCADE,
        candidate_id VARCHAR(128) NOT NULL,
        project_data JSONB NOT NULL,
        analysis JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_leads_job_id ON pulse_leads(job_id);
    `);
    console.log("[db] Tables and indexes initialized successfully in 'pulse_db'");
  } finally {
    client.release();
  }

  // Initial purge of any already expired jobs
  await cleanupExpiredJobs();

  // Start periodic 5-minute TTL worker (runs every 60 seconds)
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      void cleanupExpiredJobs();
    }, 60 * 1000);
    cleanupInterval.unref?.();
  }

  return pool;
}

async function upsertJob(job) {
  if (!pool) return;
  const expiresAt = job.expiresAt ? new Date(job.expiresAt) : new Date(Date.now() + 5 * 60 * 1000);
  const completedAt = job.completedAt ? new Date(job.completedAt) : null;
  const query = `
    INSERT INTO pulse_jobs (
      id, script, title, status, stage, processed, total, leads_found, options, result, error, user_message, file_name, raw_file_name, partial_ready, raw_ready, completed_at, expires_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
    ON CONFLICT (id) DO UPDATE SET
      title = COALESCE(EXCLUDED.title, pulse_jobs.title),
      status = CASE WHEN EXCLUDED.status IS NOT NULL AND EXCLUDED.status != 'queued' THEN EXCLUDED.status ELSE pulse_jobs.status END,
      stage = CASE WHEN EXCLUDED.stage IS NOT NULL AND EXCLUDED.stage != '' THEN EXCLUDED.stage ELSE pulse_jobs.stage END,
      processed = CASE WHEN EXCLUDED.processed > 0 THEN EXCLUDED.processed ELSE pulse_jobs.processed END,
      total = CASE WHEN EXCLUDED.total > 0 THEN EXCLUDED.total ELSE pulse_jobs.total END,
      leads_found = CASE WHEN EXCLUDED.leads_found > 0 THEN EXCLUDED.leads_found ELSE pulse_jobs.leads_found END,
      options = COALESCE(EXCLUDED.options, pulse_jobs.options),
      result = COALESCE(EXCLUDED.result, pulse_jobs.result),
      error = COALESCE(EXCLUDED.error, pulse_jobs.error),
      user_message = COALESCE(EXCLUDED.user_message, pulse_jobs.user_message),
      file_name = COALESCE(EXCLUDED.file_name, pulse_jobs.file_name),
      raw_file_name = COALESCE(EXCLUDED.raw_file_name, pulse_jobs.raw_file_name),
      partial_ready = EXCLUDED.partial_ready OR pulse_jobs.partial_ready,
      raw_ready = EXCLUDED.raw_ready OR pulse_jobs.raw_ready,
      completed_at = COALESCE(EXCLUDED.completed_at, pulse_jobs.completed_at),
      expires_at = COALESCE(EXCLUDED.expires_at, pulse_jobs.expires_at),
      updated_at = NOW();
  `;
  const values = [
    job.id,
    job.script,
    job.title || null,
    job.status || 'queued',
    job.stage || '',
    job.processed || 0,
    job.total || 0,
    job.leadsFound || 0,
    job.options ? JSON.stringify(job.options) : null,
    job.result ? JSON.stringify(job.result) : null,
    job.error || null,
    job.userMessage || null,
    job.fileName || null,
    job.rawFileName || null,
    Boolean(job.partialReady),
    Boolean(job.rawReady),
    completedAt,
    expiresAt,
  ];
  await pool.query(query, values);
}

async function saveCandidates(jobId, roleKey, candidates) {
  if (!pool || !Array.isArray(candidates) || candidates.length === 0) return;
  // Batch insert up to 100 candidates per query
  const batchSize = 100;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const slice = candidates.slice(i, i + batchSize);
    const valueClauses = [];
    const values = [];
    let p = 1;
    for (const item of slice) {
      const candidateId = String(item.id || item.tweet?.id || item.project?.id || `${i}`);
      valueClauses.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      values.push(jobId, candidateId, roleKey, JSON.stringify(item));
    }
    const sql = `
      INSERT INTO pulse_candidates (job_id, candidate_id, role_key, data)
      VALUES ${valueClauses.join(', ')}
    `;
    await pool.query(sql, values);
  }
}

async function saveLeadBatch(jobId, leads) {
  if (!pool || !Array.isArray(leads) || leads.length === 0) return;
  const valueClauses = [];
  const values = [];
  let p = 1;
  for (const item of leads) {
    const candidateId = String(item.project?.id || item.tweet?.id || item.id || '');
    const projectData = item.project || item.tweet || item;
    const analysis = item.analysis || {};
    valueClauses.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
    values.push(jobId, candidateId, JSON.stringify(projectData), JSON.stringify(analysis));
  }
  const sql = `
    INSERT INTO pulse_leads (job_id, candidate_id, project_data, analysis)
    VALUES ${valueClauses.join(', ')}
  `;
  await pool.query(sql, values);
}

async function getCandidates(jobId) {
  if (!pool) return [];
  const res = await pool.query(
    'SELECT candidate_id, role_key, data FROM pulse_candidates WHERE job_id = $1 ORDER BY id ASC;',
    [jobId]
  );
  return res.rows.map(r => r.data);
}

async function getLeads(jobId) {
  if (!pool) return [];
  const res = await pool.query(
    'SELECT candidate_id, project_data, analysis FROM pulse_leads WHERE job_id = $1 ORDER BY id ASC;',
    [jobId]
  );
  return res.rows.map(r => ({
    project: r.project_data,
    tweet: r.project_data,
    analysis: r.analysis,
  }));
}

async function getJob(jobId) {
  if (!pool) return null;
  const res = await pool.query('SELECT * FROM pulse_jobs WHERE id = $1;', [jobId]);
  return res.rows[0] || null;
}

async function deleteJob(jobId) {
  if (!pool) return;
  // Cascades automatically to pulse_candidates and pulse_leads
  await pool.query('DELETE FROM pulse_jobs WHERE id = $1;', [jobId]);
}

async function cleanupExpiredJobs() {
  if (!pool) return 0;
  try {
    const res = await pool.query('DELETE FROM pulse_jobs WHERE expires_at <= NOW();');
    if (res.rowCount > 0) {
      console.log(`[db TTL] Purged ${res.rowCount} expired job(s) and their associated records.`);
    }
    return res.rowCount || 0;
  } catch (err) {
    console.error('[db TTL cleanup error]', err.message);
    return 0;
  }
}

async function closeDb() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initDb,
  getPool: () => pool,
  upsertJob,
  saveCandidates,
  saveLeadBatch,
  getCandidates,
  getLeads,
  getJob,
  deleteJob,
  cleanupExpiredJobs,
  closeDb,
};
