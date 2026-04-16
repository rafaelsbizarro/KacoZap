const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.post('/api/tenant', async (req, res) => {
  const { store_name, waba_phone_id, sheet_url, forbidden_phrases, fallback_type, owner_whatsapp, tone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query(
      `INSERT INTO tenants(store_name, waba_phone_id, sheet_url, fallback_type, owner_whatsapp, tone)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [store_name, waba_phone_id, sheet_url, fallback_type, owner_whatsapp, tone]
    );
    await client.query(
      `INSERT INTO policies(tenant_id, forbidden_phrases) VALUES($1, $2)`,
      [tenant.rows[0].id, forbidden_phrases]
    );
    await client.query('COMMIT');
    res.json({ success: true, tenant_id: tenant.rows[0].id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/webhook', async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const waba_phone_id = req.body.entry[0].changes[0].value.metadata.phone_number_id;
  const from = msg.from;
  const body = msg.text?.body || '';

  const { rows } = await pool.query(
    `SELECT t.*, p.* FROM tenants t JOIN policies p ON t.id = p.tenant_id WHERE t.waba_phone_id = $1`,
    [waba_phone_id]
  );
  if (!rows[0]) return res.sendStatus(200);
  const config = rows[0];

  const lowerBody = body.toLowerCase();
  if (config.forbidden_phrases?.some(p => lowerBody.includes(p.toLowerCase()))) {
    await sendWaba(from, waba_phone_id, "Opa, sobre isso preciso te transferir pro atendente.");
    return res.sendStatus(200);
  }

  let response = `Recebi sua mensagem na ${config.store_name}. ${config.tone === 'tiozao'? 'Tmj!' : 'Como posso ajudar?'}`;
  if (lowerBody.includes('preço')) {
    response = `Preço de etiqueta aqui na ${config.store_name}. Qual produto você quer?`;
  }

  await sendWaba(from, waba_phone_id, response);
  await pool.query(`INSERT INTO messages_log(tenant_id, from_number, body, response) VALUES($1,$2,$3,$4)`,
    [config.id, from, body, response]);
  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.WABA_VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

async function sendWaba(to, phone_id, text) {
  return axios.post(`https://graph.facebook.com/v20.0/${phone_id}/messages`, {
    messaging_product: "whatsapp",
    to,
    text: { body: text }
  }, {
    headers: { Authorization: `Bearer ${process.env.WABA_TOKEN}` }
  }).catch(console.error);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KacoZap rodando na porta ${PORT}`));
