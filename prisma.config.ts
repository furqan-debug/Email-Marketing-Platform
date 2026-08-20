import "dotenv/config";
import { defineConfig } from "prisma/config";

const dbUrl =
  process.env["DATABASE_URL"] ||
  process.env["POSTGRES_URL"] ||
  process.env["DATABASE_PUBLIC_URL"] ||
  process.env["DATABASE_PRIVATE_URL"] ||
  "";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: dbUrl,
  },
});

