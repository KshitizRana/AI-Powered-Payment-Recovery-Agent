import "dotenv/config";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, count, desc, eq, gte, sql, sum } from "drizzle-orm";

import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({
    connectionString,
});

export const db = drizzle({ client: pool });

export { pool };
export { schema };
export { eq, and, gte, sql, desc, count, sum }

export * from "./schema";

export type Database = typeof db;
