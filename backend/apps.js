const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const staticRoot = path.join(root, 'frontend');
const requiredVariables = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingConfig = requiredVariables.filter((name) => !process.env[name]);
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');

if (supabaseUrl && !/^https:\/\//i.test(supabaseUrl)) {
  throw new Error('SUPABASE_URL harus menggunakan HTTPS.');
}

const config = {
  url: supabaseUrl,
  anonKey: process.env.SUPABASE_ANON_KEY,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  port: Number(process.env.PORT || 3000),
  missing: missingConfig
};
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const resources = {
  kas: { table: 'kas', columns: ['nama', 'deskripsi', 'warna', 'induk_kas_id'], required: ['nama'] },
  kategori: { table: 'kategori', columns: ['nama', 'jenis', 'warna'], required: ['nama', 'jenis'] }
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Ukuran permintaan melebihi 1 MB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Format JSON tidak valid.'); }
}

function validatePayload(body, fields, required) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Data permintaan tidak valid.');
  const payload = {};
  for (const field of fields) {
    if (body[field] !== undefined) payload[field] = body[field];
    if (required.includes(field) && (body[field] === undefined || body[field] === null || body[field] === '')) {
      throw new HttpError(400, `Kolom ${field} wajib diisi.`);
    }
  }
  if (!Object.keys(payload).length) throw new HttpError(400, 'Tidak ada perubahan yang dikirim.');
  return payload;
}

function supabaseHeaders(key, token, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${token}`, ...extra };
}

async function supabaseRequest(route, { method = 'GET', key = config.serviceRoleKey, token = config.serviceRoleKey, body, prefer } = {}) {
  if (!config.url || !key || !token) throw new HttpError(503, 'Konfigurasi Supabase belum lengkap.');
  const headers = supabaseHeaders(key, token, { 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) });
  let response;
  try {
    response = await fetch(`${config.url}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new HttpError(502, `Tidak dapat menghubungi Supabase: ${error.message}`);
  }
  const text = await response.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!response.ok) {
    const message = data?.message || data?.msg || data?.hint || 'Permintaan database ditolak.';
    const status = response.status === 404 ? 404 : response.status === 409 ? 409 : response.status === 400 ? 400 : 502;
    throw new HttpError(status, message);
  }
  return data;
}

function assertConfigured() {
  if (config.missing.length) throw new HttpError(503, `Konfigurasi server belum lengkap: ${config.missing.join(', ')}`);
}

async function authenticate(request) {
  assertConfigured();
  const authorization = request.headers.authorization || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Sesi berakhir. Silakan masuk kembali.');
  const user = await supabaseRequest('/auth/v1/user', { key: config.anonKey, token });
  if (!user?.id) throw new HttpError(401, 'Sesi Supabase tidak valid.');
  return { token, user };
}

async function insertRow(table, payload) {
  const rows = await supabaseRequest(`/rest/v1/${table}`, { method: 'POST', body: payload, prefer: 'return=representation' });
  if (!Array.isArray(rows) || !rows[0]) throw new HttpError(502, 'Supabase tidak mengembalikan data tersimpan.');
  return rows[0];
}

async function patchRow(table, id, payload) {
  const rows = await supabaseRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: payload, prefer: 'return=representation' });
  if (!Array.isArray(rows) || !rows[0]) throw new HttpError(404, 'Data tidak ditemukan.');
  return rows[0];
}

async function deleteRow(table, id) {
  await supabaseRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
}

