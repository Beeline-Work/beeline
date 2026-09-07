import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const { Client } = require('pg');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function qualified(name) {
  return `public.${quoteIdentifier(name)}`;
}

async function tables(client) {
  const result = await client.query(`
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
  `);
  return result.rows.map((row) => row.name);
}

async function columns(client, table) {
  const result = await client.query(
    `SELECT a.attname AS name, t.typname AS type
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = 'public' AND c.relname = $1
       AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     ORDER BY a.attnum`,
    [table],
  );
  return result.rows;
}

async function primaryKeyColumns(client, table) {
  const result = await client.query(
    `SELECT ARRAY(
       SELECT attribute.attname
       FROM unnest(constraint_row.conkey) WITH ORDINALITY key(attnum, position)
       JOIN pg_attribute attribute
         ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
       ORDER BY key.position
     )::text[] AS columns
     FROM pg_constraint constraint_row
     JOIN pg_class table_class ON table_class.oid = constraint_row.conrelid
     JOIN pg_namespace table_ns ON table_ns.oid = table_class.relnamespace
     WHERE constraint_row.contype = 'p'
       AND table_ns.nspname = 'public' AND table_class.relname = $1`,
    [table],
  );
  return result.rows[0]?.columns ?? [];
}

async function foreignKeys(client) {
  const result = await client.query(`
    SELECT child.relname AS child_table, parent.relname AS parent_table,
      ARRAY(
        SELECT child_att.attname
        FROM unnest(con.conkey) WITH ORDINALITY key(attnum, position)
        JOIN pg_attribute child_att
          ON child_att.attrelid = con.conrelid AND child_att.attnum = key.attnum
        ORDER BY key.position
      )::text[] AS child_columns,
      ARRAY(
        SELECT parent_att.attname
        FROM unnest(con.confkey) WITH ORDINALITY key(attnum, position)
        JOIN pg_attribute parent_att
          ON parent_att.attrelid = con.confrelid AND parent_att.attnum = key.attnum
        ORDER BY key.position
      )::text[] AS parent_columns
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE con.contype = 'f'
      AND child_ns.nspname = 'public' AND parent_ns.nspname = 'public'
    ORDER BY child.relname, con.conname
  `);
  return result.rows;
}

function orderedTables(names, keys) {
  const remaining = new Set(names);
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining].filter((table) =>
      keys.every(
        (key) =>
          key.child_table !== table ||
          key.parent_table === table ||
          !remaining.has(key.parent_table),
      ),
    );
    if (!ready.length) {
      throw new Error(`cross-table foreign-key cycle: ${[...remaining].join(', ')}`);
    }
    for (const table of ready.sort()) {
      remaining.delete(table);
      ordered.push(table);
    }
  }
  return ordered;
}

function keyFor(row, names) {
  return JSON.stringify(names.map((name) => row[name]));
}

function orderSelfReferences(rows, keys) {
  if (!keys.length) return rows;
  const remaining = [...rows];
  const available = new Map(keys.map((key) => [key, new Set()]));
  const ordered = [];
  while (remaining.length) {
    let progressed = false;
    for (let index = 0; index < remaining.length;) {
      const row = remaining[index];
      const ready = keys.every((key) => {
        const values = key.child_columns.map((name) => row[name]);
        return (
          values.some((value) => value === null) || available.get(key).has(JSON.stringify(values))
        );
      });
      if (!ready) {
        index += 1;
        continue;
      }
      remaining.splice(index, 1);
      ordered.push(row);
      for (const key of keys) available.get(key).add(keyFor(row, key.parent_columns));
      progressed = true;
    }
    if (!progressed) throw new Error('unresolved self-referencing rows');
  }
  return ordered;
}

function parameterValue(value, type) {
  if (value !== null && (type === 'json' || type === 'jsonb')) return JSON.stringify(value);
  return value;
}

