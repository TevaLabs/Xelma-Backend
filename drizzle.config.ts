import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://xelma:xelma@localhost:5432/xelma',
  },
});
