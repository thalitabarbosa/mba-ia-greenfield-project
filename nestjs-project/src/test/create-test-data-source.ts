import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

type EntityClass = new (...args: any[]) => object;

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

export function createTestDataSource(
  entities: (EntityClass | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  // videos → channels FK: the table may exist (via migrations) even when the
  // suite's DataSource does not register the Video entity.
  if (await hasTable(dataSource, 'videos')) {
    await dataSource.query('DELETE FROM "videos"');
  }
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}

async function hasTable(
  dataSource: DataSource,
  table: string,
): Promise<boolean> {
  const rows = await dataSource.query<{ exists: boolean }[]>(
    `SELECT to_regclass($1) IS NOT NULL AS "exists"`,
    [`public.${table}`],
  );
  return rows[0]?.exists === true;
}
