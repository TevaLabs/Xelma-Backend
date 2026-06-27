import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import config from '../config';

const pool = new Pool({
  connectionString: config.database.url,
});

export const db = drizzle(pool, { schema });
export { pool };
