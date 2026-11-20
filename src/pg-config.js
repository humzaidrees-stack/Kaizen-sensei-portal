// Shared Postgres pool settings for local Postgres and hosted providers (Neon).

export function poolConfig(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(connectionString);
  const ssl = local ? undefined : { rejectUnauthorized: false };
  return {
    connectionString,
    ssl,
    max: Number(process.env.PG_POOL_MAX || 4),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    allowExitOnIdle: true,
  };
}