function validateTransaction(body) {
  const required = ['tanggal', 'jenis', 'catatan'];
  if (!body || required.some((field) => body[field] === undefined || body[field] === '')) throw new HttpError(400, 'Tanggal, jenis, dan catatan wajib diisi.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.tanggal) || Number.isNaN(Date.parse(`${body.tanggal}T00:00:00Z`))) throw new HttpError(400, 'Tanggal transaksi tidak valid.');
  if (!['masuk', 'keluar', 'transfer'].includes(body.jenis)) throw new HttpError(400, 'Jenis transaksi tidak valid.');
  if (typeof body.catatan !== 'string' || body.catatan.trim().length < 2 || body.catatan.trim().length > 180) throw new HttpError(400, 'Catatan transaksi harus berisi 2 sampai 180 karakter.');
  const nominal = Number(body.nominal);
  if (!Number.isFinite(nominal) || nominal <= 0 || nominal > 999999999999) throw new HttpError(400, 'Nominal harus lebih besar dari nol dan tidak melebihi batas.');
  if (body.jenis === 'transfer') {
    if (!/^[0-9a-f-]{36}$/i.test(body.kas_id) || !/^[0-9a-f-]{36}$/i.test(body.kas_tujuan_id)) throw new HttpError(400, 'Kas sumber dan kas tujuan wajib dipilih.');
    if (body.kas_id === body.kas_tujuan_id) throw new HttpError(400, 'Kas sumber dan kas tujuan harus berbeda.');
    return {
      transaction: { tanggal: body.tanggal, jenis: 'transfer', catatan: body.catatan.trim() },
      transfer: { kas_sumber_id: body.kas_id, kas_tujuan_id: body.kas_tujuan_id, nominal }
    };
  }
  if (!body.kas_id || !/^[0-9a-f-]{36}$/i.test(body.kas_id) || !/^[0-9a-f-]{36}$/i.test(body.kategori_id)) throw new HttpError(400, 'Akun kas dan kategori wajib dipilih.');
  return {
    transaction: { tanggal: body.tanggal, jenis: body.jenis, catatan: body.catatan.trim() },
    detail: { kas_id: body.kas_id, kategori_id: body.kategori_id, nominal, catatan: String(body.detail_catatan || '').trim().slice(0, 180) }
  };
}

async function handleCollection(request, response, resourceName, id) {
  const resource = resources[resourceName];
  if (!resource) throw new HttpError(404, 'Endpoint tidak ditemukan.');
  if (request.method === 'GET' && !id) {
    const rows = await supabaseRequest(`/rest/v1/${resource.table}?select=*&order=created_at.desc`);
    return sendJson(response, 200, rows);
  }
  if (request.method === 'POST' && !id) {
    const payload = validatePayload(await readJson(request), resource.columns, resource.required);
    return sendJson(response, 201, await insertRow(resource.table, payload));
  }
  if (request.method === 'PATCH' && id) {
    const payload = validatePayload(await readJson(request), resource.columns, []);
    return sendJson(response, 200, await patchRow(resource.table, id, payload));
  }
  if (request.method === 'DELETE' && id) {
    await deleteRow(resource.table, id);
    return sendJson(response, 204, {});
  }
  throw new HttpError(405, 'Metode permintaan tidak diizinkan.');
}

async function handleTransactions(request, response, id) {
  if (request.method === 'GET' && !id) {
    const rows = await supabaseRequest('/rest/v1/transaksi?select=*,detail_transaksi(id,kas_id,kategori_id,arah,nominal,catatan,kas(nama),kategori(nama))&order=tanggal.desc,created_at.desc');
    return sendJson(response, 200, rows);
  }
  if (request.method === 'POST' && !id) {
    const payload = validateTransaction(await readJson(request));
    if (payload.transaction.jenis === 'transfer') {
      const transactionId = await supabaseRequest('/rest/v1/rpc/simpan_transfer_kas', {
        method: 'POST',
        body: {
          p_transaksi_id: null,
          p_tanggal: payload.transaction.tanggal,
          p_catatan: payload.transaction.catatan,
          p_kas_sumber_id: payload.transfer.kas_sumber_id,
          p_kas_tujuan_id: payload.transfer.kas_tujuan_id,
          p_nominal: payload.transfer.nominal
        }
      });
      return sendJson(response, 201, { id: transactionId });
    }
    const transaction = await insertRow('transaksi', payload.transaction);
    try {
      await insertRow('detail_transaksi', { ...payload.detail, transaksi_id: transaction.id });
    } catch (error) {
      await deleteRow('transaksi', transaction.id).catch(() => {});
      throw error;
    }
    return sendJson(response, 201, { id: transaction.id });
  }
  if (request.method === 'PATCH' && id) {
    const payload = validateTransaction(await readJson(request));
    if (payload.transaction.jenis === 'transfer') {
      const transactionId = await supabaseRequest('/rest/v1/rpc/simpan_transfer_kas', {
        method: 'POST',
        body: {
          p_transaksi_id: id,
          p_tanggal: payload.transaction.tanggal,
          p_catatan: payload.transaction.catatan,
          p_kas_sumber_id: payload.transfer.kas_sumber_id,
          p_kas_tujuan_id: payload.transfer.kas_tujuan_id,
          p_nominal: payload.transfer.nominal
        }
      });
      return sendJson(response, 200, { id: transactionId });
    }
    await patchRow('transaksi', id, payload.transaction);
    const details = await supabaseRequest(`/rest/v1/detail_transaksi?select=id&transaksi_id=eq.${encodeURIComponent(id)}&order=created_at.asc`);
    if (details?.[0]?.id) {
      await patchRow('detail_transaksi', details[0].id, payload.detail);
    } else {
      await insertRow('detail_transaksi', { ...payload.detail, transaksi_id: id });
    }
    await Promise.all((details || []).slice(1).map((detail) => deleteRow('detail_transaksi', detail.id)));
    return sendJson(response, 200, { id });
  }
  if (request.method === 'DELETE' && id) {
    await deleteRow('transaksi', id);
    return sendJson(response, 204, {});
  }
  throw new HttpError(405, 'Metode permintaan tidak diizinkan.');
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, configured: config.missing.length === 0, missing: config.missing });
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    assertConfigured();
    const credentials = await readJson(request);
    const result = await supabaseRequest('/auth/v1/token?grant_type=password', { method: 'POST', key: config.anonKey, token: config.anonKey, body: { email: credentials.email, password: credentials.password } });
    if (!result?.access_token || !result.user) throw new HttpError(401, 'Email atau kata sandi tidak sesuai.');
    return sendJson(response, 200, { access_token: result.access_token, user: { id: result.user.id, email: result.user.email } });
  }
  if (url.pathname === '/api/auth/anonymous-login' && request.method === 'POST') {
    assertConfigured();
    const result = await supabaseRequest('/auth/v1/signup', { method: 'POST', key: config.anonKey, token: config.anonKey, body: { data: {} } });
    if (!result?.access_token || !result.user) throw new HttpError(503, 'Aktifkan Anonymous Sign-ins pada pengaturan Authentication Supabase.');
    return sendJson(response, 200, { access_token: result.access_token, user: { id: result.user.id, is_anonymous: true } });
  }
  const session = await authenticate(request);
  response.locals = { user: session.user };
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    await supabaseRequest('/auth/v1/logout', { method: 'POST', key: config.anonKey, token: session.token });
    return sendJson(response, 200, { ok: true });
  }
  if (url.pathname === '/api/me' && request.method === 'GET') return sendJson(response, 200, { id: session.user.id, email: session.user.email });
  const match = url.pathname.match(/^\/api\/(kas|kategori|transaksi)(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) throw new HttpError(404, 'Endpoint tidak ditemukan.');
  if (match[1] === 'transaksi') return handleTransactions(request, response, match[2]);
  return handleCollection(request, response, match[1], match[2]);
}

