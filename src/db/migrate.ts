import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db';

async function main() {
  console.log('Running Drizzle migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Drizzle migrations completed successfully!');
  await pool.end();
}

main().catch((err) => {
  console.error('Drizzle migration failed:', err);
  process.exit(1);
});
