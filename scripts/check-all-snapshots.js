const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:sYrR4TfPkEdp2G7@database-1.cr40008amyqn.us-east-2.rds.amazonaws.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const campaigns = await pool.query('SELECT id, name, status FROM "Campaign"');
  console.log('Campaigns in DB:', campaigns.rows);
  const snapshots = await pool.query('SELECT * FROM "AnalyticsSnapshot"');
  console.log('Snapshots in DB:', snapshots.rows);
}

main().then(() => pool.end()).catch(console.error);