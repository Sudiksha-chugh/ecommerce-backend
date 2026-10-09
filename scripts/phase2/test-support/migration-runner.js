// SQL-compatible runner; no connections, roles, databases or CLI side effects on import.
const {loadManifest} = require('./migration-manifest');
const LOCK_NAMESPACE = 210021;
function refuse(message) {throw new Error(`Test migration refused: ${message}`);}
async function migrateTestDatabase(client, {service, database, provenanceToken}) {
  const migrations = loadManifest(service);
  if (typeof database !== 'string' || !/^[a-z][a-z0-9_]*_test$/.test(database)) refuse('explicit test database required');
  if (typeof provenanceToken !== 'string' || !provenanceToken) refuse('provisioner provenance required');
  const identity = (await client.query(`SELECT current_database() AS database,
    oid::text AS database_oid FROM pg_database WHERE datname=current_database()`)).rows[0];
  if (!identity || identity.database !== database) refuse('connected database differs from target');
  let locked = false;
  const applied = [], skipped = [];
  try {
    await client.query('SELECT pg_advisory_lock($1,$2)', [LOCK_NAMESPACE, Number(identity.database_oid) | 0]);
    locked = true;
    const marker = (await client.query("SELECT to_regclass('public.phase21_test_provenance') AS relation")).rows[0];
    if (!marker?.relation) refuse('fresh-test provenance table missing');
    // Stage B creates this marker only when it creates a new empty test database.
    const provenance = (await client.query(`SELECT service, database_oid::text, token,
      origin FROM public.phase21_test_provenance WHERE singleton=TRUE`)).rows;
    if (provenance.length !== 1 || provenance[0].service !== service ||
        provenance[0].database_oid !== identity.database_oid ||
        provenance[0].token !== provenanceToken || provenance[0].origin !== 'created-empty-test') {
      refuse('fresh-test provenance mismatch');
    }
    const objects = (await client.query(`SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`)).rows;
    const trackingExists = objects.some(row => row.name === 'schema_migrations');
    const history = trackingExists ? (await client.query('SELECT filename,checksum FROM public.schema_migrations ORDER BY position')).rows : [];
    if (!history.length && objects.some(row => !['phase21_test_provenance','schema_migrations'].includes(row.name))) {
      refuse('existing untracked application schema');
    }
    // Validate the entire history before making changes, including later checksums.
    if (history.length > migrations.length) refuse('unknown migration history');
    for (let index = 0; index < history.length; index++) {
      if (history[index].filename !== migrations[index].filename) refuse('migration history is not a manifest prefix');
      if (history[index].checksum !== migrations[index].checksum) refuse('migration checksum mismatch');
    }
    for (const migration of migrations) {
      if (migration.requiresFreshTest && !migration.authorizedFreshTest) refuse('destructive migration lacks manifest authorization');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      position INTEGER NOT NULL UNIQUE, filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (let index = 0; index < migrations.length; index++) {
      const migration = migrations[index];
      if (index < history.length) {skipped.push(migration.filename); continue;}
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL search_path TO public, pg_catalog');
        await client.query(migration.sql);
        await client.query(`INSERT INTO public.schema_migrations(position,filename,checksum)
          VALUES($1,$2,$3)`, [index, migration.filename, migration.checksum]);
        await client.query('COMMIT');
        applied.push(migration.filename);
      } catch (error) {
        await client.query('ROLLBACK');
        // Do not print SQL, connection strings or provider error details.
        throw Object.assign(new Error(`Test migration failed: ${service}/${migration.filename}`), {cause:error});
      }
    }
    return {service, database, applied, skipped};
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_NAMESPACE, Number(identity.database_oid) | 0]);
  }
}
module.exports = {migrateTestDatabase};
