import { Pool } from 'pg';

const connectionString = 'postgresql://postgres:9NqG09MbhvGfO19J3c8U@email-marketing-db.czw64sc8i7l0.us-east-2.rds.amazonaws.com:5432/email_marketing_prod';

async function run() {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  const campaignId = 'db3480ec-a44c-42b2-8474-66452738cc16';

  console.log('--- CAMPAIGN ---');
  const camp = await pool.query('SELECT * FROM "Campaign" WHERE id = $1', [campaignId]);
  console.log(camp.rows[0]);

  console.log('\n--- STEPS ---');
  const steps = await pool.query('SELECT * FROM "CampaignStep" WHERE "campaignId" = $1 ORDER BY "stepOrder" ASC', [campaignId]);
  console.log(steps.rows);

  console.log('\n--- LEADS STATUS ---');
  const leads = await pool.query('SELECT status, count(*) FROM "CampaignLead" WHERE "campaignId" = $1 GROUP BY status', [campaignId]);
  console.log(leads.rows);

  console.log('\n--- MESSAGES ---');
  const msgs = await pool.query('SELECT count(*) FROM "Message" WHERE "campaignId" = $1', [campaignId]);
  console.log('Total Message rows:', msgs.rows[0]);

  console.log('\n--- CONSTRAINTS ON Message ---');
  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'Message';
  `);
  console.log(constraints.rows);

  pool.end();
}

run().catch((err) => {
  console.error('❌ Pipeline Test Failed:', err);
  process.exit(1);
});
