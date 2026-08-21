const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://postgres:sYrR4TfPkEdp2G7@database-1.cr40008amyqn.us-east-2.rds.amazonaws.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const cid = '12d12fd9-3f60-4e4f-b90c-55d7c583776d';
  const c = await pool.query('SELECT * FROM "Campaign" WHERE id = $1', [cid]);
  console.log('Campaign:', c.rows[0]);
  
  const contacts = await pool.query('SELECT id, email, "firstName", "lastName", attributes FROM "Contact" WHERE "audienceId" = $1', [c.rows[0].audienceId]);
  console.log('Contacts in DigiReps audience:', contacts.rows.length, contacts.rows.slice(0, 3));
  
  const msgs = await pool.query('SELECT id, "contactId", status, "enqueuedAt", "sentAt" FROM "Message" WHERE "campaignId" = $1', [cid]);
  console.log('Messages count:', msgs.rows.length, msgs.rows.slice(0, 3));
  
  const snap = await pool.query('SELECT * FROM "AnalyticsSnapshot" WHERE "campaignId" = $1', [cid]);
  console.log('Snapshot:', snap.rows[0]);
}

check().then(() => pool.end()).catch(console.error);