async function insertRows(target, table, tableColumns, rows, delta) {
  if (!rows.length) return;
  const columnSql = tableColumns.map((column) => quoteIdentifier(column.name)).join(', ');
  const maximumBatchRows = Math.max(1, Math.floor(60_000 / tableColumns.length));
  const batchRows = Math.min(200, maximumBatchRows);
  for (let offset = 0; offset < rows.length; offset += batchRows) {
    const batch = rows.slice(offset, offset + batchRows);
    const values = [];
    const tuples = batch.map((row) => {
      const placeholders = tableColumns.map((column) => {
        values.push(parameterValue(row[column.name], column.type));
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await target.query(
      `INSERT INTO ${qualified(table)} (${columnSql}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}${delta ? ' ON CONFLICT DO NOTHING' : ''}`,
      values,
    );
  }
}

async function resetSequences(target) {
  const result = await target.query(`
    SELECT table_class.relname AS table_name, column_att.attname AS column_name,
      sequence_class.relname AS sequence_name
    FROM pg_class sequence_class
    JOIN pg_namespace sequence_ns ON sequence_ns.oid = sequence_class.relnamespace
    JOIN pg_depend dependency
      ON dependency.objid = sequence_class.oid AND dependency.deptype IN ('a', 'i')
    JOIN pg_class table_class ON table_class.oid = dependency.refobjid
    JOIN pg_namespace table_ns ON table_ns.oid = table_class.relnamespace
    JOIN pg_attribute column_att
      ON column_att.attrelid = table_class.oid AND column_att.attnum = dependency.refobjsubid
    WHERE sequence_class.relkind = 'S'
      AND sequence_ns.nspname = 'public' AND table_ns.nspname = 'public'
    ORDER BY table_class.relname, column_att.attname
  `);
  for (const row of result.rows) {
    const maximum = await target.query(
      `SELECT max(${quoteIdentifier(row.column_name)})::text AS value FROM ${qualified(row.table_name)}`,
    );
    const current = await target.query(
      `SELECT last_value::text AS value FROM public.${quoteIdentifier(row.sequence_name)}`,
    );
    const maximumValue = BigInt(maximum.rows[0].value ?? '0');
    const currentValue = BigInt(current.rows[0].value);
    const value = maximumValue > currentValue ? maximumValue : currentValue;
    await target.query(`SELECT setval($1::regclass, $2::bigint, true)`, [
      `public.${row.sequence_name}`,
      value === 0n ? '1' : value.toString(),
    ]);
  }
  return result.rows;
}

async function main() {
  const delta = process.argv[2] === '--delta';
  const sourceUrl = required('DATABASE_URL');
  const targetUrl = required('FLY_PG_URL');
  if (sourceUrl === targetUrl) throw new Error('source and target URLs must differ');

  const source = new Client({ connectionString: sourceUrl });
  const target = new Client({ connectionString: targetUrl });
  await Promise.all([source.connect(), target.connect()]);
  try {
    const identitySql = `SELECT current_database() AS database, current_setting('server_version_num')::int AS version`;
    const [sourceIdentity, targetIdentity] = await Promise.all([
      source.query(identitySql),
      target.query(identitySql),
    ]);
    if (Math.floor(sourceIdentity.rows[0].version / 10_000) !== 18) {
      throw new Error('refusing unexpected Neon PostgreSQL major version');
    }
    if (targetIdentity.rows[0].database !== 'fly-db') {
      throw new Error('refusing to replace data outside fly-db');
    }
    if (Math.floor(targetIdentity.rows[0].version / 10_000) !== 16) {
      throw new Error('refusing unexpected Fly PostgreSQL major version');
    }

    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await target.query('BEGIN');
    await target.query(`SELECT pg_advisory_xact_lock(hashtext('beeline-full-database-copy'))`);

    const [sourceTables, targetTables] = await Promise.all([tables(source), tables(target)]);
    const missingOnTarget = sourceTables.filter((table) => !targetTables.includes(table));
    const targetOnlyTables = targetTables.filter((table) => !sourceTables.includes(table));
    if (missingOnTarget.length) {
      throw new Error(`source tables missing on target: ${missingOnTarget.join(', ')}`);
    }
    for (const table of targetOnlyTables) {
      const result = await target.query(`SELECT count(*)::int AS count FROM ${qualified(table)}`);
      if (!delta && result.rows[0].count !== 0) {
        throw new Error(`${table}: target-only application table is not empty`);
      }
    }
    const keys = await foreignKeys(target);
    const order = orderedTables(sourceTables, keys);
    const truncateList = sourceTables.map(qualified).join(', ');
    if (!delta) await target.query(`TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`);

    const expectedCounts = new Map();
    const expectedPrimaryKeys = new Map();
    for (const table of order) {
      const tableColumns = await columns(source, table);
      const rows = (await source.query(`SELECT * FROM ${qualified(table)}`)).rows;
      const selfKeys = keys.filter(
        (key) => key.child_table === table && key.parent_table === table,
      );
      const orderedRows = orderSelfReferences(rows, selfKeys);
      await insertRows(target, table, tableColumns, orderedRows, delta);
      expectedCounts.set(table, rows.length);
      const primaryColumns = await primaryKeyColumns(source, table);
      expectedPrimaryKeys.set(
        table,
        primaryColumns.length
          ? {
              columns: primaryColumns,
              keys: new Set(rows.map((row) => keyFor(row, primaryColumns))),
            }
          : undefined,
      );
      console.log(`${table}: ${rows.length}`);
    }

    const sequences = await resetSequences(target);
    for (const table of sourceTables) {
      const result = await target.query(`SELECT count(*)::int AS count FROM ${qualified(table)}`);
      if (!delta && result.rows[0].count !== expectedCounts.get(table)) {
        throw new Error(`${table}: target row count does not match source snapshot`);
      }
      if (delta && result.rows[0].count < expectedCounts.get(table)) {
        throw new Error(`${table}: target has fewer rows than source snapshot after delta`);
      }
      const primary = expectedPrimaryKeys.get(table);
      if (delta && primary) {
        const targetKeys = new Set(
          (
            await target.query(
              `SELECT ${primary.columns.map(quoteIdentifier).join(', ')} FROM ${qualified(table)}`,
            )
          ).rows.map((row) => keyFor(row, primary.columns)),
        );
        for (const key of primary.keys) {
          if (!targetKeys.has(key))
            throw new Error(`${table}: source primary key missing after delta`);
        }
      }
    }

    await target.query('COMMIT');
    await source.query('COMMIT');
    console.log(
      `${delta ? 'delta verified source primary keys/count floors for' : 'verified'} ${sourceTables.length} source tables, preserved ${targetOnlyTables.length} target-only application tables, and advanced ${sequences.length} owned sequences`,
    );
  } catch (error) {
    await Promise.allSettled([source.query('ROLLBACK'), target.query('ROLLBACK')]);
    throw error;
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

async function createSchema() {
  const targetUrl = required('FLY_PG_URL');
  const serverModule = await import('/app/apps/server/dist/database.js');
  const authModule = await import('/app/apps/auth/dist/store.js');
  const pushModule = await import('/app/apps/push-gateway/dist/database.js');
  const serverDatabase = new serverModule.PostgresDatabase(targetUrl, 1);
  const authDatabase = new authModule.PostgresDatabase(targetUrl);
  const authStore = new authModule.AuthStore(authDatabase);
  const pushStore = new pushModule.PostgresMaterializerStore(targetUrl);
  try {
    await serverModule.migrate(serverDatabase);
    await authStore.migrate();
    await pushStore.connect();
    await pushStore.migrateReservations();
    await pushStore.migrateRoomReadMarks();
    await pushStore.migrateAgentPairingClaims();
    await pushStore.deleteSnapshotContract();
    console.log('server, auth, and push-gateway schema migrations complete');
  } finally {
    await Promise.allSettled([serverDatabase.close(), authStore.close(), pushStore.close()]);
  }
}

if (process.argv[2] === '--schema') await createSchema();
else await main();
