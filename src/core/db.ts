import postgres from 'postgres';

export type Sql = ReturnType<typeof postgres>;

let connection: Sql | null = null;

export function connect(databaseUrl?: string): Sql {
  if (connection) return connection;

  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }

  // Supabase transaction pooler (port 6543) does not support prepared
  // statements. Auto-detect and disable prepares in that case. Session
  // pooler (5432) and direct connections keep prepares enabled.
  const usingTxPooler = url.includes(':6543');

  connection = postgres(url, {
    prepare: !usingTxPooler,
    idle_timeout: 20,
    connect_timeout: 10,
    max: 10,
    types: { bigint: postgres.BigInt },
  });

  return connection;
}

export async function disconnect(): Promise<void> {
  if (connection) {
    await connection.end();
    connection = null;
  }
}

export function getConnection(): Sql {
  if (!connection) {
    throw new Error('DB not connected. Call connect() first.');
  }
  return connection;
}