async function serveStatic(request, response, pathname) {
  const journalRoute = pathname === '/jurnal-kas'
    || pathname === '/cetak/kas-semua'
    || /^\/cetak\/kas\/[0-9a-f-]{36}$/i.test(pathname);
  const routePath = journalRoute ? '/html/index.html' : pathname === '/' ? '/html/index.html' : pathname;
  const filePath = path.resolve(staticRoot, `.${decodeURIComponent(routePath)}`);
  if (!filePath.startsWith(`${staticRoot}${path.sep}`)) throw new HttpError(403, 'Akses berkas ditolak.');
  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { throw new HttpError(404, 'Halaman tidak ditemukan.'); }
  if (!stat.isFile()) throw new HttpError(404, 'Halaman tidak ditemukan.');
  response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
  if (journalRoute) {
    const html = await fs.promises.readFile(filePath, 'utf8');
    response.end(html.replace('<head>', '<head>\n  <base href="/">'));
    return;
  }
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (['GET', 'HEAD'].includes(request.method)) await serveStatic(request, response, url.pathname);
    else throw new HttpError(405, 'Metode permintaan tidak diizinkan.');
  } catch (error) {
    if (response.headersSent) return response.destroy();
    sendJson(response, error.status || 500, { error: error.status ? error.message : 'Terjadi kesalahan server.' });
    if (!error.status) console.error(error);
  }
});

server.listen(config.port, () => {
  console.log(`Annisa Beno Cafe berjalan di http://localhost:${config.port}`);
  if (config.missing.length) console.warn(`Konfigurasi belum lengkap: ${config.missing.join(', ')}`);
});
