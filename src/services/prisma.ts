import { PrismaClient } from '@prisma/client';

// Single shared client: each PrismaClient holds its own connection pool, and
// the app previously created ~15 of them. One pool keeps Railway Postgres
// connection usage predictable and gives graceful shutdown one thing to close.
export const prisma = new PrismaClient();
