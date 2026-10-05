const state = {
  token: null,
  user: null,
  kas: [],
  kategori: [],
  transaksi: [],
  filter: 'all',
  query: '',
  month: '',
  reportFrom: '',
  reportTo: '',
  reportRangeTouched: false,
  reportScope: 'overall',
  reportAccountId: 'all',
  selectedAccountId: null,
  modal: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const today = new Date();
const todayIso = dateKey(today);
const monthIso = todayIso.slice(0, 7);

function dateKey(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function money(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
}

function displayDate(value, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat('id-ID', options).format(new Date(`${value}T00:00:00`));
}

function icon(name, className = '') {
  return `<i data-lucide="${name}" class="${className}"></i>`;
}

function refreshIcons() {
  window.lucide?.createIcons();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const directFileMode = window.location.protocol === 'file:';
const githubPagesMode = window.location.hostname.endsWith('.github.io');
const directSupabaseMode = directFileMode || githubPagesMode;
const directSupabaseConfig = {
  url: 'https://skmcwhftpjfdmgludkjz.supabase.co',
  anonKey: 'sb_publishable_JSHsZBhehYojNBbiXJ8X1A_cdyTSOIp'
};
let directSupabaseClient = null;

function getDirectSupabaseStatus() {
  const config = directSupabaseConfig;
  const missing = [];
  if (!config.url || !/^https:\/\//i.test(config.url)) missing.push('SUPABASE_URL di frontend/js/apps.js');
  if (!config.anonKey) missing.push('SUPABASE_ANON_KEY di frontend/js/apps.js');
  if (!window.supabase?.createClient) missing.push('Supabase JS SDK (periksa koneksi internet)');
  if (missing.length) return { ok: true, configured: false, missing };

  if (!directSupabaseClient) {
    try {
      directSupabaseClient = window.supabase.createClient(config.url, config.anonKey, {
        auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
      });
    } catch (error) {
      return { ok: true, configured: false, missing: [error.message] };
    }
  }
  return { ok: true, configured: true, missing: [] };
}

async function requestDirect(path, options = {}) {
  if (path === '/api/health') return getDirectSupabaseStatus();
  const status = getDirectSupabaseStatus();
  if (!status.configured) throw new Error(`Supabase belum siap: ${status.missing.join(', ')}.`);

  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const client = directSupabaseClient;
  const throwIfError = (error) => { if (error) throw new Error(error.message || 'Permintaan Supabase gagal.'); };

  if (path === '/api/auth/login' && method === 'POST') {
    const { data, error } = await client.auth.signInWithPassword(body);
    throwIfError(error);
    state.token = data.session.access_token;
    return { access_token: data.session.access_token, user: { id: data.user.id, email: data.user.email } };
  }
  if (path === '/api/auth/anonymous-login' && method === 'POST') {
    const { data, error } = await client.auth.signInAnonymously();
    if (error) {
      const message = error.message.toLowerCase().includes('anonymous')
        ? 'Aktifkan Anonymous Sign-ins pada pengaturan Authentication Supabase untuk membuka dashboard tanpa login.'
        : error.message;
      throw new Error(message);
    }
    state.token = data.session.access_token;
    return { access_token: data.session.access_token, user: { id: data.user.id, is_anonymous: true } };
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const { error } = await client.auth.signOut();
    throwIfError(error);
    state.token = null;
    return { ok: true };
  }

  const match = path.match(/^\/api\/(kas|kategori|transaksi)(?:\/([0-9a-f-]{36}))?$/i);
  if (!match) throw new Error('Endpoint tidak ditemukan.');
  const [, resource, id] = match;
  let query;

  if (resource === 'transaksi') {
    if (method === 'GET' && !id) {
      const result = await client.from('transaksi')
        .select('*,detail_transaksi(id,kas_id,kategori_id,arah,nominal,catatan,kas(nama),kategori(nama))')
        .order('tanggal', { ascending: false }).order('created_at', { ascending: false });
      throwIfError(result.error);
      return result.data;
    }
    if ((method === 'POST' && !id) || (method === 'PATCH' && id)) {
      const { data: authData, error: authError } = await client.auth.getUser();
      throwIfError(authError);
      if (!authData.user) throw new Error('Sesi berakhir. Silakan masuk kembali.');
      if (body.jenis === 'transfer') {
        const result = await client.rpc('simpan_transfer_kas', {
          p_transaksi_id: id || null,
          p_tanggal: body.tanggal,
          p_catatan: body.catatan,
          p_kas_sumber_id: body.kas_id,
          p_kas_tujuan_id: body.kas_tujuan_id,
          p_nominal: Number(body.nominal)
        });
        throwIfError(result.error);
        return { id: result.data };
      }
      const transactionData = { tanggal: body.tanggal, jenis: body.jenis, catatan: body.catatan };
      let transaction;
      if (method === 'POST') {
        const result = await client.from('transaksi').insert(transactionData).select('id').single();
        throwIfError(result.error);
        transaction = result.data;
      } else {
        const result = await client.from('transaksi').update(transactionData).eq('id', id).select('id').maybeSingle();
        throwIfError(result.error);
        if (!result.data) throw new Error('Transaksi tidak ditemukan.');
        transaction = result.data;
      }

      const detailData = { kas_id: body.kas_id, kategori_id: body.kategori_id, nominal: Number(body.nominal), catatan: String(body.detail_catatan || '').trim() };
      if (method === 'POST') {
        const result = await client.from('detail_transaksi').insert({ ...detailData, transaksi_id: transaction.id });
        if (result.error) {
          await client.from('transaksi').delete().eq('id', transaction.id);
          throwIfError(result.error);
        }
      } else {
        const details = await client.from('detail_transaksi').select('id').eq('transaksi_id', id).order('created_at', { ascending: true });
        throwIfError(details.error);
        const result = details.data?.[0]
          ? await client.from('detail_transaksi').update(detailData).eq('id', details.data[0].id)
          : await client.from('detail_transaksi').insert({ ...detailData, transaksi_id: id });
        throwIfError(result.error);
        const extraDetailIds = (details.data || []).slice(1).map((detail) => detail.id);
        if (extraDetailIds.length) {
          const cleanup = await client.from('detail_transaksi').delete().in('id', extraDetailIds);
          throwIfError(cleanup.error);
        }
      }
      return { id: transaction.id };
    }
  }

  const table = resource;
  if (method === 'GET' && !id) {
    query = client.from(table).select('*').order('created_at', { ascending: false });
  } else if (method === 'POST' && !id) {
    query = client.from(table).insert(body).select().single();
  } else if (method === 'PATCH' && id) {
    query = client.from(table).update(body).eq('id', id).select().single();
  } else if (method === 'DELETE' && id) {
    query = client.from(table).delete().eq('id', id);
  } else if (resource === 'transaksi' && method === 'DELETE' && id) {
    query = client.from(table).delete().eq('id', id);
  } else {
    throw new Error('Metode permintaan tidak diizinkan.');
  }
  const result = await query;
  throwIfError(result.error);
  return result.data;
}

async function request(path, options = {}) {
  if (directSupabaseMode) return requestDirect(path, options);
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error(`Tidak dapat terhubung ke server aplikasi di ${window.location.origin}. Jalankan node backend/apps.js dan buka aplikasi melalui alamat server.`);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || 'Permintaan tidak dapat diproses.');
  }
  return result;
}

function setLoginEnabled(enabled) {
  $$('#login-form input, #login-form button[type="submit"]').forEach((control) => { control.disabled = !enabled; });
}

function showLogin(message = '', loginEnabled = true) {
  state.token = null;
  state.user = null;
  $('#app-shell').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-message').textContent = message;
  $('#login-form').classList.toggle('setup-notice', !loginEnabled);
  $('#login-form h2').textContent = loginEnabled ? 'Selamat datang' : 'Dashboard belum siap';
  $('.login-form > .muted').textContent = loginEnabled
    ? 'Masuk untuk membuka pembukuan cafe.'
    : 'Selesaikan pengaturan Supabase di bawah untuk membuka dashboard tanpa login.';
  $('#login-form').reset();
  setLoginEnabled(loginEnabled);
  refreshIcons();
}

function showApp(user) {
  state.user = user;
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  const email = user.email || 'Annisa Beno';
  $('#user-name').textContent = email.split('@')[0];
  $('#user-avatar').textContent = email[0].toUpperCase();
  $('#logout-button').hidden = Boolean(user.is_anonymous);
  refreshIcons();
}

async function loadData() {
  $('#sync-label').textContent = 'Menyinkronkan...';
  const [kas, kategori, transaksi] = await Promise.all([
    request('/api/kas'), request('/api/kategori'), request('/api/transaksi')
  ]);
  state.kas = kas;
  state.kategori = kategori;
  state.transaksi = transaksi;
  if (!state.reportRangeTouched && state.transaksi.length) {
    const earliestDate = state.transaksi.map((transaction) => transaction.tanggal).sort()[0];
    if (earliestDate && earliestDate < state.reportFrom) {
      state.reportFrom = earliestDate;
      $('#report-start').value = earliestDate;
    }
  }
  $('#sync-label').textContent = 'Tersinkron';
  $('#sync-label').closest('.sync-status').classList.add('is-connected');
  renderAll();
}

function getDetail(transaction) {
  return transaction.detail_transaksi?.[0] || null;
}

function getDetails(transaction) {
  return transaction.detail_transaksi || [];
}

function findTransaction(id) {
  return state.transaksi.find((transaction) => String(transaction.id) === String(id));
}

function getTransferSides(transaction) {
  const details = getDetails(transaction);
  return {
    source: details.find((detail) => detail.arah === 'keluar'),
    destination: details.find((detail) => detail.arah === 'masuk')
  };
}

function getKasDescendantIds(accountId) {
  const descendantIds = new Set([accountId]);
  const pendingIds = [accountId];
  while (pendingIds.length) {
    const parentId = pendingIds.pop();
    state.kas.forEach((account) => {
      if (account.induk_kas_id === parentId && !descendantIds.has(account.id)) {
        descendantIds.add(account.id);
        pendingIds.push(account.id);
      }
    });
  }
  return descendantIds;
}

function orderedKas() {
  return [...state.kas].sort((first, second) => {
    const depthOrder = Number(Boolean(first.induk_kas_id)) - Number(Boolean(second.induk_kas_id));
    return depthOrder || first.nama.localeCompare(second.nama, 'id');
  });
}

function getCashBalance(accountId) {
  const includedAccounts = getKasDescendantIds(accountId);
  return state.transaksi.reduce((total, transaction) => {
    if (transaction.jenis === 'transfer') {
      return total + getDetails(transaction).reduce((balance, detail) => {
        if (!includedAccounts.has(detail.kas_id)) return balance;
        return balance + Number(detail.nominal) * (detail.arah === 'masuk' ? 1 : -1);
      }, 0);
    }
    const detail = getDetail(transaction);
    if (!detail || !includedAccounts.has(detail.kas_id)) return total;
    return total + Number(detail.nominal) * (transaction.jenis === 'masuk' ? 1 : -1);
  }, 0);
}

function getTotalCashBalance() {
  return state.kas.filter((account) => !account.induk_kas_id)
    .reduce((total, account) => total + getCashBalance(account.id), 0);
}

function getMainCashAccount() {
  return state.kas.find((account) => account.nama === 'Kas Utama')
    || state.kas.find((account) => !account.induk_kas_id)
    || null;
}

function getMainCashTransactions() {
  return state.transaksi;
}

function filteredTransactions() {
  return getMainCashTransactions().filter((transaction) => {
    const detail = getDetail(transaction);
    const kindMatches = state.filter === 'all' || transaction.jenis === state.filter;
    const monthMatches = !state.month || transaction.tanggal.startsWith(state.month);
    const linkedNames = getDetails(transaction).map((row) => `${row.catatan || ''} ${row.kategori?.nama || ''} ${row.kas?.nama || ''}`).join(' ');
    const haystack = `${transaction.catatan} ${detail?.catatan || ''} ${linkedNames}`.toLocaleLowerCase('id-ID');
    return kindMatches && monthMatches && haystack.includes(state.query.toLocaleLowerCase('id-ID'));
  });
}

function renderOverview() {
  const todayItems = state.transaksi.filter((transaction) => transaction.tanggal === todayIso);
  const currentMonthItems = state.transaksi.filter((transaction) => transaction.tanggal.startsWith(monthIso));
  const totalBalance = getTotalCashBalance();
  const sumKind = (items, kind) => items.reduce((sum, transaction) => sum + (transaction.jenis === kind ? Number(getDetail(transaction)?.nominal || 0) : 0), 0);
  $('#total-balance').textContent = money(totalBalance);
  $('#today-income').textContent = money(sumKind(todayItems, 'masuk'));
  $('#today-expense').textContent = money(sumKind(todayItems, 'keluar'));
  $('#month-count').textContent = currentMonthItems.length.toLocaleString('id-ID');
  $('#month-caption').textContent = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(today);
  $('#income-caption').textContent = `${todayItems.filter((transaction) => transaction.jenis === 'masuk').length} transaksi hari ini`;
  $('#expense-caption').textContent = `${todayItems.filter((transaction) => transaction.jenis === 'keluar').length} transaksi hari ini`;
  $('#overview-accounts').innerHTML = state.kas.length ? orderedKas().slice(0, 4).map((account, index) => `
    <div class="account-row"><span class="account-symbol account-color-${index % 4}">${icon(['coffee', 'landmark', 'store', 'piggy-bank'][index % 4])}</span><span class="account-row-copy"><strong>${escapeHtml(account.nama)}</strong><small>${escapeHtml(account.deskripsi || 'Akun kas cafe')}</small></span><strong class="account-row-balance">${money(getCashBalance(account.id))}</strong></div>`).join('') : emptyInline('wallet-cards', 'Belum ada akun kas', 'Tambahkan akun untuk mulai mencatat.');
  $('#recent-transactions').innerHTML = state.transaksi.length ? state.transaksi.slice(0, 5).map(activityMarkup).join('') : emptyInline('notebook-tabs', 'Belum ada transaksi', 'Catatan terbaru akan muncul di sini.');
  const categoryTotals = new Map();
  currentMonthItems.forEach((transaction) => {
    const detail = getDetail(transaction);
    if (!detail?.kategori) return;
    const key = detail.kategori.nama;
    categoryTotals.set(key, (categoryTotals.get(key) || 0) + Number(detail.nominal));
  });
  const topCategories = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const categoryMax = Math.max(1, ...topCategories.map(([, total]) => total));
  $('#category-summary').innerHTML = topCategories.length ? topCategories.map(([name, total], index) => `<div class="category-bar-row"><span class="category-bar-label">${escapeHtml(name)}</span><span class="category-track"><span class="category-fill fill-${index % 5}" style="width:${Math.max(5, total / categoryMax * 100)}%"></span></span><strong>${money(total)}</strong></div>`).join('') : emptyInline('chart-no-axes-column-increasing', 'Belum ada pergerakan bulan ini', 'Kategori akan terlihat setelah ada transaksi.');
  $('#category-period').textContent = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' }).format(today);
}

function emptyInline(iconName, title, description) {
  return `<div class="inline-empty">${icon(iconName)}<strong>${title}</strong><span>${description}</span></div>`;
}

function activityMarkup(transaction) {
  const detail = getDetail(transaction);
  if (transaction.jenis === 'transfer') {
    const { source, destination } = getTransferSides(transaction);
    return `<div class="activity-row"><span class="activity-icon transfer">${icon('arrow-left-right')}</span><span class="activity-copy"><strong>${escapeHtml(transaction.catatan)}</strong><small>${displayDate(transaction.tanggal)} · ${escapeHtml(source?.kas?.nama || 'Kas')} → ${escapeHtml(destination?.kas?.nama || 'Kas')}</small></span><strong class="activity-amount">${money(source?.nominal)}</strong></div>`;
  }
  const incoming = transaction.jenis === 'masuk';
  return `<div class="activity-row"><span class="activity-icon ${incoming ? 'income' : 'expense'}">${icon(incoming ? 'arrow-down-left' : 'arrow-up-right')}</span><span class="activity-copy"><strong>${escapeHtml(transaction.catatan)}</strong><small>${displayDate(transaction.tanggal)} · ${escapeHtml(detail?.kategori?.nama || 'Tanpa kategori')}</small></span><strong class="activity-amount ${incoming ? 'positive' : 'negative'}">${incoming ? '+' : '-'}${money(detail?.nominal)}</strong></div>`;
}

function renderTransactions() {
  const transactions = filteredTransactions();
  const mainTransactions = getMainCashTransactions();
  $('#transaction-count').textContent = mainTransactions.length.toLocaleString('id-ID');
  $('#filter-count-all').textContent = mainTransactions.length.toLocaleString('id-ID');
  $('#transaction-table').innerHTML = transactions.map((transaction) => {
    const detail = getDetail(transaction);
    const transfer = transaction.jenis === 'transfer';
    const sides = transfer ? getTransferSides(transaction) : null;
    const incoming = transaction.jenis === 'masuk';
    const cashName = transfer ? `${sides.source?.kas?.nama || 'Kas'} → ${sides.destination?.kas?.nama || 'Kas'}` : detail?.kas?.nama || 'Dihapus';
    const amount = transfer ? sides.source?.nominal : detail?.nominal;
    const kindLabel = transfer ? 'Transfer' : incoming ? 'Masuk' : 'Keluar';
    const amountLabel = transfer ? money(amount) : `${incoming ? '+' : '-'}${money(amount)}`;
    return `<tr><td class="date-cell">${displayDate(transaction.tanggal)}</td><td><strong class="table-description">${escapeHtml(transaction.catatan)}</strong>${!transfer && detail?.catatan ? `<small class="table-subcopy">${escapeHtml(detail.catatan)}</small>` : ''}</td><td><span class="category-chip">${escapeHtml(transfer ? 'Mutasi internal' : detail?.kategori?.nama || 'Dihapus')}</span></td><td><span class="cash-name">${escapeHtml(cashName)}</span></td><td><span class="type-badge ${transfer ? 'transfer' : incoming ? 'in' : 'out'}"><span></span>${kindLabel}</span></td><td class="align-right amount-cell ${transfer ? '' : incoming ? 'positive' : 'negative'}">${amountLabel}</td><td><div class="row-actions"><button class="icon-button row-action" data-edit-transaction="${transaction.id}" title="Ubah transaksi" aria-label="Ubah transaksi">${icon('pencil')}</button><button class="icon-button row-action danger-action" data-delete-transaction="${transaction.id}" title="Hapus transaksi" aria-label="Hapus transaksi">${icon('trash-2')}</button></div></td></tr>`;
  }).join('');
  $('#transaction-empty').hidden = transactions.length > 0;
  $('#ledger-result-count').textContent = `Menampilkan ${transactions.length} dari ${mainTransactions.length} transaksi`;
  $('#transaction-table').closest('.table-wrap').classList.toggle('has-empty', !transactions.length);
  refreshIcons();
}

function renderAccounts() {
  const total = getTotalCashBalance();
  $('#account-total-count').textContent = state.kas.length.toLocaleString('id-ID');
  $('#accounts-total-balance').textContent = money(total);
  $('#account-cards').innerHTML = state.kas.length ? orderedKas().map((account, index) => {
    const accountIds = getKasDescendantIds(account.id);
    const accountTransactions = state.transaksi.filter((transaction) => getDetails(transaction).some((detail) => accountIds.has(detail.kas_id)));
    const cashBalance = getCashBalance(account.id);
    const parent = state.kas.find((candidate) => candidate.id === account.induk_kas_id);
    const description = parent ? `Bagian dari ${parent.nama}` : account.deskripsi || 'Kas cafe';
    return `<article class="account-card account-card-${index % 4}"><div class="account-card-top"><span class="account-card-icon">${icon(['coffee', 'landmark', 'store', 'piggy-bank'][index % 4])}</span><div class="row-actions"><button class="icon-button row-action" data-edit-account="${account.id}" title="Ubah akun" aria-label="Ubah akun">${icon('pencil')}</button><button class="icon-button row-action danger-action" data-delete-account="${account.id}" title="Hapus akun" aria-label="Hapus akun">${icon('trash-2')}</button></div></div><p class="eyebrow">AKUN KAS ${String(index + 1).padStart(2, '0')}</p><h2>${escapeHtml(account.nama)}</h2><p class="account-description">${escapeHtml(description)}</p><strong class="account-card-balance">${money(cashBalance)}</strong><div class="account-card-footer"><span>${accountTransactions.length} transaksi tercatat</span><span class="balance-indicator ${cashBalance >= 0 ? 'positive' : 'negative'}">${cashBalance >= 0 ? 'Saldo positif' : 'Saldo minus'}</span></div><button class="text-button account-open-button" type="button" data-open-account="${account.id}">Lihat transaksi ${icon('arrow-right')}</button></article>`;
  }).join('') : `<div class="empty-block">${emptyInline('wallet-cards', 'Belum ada akun kas', 'Tambahkan Kasir, Kas Utama, Kas Operasional, atau Kas Cadangan.')}</div>`;
  refreshIcons();
}

function renderAccountDetail() {
  const account = state.kas.find((candidate) => candidate.id === state.selectedAccountId);
  if (!account) return;
  const accountIds = getKasDescendantIds(account.id);
  const transactions = state.transaksi.filter((transaction) => getDetails(transaction).some((detail) => accountIds.has(detail.kas_id)));
  const totals = { masuk: 0, keluar: 0 };
  const rows = transactions.map((transaction) => {
    const transfer = transaction.jenis === 'transfer';
    const detail = transfer
      ? null
      : getDetails(transaction).find((row) => accountIds.has(row.kas_id));
    let direction = transaction.jenis;
    let amount = Number(detail?.nominal || 0);
    let accountName = detail?.kas?.nama || account.nama;
    let itemName = detail?.catatan || '';
    let categoryName = detail?.kategori?.nama || 'Tanpa kategori';

    if (transfer) {
      const { source, destination } = getTransferSides(transaction);
      const sourceIncluded = source && accountIds.has(source.kas_id);
      const destinationIncluded = destination && accountIds.has(destination.kas_id);
      const transferNet = (destinationIncluded ? Number(destination.nominal) : 0) - (sourceIncluded ? Number(source.nominal) : 0);
      direction = transferNet > 0 ? 'transfer-masuk' : transferNet < 0 ? 'transfer-keluar' : 'transfer-internal';
      amount = Math.abs(transferNet);
      accountName = `${source?.kas?.nama || 'Kas'} → ${destination?.kas?.nama || 'Kas'}`;
      itemName = direction === 'transfer-internal' ? 'Mutasi internal dalam akun konsolidasi' : 'Transfer antar kas';
      categoryName = 'Mutasi internal';
      if (sourceIncluded) totals.keluar += Number(source.nominal);
      if (destinationIncluded) totals.masuk += Number(destination.nominal);
    } else {
      totals[transaction.jenis] += amount;
    }

    const incoming = direction === 'masuk' || direction === 'transfer-masuk';
    const outgoing = direction === 'keluar' || direction === 'transfer-keluar';
    const directionLabel = ({ masuk: 'Masuk', keluar: 'Keluar', 'transfer-masuk': 'Transfer masuk', 'transfer-keluar': 'Transfer keluar', 'transfer-internal': 'Mutasi internal' })[direction];
    const badgeClass = incoming ? 'in' : outgoing ? 'out' : 'transfer';
    const amountLabel = direction === 'transfer-internal' ? '—' : `${outgoing ? '-' : '+'}${money(amount)}`;
    return `<tr><td class="date-cell">${displayDate(transaction.tanggal)}</td><td><strong class="table-description">${escapeHtml(transaction.catatan)}</strong></td><td>${escapeHtml(itemName || categoryName)}</td><td>${escapeHtml(accountName)}</td><td><span class="type-badge ${badgeClass}"><span></span>${directionLabel}</span></td><td class="align-right amount-cell ${incoming ? 'positive' : outgoing ? 'negative' : ''}">${amountLabel}</td><td><div class="row-actions"><button class="icon-button row-action" data-edit-transaction="${transaction.id}" title="Ubah transaksi" aria-label="Ubah transaksi">${icon('pencil')}</button><button class="icon-button row-action danger-action" data-delete-transaction="${transaction.id}" title="Hapus transaksi" aria-label="Hapus transaksi">${icon('trash-2')}</button></div></td></tr>`;
  });

  $('#account-detail-title').innerHTML = `${escapeHtml(account.nama)} <em>mutasi</em>`;
  $('#account-detail-description').textContent = account.induk_kas_id
    ? `Bagian dari ${state.kas.find((candidate) => candidate.id === account.induk_kas_id)?.nama || 'akun utama'}. Riwayat akun ini saja.`
    : 'Konsolidasi akun ini beserta seluruh kas rinciannya.';
  $('#account-detail-balance').textContent = money(getCashBalance(account.id));
  $('#account-detail-in').textContent = money(totals.masuk);
  $('#account-detail-out').textContent = money(totals.keluar);
  $('#account-detail-count').textContent = transactions.length.toLocaleString('id-ID');
  $('#account-detail-rows').innerHTML = rows.length ? rows.join('') : '<tr><td class="report-empty-cell" colspan="7">Belum ada transaksi pada akun ini.</td></tr>';
  $('#account-detail-empty').hidden = rows.length > 0;
  refreshIcons();
}

function renderCategories() {
  const totalsByCategory = new Map(state.kategori.map((category) => [category.id, { amount: 0, count: 0 }]));
  state.transaksi.forEach((transaction) => {
    if (transaction.jenis === 'transfer') return;
    const detail = getDetail(transaction);
    if (!detail?.kategori_id) return;
    if (!totalsByCategory.has(detail.kategori_id)) totalsByCategory.set(detail.kategori_id, { amount: 0, count: 0 });
    const total = totalsByCategory.get(detail.kategori_id);
    total.amount += Number(detail.nominal || 0);
    total.count += 1;
  });
  const categoryMarkup = (category, index) => {
    const total = totalsByCategory.get(category.id) || { amount: 0, count: 0 };
    return `<div class="category-manager-row"><span class="category-manager-name"><span class="category-dot category-dot-${index % 6}"></span><strong>${escapeHtml(category.nama)}</strong></span><span><span class="type-badge ${category.jenis === 'masuk' ? 'in' : 'out'}"><span></span>${category.jenis === 'masuk' ? 'Pemasukan' : 'Pengeluaran'}</span></span><span class="category-usage"><strong>${money(total.amount)}</strong><small>${total.count.toLocaleString('id-ID')} transaksi</small></span><span class="row-actions"><button class="icon-button row-action" data-edit-category="${category.id}" title="Ubah kategori" aria-label="Ubah kategori">${icon('pencil')}</button><button class="icon-button row-action danger-action" data-delete-category="${category.id}" title="Hapus kategori" aria-label="Hapus kategori">${icon('trash-2')}</button></span></div>`;
  };
  const incomeCategories = state.kategori.filter((category) => category.jenis === 'masuk');
  const expenseCategories = state.kategori.filter((category) => category.jenis === 'keluar');
  $('#category-cards').innerHTML = state.kategori.length
    ? `<div class="category-column"><h2>Pemasukan</h2>${incomeCategories.map((category) => categoryMarkup(category, state.kategori.indexOf(category))).join('')}</div><div class="category-column"><h2>Pengeluaran</h2>${expenseCategories.map((category) => categoryMarkup(category, state.kategori.indexOf(category))).join('')}</div>`
    : `<div class="empty-block">${emptyInline('tags', 'Belum ada kategori', 'Buat kategori pemasukan dan pengeluaran.')}</div>`;
  refreshIcons();
}

function reportTransactions() {
  const periodTransactions = state.transaksi.filter((transaction) => transaction.tanggal >= state.reportFrom && transaction.tanggal <= state.reportTo);
  if (state.reportScope === 'overall' || state.reportAccountId === 'all') return periodTransactions;
  if (!state.reportAccountId) return [];
  return periodTransactions.filter((transaction) => getDetails(transaction).some((detail) => detail.kas_id === state.reportAccountId));
}

function renderReports() {
  const reportAccountSelect = $('#report-account-select');
  const selectedReportAccount = state.reportAccountId;
  reportAccountSelect.innerHTML = `<option value="all">Semua Kas</option>${orderedKas().map((account) => `<option value="${account.id}">${escapeHtml(account.nama)}</option>`).join('')}`;
  if (selectedReportAccount === 'all' || state.kas.some((account) => account.id === selectedReportAccount)) reportAccountSelect.value = selectedReportAccount;
  else {
    state.reportAccountId = 'all';
    reportAccountSelect.value = 'all';
  }
  const isAccountReport = state.reportScope === 'account';
  const specificAccount = isAccountReport && state.reportAccountId !== 'all';
  const reportAccount = specificAccount ? state.kas.find((account) => account.id === state.reportAccountId) : null;
  const includedAccounts = reportAccount ? new Set([reportAccount.id]) : null;
  $('#report-account-field').hidden = !isAccountReport;
  $$('[data-report-scope]').forEach((button) => button.classList.toggle('selected', button.dataset.reportScope === state.reportScope));
  const transactions = reportTransactions();
  const totals = { masuk: 0, keluar: 0 };
  const categoryTotals = new Map(state.kategori.map((category) => [category.id, { nama: category.nama, masuk: 0, keluar: 0 }]));
  const accountTotals = new Map(state.kas.map((account) => [account.id, { nama: account.nama, masuk: 0, keluar: 0 }]));
  const addAccountMovement = (detail, kind, amount) => {
    if (!detail?.kas_id || !['masuk', 'keluar'].includes(kind)) return;
    if (specificAccount) {
      if (detail.kas_id !== reportAccount.id) return;
      accountTotals.get(reportAccount.id)[kind] += amount;
      return;
    }
    let account = state.kas.find((candidate) => candidate.id === detail.kas_id);
    if (!account) {
      if (!accountTotals.has(detail.kas_id)) accountTotals.set(detail.kas_id, { nama: detail.kas?.nama || 'Akun kas dihapus', masuk: 0, keluar: 0 });
      accountTotals.get(detail.kas_id)[kind] += amount;
      return;
    }
    while (account) {
      if (!accountTotals.has(account.id)) accountTotals.set(account.id, { nama: account.nama, masuk: 0, keluar: 0 });
      accountTotals.get(account.id)[kind] += amount;
      account = state.kas.find((candidate) => candidate.id === account.induk_kas_id);
    }
  };

  transactions.forEach((transaction) => {
    if (transaction.jenis === 'transfer') {
      getDetails(transaction).forEach((detail) => {
        const amount = Number(detail.nominal || 0);
        addAccountMovement(detail, detail.arah, amount);
        if (specificAccount && includedAccounts.has(detail.kas_id)) totals[detail.arah] += amount;
      });
      return;
    }
    const detail = getDetail(transaction);
    if (specificAccount && !includedAccounts.has(detail?.kas_id)) return;
    const amount = Number(detail?.nominal || 0);
    const kind = transaction.jenis;
    totals[kind] += amount;

    if (detail?.kategori_id) {
      if (!categoryTotals.has(detail.kategori_id)) categoryTotals.set(detail.kategori_id, { nama: detail.kategori?.nama || 'Kategori dihapus', masuk: 0, keluar: 0 });
      categoryTotals.get(detail.kategori_id)[kind] += amount;
    }
    addAccountMovement(detail, kind, amount);
  });

  const net = totals.masuk - totals.keluar;
  $('#report-income').textContent = money(totals.masuk);
  $('#report-expense').textContent = money(totals.keluar);
  $('#report-net').textContent = money(net);
  $('#report-net').classList.toggle('negative', net < 0);
  $('#report-count').textContent = transactions.length.toLocaleString('id-ID');
  $('#report-period-count').textContent = `${transactions.length.toLocaleString('id-ID')} transaksi`;
  $('#report-period-label').textContent = state.reportFrom && state.reportTo
    ? `${displayDate(state.reportFrom)} - ${displayDate(state.reportTo)}${isAccountReport ? ` · ${reportAccount?.nama || 'Semua Kas'}` : ''}`
    : 'Pilih periode';
  $('#report-income-label').textContent = specificAccount ? 'Arus masuk akun' : 'Total kas masuk';
  $('#report-expense-label').textContent = specificAccount ? 'Arus keluar akun' : 'Total kas keluar';
  $('#report-net-label').textContent = specificAccount ? 'Perubahan saldo' : 'Arus bersih';
  $('#report-net-caption').textContent = specificAccount ? 'Termasuk transfer akun ini' : 'Total masuk dikurangi keluar';

  const breakdownRows = (groups) => [...groups.values()]
    .sort((a, b) => (b.masuk + b.keluar) - (a.masuk + a.keluar) || a.nama.localeCompare(b.nama, 'id'));
  const renderBreakdown = (groups, emptyMessage) => {
    const rows = breakdownRows(groups).filter((row) => row.masuk || row.keluar);
    return rows.length ? rows.map((row) => {
      const rowNet = row.masuk - row.keluar;
      return `<tr><td>${escapeHtml(row.nama)}</td><td class="align-right positive">${money(row.masuk)}</td><td class="align-right negative">${money(row.keluar)}</td><td class="align-right ${rowNet < 0 ? 'negative' : 'positive'}">${money(rowNet)}</td></tr>`;
    }).join('') : `<tr><td class="report-empty-cell" colspan="4">${emptyMessage}</td></tr>`;
  };

  $('#report-category-rows').innerHTML = renderBreakdown(categoryTotals, 'Belum ada transaksi per kategori.');
  const visibleAccountTotals = specificAccount && includedAccounts
    ? new Map([...accountTotals].filter(([id]) => includedAccounts.has(id)))
    : accountTotals;
  $('#report-account-rows').innerHTML = renderBreakdown(visibleAccountTotals, 'Belum ada transaksi per akun kas.');
  $('#report-transaction-rows').innerHTML = transactions.length ? transactions.map((transaction) => {
    const detail = getDetail(transaction);
    const transfer = transaction.jenis === 'transfer';
    const sides = transfer ? getTransferSides(transaction) : null;
    const incoming = transaction.jenis === 'masuk';
    const amount = transfer ? sides.source?.nominal : detail?.nominal;
    const cashNames = transfer ? `${sides.source?.kas?.nama || 'Kas'} → ${sides.destination?.kas?.nama || 'Kas'}` : detail?.kas?.nama || 'Tanpa akun';
    const kindLabel = transfer ? 'Transfer' : incoming ? 'Masuk' : 'Keluar';
    return `<tr><td>${displayDate(transaction.tanggal)}</td><td><strong class="table-description">${escapeHtml(transaction.catatan)}</strong>${!transfer && detail?.catatan ? `<small class="table-subcopy">${escapeHtml(detail.catatan)}</small>` : ''}</td><td>${escapeHtml(transfer ? 'Mutasi internal' : detail?.kategori?.nama || 'Tanpa kategori')}</td><td>${escapeHtml(cashNames)}</td><td><span class="type-badge ${transfer ? 'transfer' : incoming ? 'in' : 'out'}"><span></span>${kindLabel}</span></td><td class="align-right ${transfer ? '' : incoming ? 'positive' : 'negative'}">${money(amount)}</td></tr>`;
  }).join('') : '<tr><td class="report-empty-cell" colspan="6">Tidak ada transaksi pada periode ini.</td></tr>';
  refreshIcons();
}

function exportReportCsv() {
  const transactions = reportTransactions();
  const fields = ['Tanggal', 'Jenis', 'Catatan', 'Kategori', 'Kas sumber', 'Kas tujuan', 'Nominal', 'Catatan tambahan'];
  const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = transactions.map((transaction) => {
    const detail = getDetail(transaction);
    if (transaction.jenis === 'transfer') {
      const { source, destination } = getTransferSides(transaction);
      return [transaction.tanggal, 'transfer', transaction.catatan, 'Mutasi internal', source?.kas?.nama, destination?.kas?.nama, Number(source?.nominal || 0).toFixed(2), ''].map(csvCell).join(',');
    }
    return [transaction.tanggal, transaction.jenis, transaction.catatan, detail?.kategori?.nama, detail?.kas?.nama, '', Number(detail?.nominal || 0).toFixed(2), detail?.catatan].map(csvCell).join(',');
  });
  const content = `\uFEFF${[fields.map(csvCell).join(','), ...rows].join('\r\n')}`;
  const objectUrl = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `laporan-arus-kas-${state.reportFrom}-${state.reportTo}.csv`;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function renderAll() {
  renderOverview();
  renderTransactions();
  renderReports();
  renderAccounts();
  renderCategories();
  renderAccountDetail();
  refreshIcons();
}

function setView(name) {
  $$('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `view-${name}`));
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === name));
  $('#breadcrumb-current').textContent = name === 'account-detail'
    ? state.kas.find((account) => account.id === state.selectedAccountId)?.nama || 'Akun kas'
    : ({ overview: 'Ringkasan', transactions: 'Arus kas', reports: 'Laporan', accounts: 'Akun kas', categories: 'Kategori' })[name];
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openAccountDetail(accountId) {
  state.selectedAccountId = accountId;
  renderAccountDetail();
  setView('account-detail');
}

function inputField({ name, label, type = 'text', value = '', required = true, placeholder = '', options = null, min = null, max = null, step = null }) {
  const requiredAttribute = required ? 'required' : '';
  if (options) return `<label class="field-label" for="field-${name}">${label}<select id="field-${name}" name="${name}" ${requiredAttribute}>${options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></label>`;
  return `<label class="field-label" for="field-${name}">${label}<input id="field-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${requiredAttribute}${min !== null ? ` min="${min}"` : ''}${max !== null ? ` max="${max}"` : ''}${step !== null ? ` step="${step}"` : ''}></label>`;
}

function openModal(kind, item = null, presetAccountId = null) {
  state.modal = { kind, item };
  const titles = { transaction: item ? 'Ubah transaksi' : 'Catat transaksi', account: item ? 'Ubah akun kas' : 'Tambah akun kas', category: item ? 'Ubah kategori' : 'Tambah kategori' };
  const eyebrow = { transaction: 'BUKU ARUS KAS', account: 'PENGELOLAAN KAS', category: 'KATEGORI HARIAN' };
  $('#modal-title').textContent = titles[kind];
  $('#modal-eyebrow').textContent = eyebrow[kind];
    $('#modal-description').textContent = kind === 'transaction' ? 'Pilih arah, sumber kas, dan kategori pencatatan.' : kind === 'account' ? 'Nama akun yang digunakan untuk menyimpan arus kas cafe.' : 'Gunakan kategori untuk mengelompokkan pergerakan kas.';
  $('#modal-error').textContent = '';
  const transferSides = item?.jenis === 'transfer' ? getTransferSides(item) : null;
  const details = item ? getDetail(item) : null;
  let fields = '';
  if (kind === 'transaction') {
    const allAccountOptions = orderedKas().map((account) => {
      return { value: account.id, label: account.nama };
    });
    const selectedKind = item?.jenis || 'masuk';
    const leafAccountOptions = allAccountOptions.filter((option) => !state.kas.some((account) => account.id === option.value && state.kas.some((child) => child.induk_kas_id === account.id)));
    const accountOptions = selectedKind === 'keluar' ? leafAccountOptions : allAccountOptions;
    const categories = state.kategori.filter((category) => category.jenis === (item?.jenis || 'masuk'));
    const categoryOptions = categories.map((category) => ({ value: category.id, label: category.nama }));
    const sourceId = transferSides?.source?.kas_id || details?.kas_id || (accountOptions.some((option) => option.value === presetAccountId) ? presetAccountId : '') || accountOptions[0]?.value || '';
    const destinationId = transferSides?.destination?.kas_id || allAccountOptions.find((option) => option.value !== sourceId)?.value || '';
    fields = `<div class="field-grid">${inputField({ name: 'tanggal', label: 'Tanggal', type: 'date', value: item?.tanggal || todayIso })}${inputField({ name: 'jenis', label: 'Jenis arus kas', value: selectedKind, options: [{ value: 'masuk', label: 'Kas masuk' }, { value: 'keluar', label: 'Kas keluar' }, { value: 'transfer', label: 'Transfer antar kas' }] })}</div>${inputField({ name: 'catatan', label: 'Catatan transaksi', value: item?.catatan || '', placeholder: selectedKind === 'transfer' ? 'Contoh: Pengisian kas operasional' : 'Contoh: Penjualan minuman' })}<div class="field-grid">${inputField({ name: 'kas_id', label: 'Akun kas', value: sourceId, options: accountOptions.length ? accountOptions : [{ value: '', label: 'Tambahkan akun kas terlebih dahulu' }] })}<div id="transfer-category-field">${inputField({ name: 'kategori_id', label: 'Kategori', value: details?.kategori_id || categoryOptions[0]?.value || '', options: categoryOptions.length ? categoryOptions : [{ value: '', label: 'Tambahkan kategori yang sesuai' }] })}</div><div id="transfer-destination-field" hidden>${inputField({ name: 'kas_tujuan_id', label: 'Kas tujuan', value: destinationId, options: allAccountOptions.length ? allAccountOptions : [{ value: '', label: 'Tambahkan akun kas terlebih dahulu' }] })}</div></div><div class="field-grid">${inputField({ name: 'nominal', label: 'Nominal (Rp)', type: 'number', value: transferSides?.source?.nominal || details?.nominal || '', placeholder: '0', min: '1', step: '1' })}${inputField({ name: 'detail_catatan', label: 'Rincian item / catatan', value: transferSides ? '' : details?.catatan || '', required: false, placeholder: 'Contoh: Latte, Americano, atau modal awal' })}</div>`;
  } else if (kind === 'account') {
    const parentOptions = [
      { value: '', label: 'Akun utama (tanpa induk)' },
      ...state.kas.filter((account) => !account.induk_kas_id && account.id !== item?.id).map((account) => ({ value: account.id, label: account.nama }))
    ];
    fields = `<div class="field-grid">${inputField({ name: 'nama', label: 'Nama akun', value: item?.nama || '', placeholder: 'Contoh: Kas Operasional' })}${inputField({ name: 'induk_kas_id', label: 'Bagian dari akun', value: item?.induk_kas_id || '', required: false, options: parentOptions })}</div>${inputField({ name: 'deskripsi', label: 'Deskripsi', value: item?.deskripsi || '', required: false, placeholder: 'Kegunaan akun kas ini' })}`;
  } else {
    fields = `<div class="field-grid">${inputField({ name: 'nama', label: 'Nama kategori', value: item?.nama || '', placeholder: 'Contoh: Bahan baku' })}${inputField({ name: 'jenis', label: 'Jenis arus kas', value: item?.jenis || 'keluar', options: [{ value: 'masuk', label: 'Kas masuk' }, { value: 'keluar', label: 'Kas keluar' }] })}</div>`;
  }
  $('#modal-fields').innerHTML = fields;
  const submitText = kind === 'transaction' ? 'Simpan transaksi' : kind === 'account' ? 'Simpan akun' : 'Simpan kategori';
  $('#modal-submit').innerHTML = `${icon('check')} ${submitText}`;
  $('#modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  if (kind === 'transaction') {
    $('#field-jenis').addEventListener('change', updateCategoryOptions);
    $('#field-kategori_id').addEventListener('change', updateItemDescriptionField);
    $('#field-kas_id').addEventListener('change', updateCategoryOptions);
    $('#field-kas_tujuan_id').addEventListener('change', updateCategoryOptions);
    updateCategoryOptions();
  }
  $('#modal-fields input, #modal-fields select')?.focus();
  refreshIcons();
}

function updateCategoryOptions() {
  const isTransfer = $('#field-jenis').value === 'transfer';
  const sourceSelect = $('#field-kas_id');
  const destinationSelect = $('#field-kas_tujuan_id');
  const categorySelect = $('#field-kategori_id');
  const currentSource = sourceSelect.value;
  const currentDestination = destinationSelect.value;
  const accounts = orderedKas().map((account) => {
    const parent = state.kas.find((candidate) => candidate.id === account.induk_kas_id);
    return { value: account.id, label: account.nama, account };
  });
  const leafAccounts = accounts.filter(({ account }) => !state.kas.some((child) => child.induk_kas_id === account.id));
  const sourceOptions = isTransfer || $('#field-jenis').value === 'masuk' ? accounts : leafAccounts;
  const validSource = sourceOptions.some((option) => option.value === currentSource) ? currentSource : sourceOptions[0]?.value || '';
  sourceSelect.innerHTML = sourceOptions.length ? sourceOptions.map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join('') : '<option value="">Tambahkan akun kas terlebih dahulu</option>';
  sourceSelect.value = validSource;

  const destinationOptions = accounts.filter((option) => option.value !== sourceSelect.value);
  const validDestination = destinationOptions.some((option) => option.value === currentDestination) ? currentDestination : destinationOptions[0]?.value || '';
  destinationSelect.innerHTML = destinationOptions.length ? destinationOptions.map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join('') : '<option value="">Pilih kas sumber yang berbeda</option>';
  destinationSelect.value = validDestination;
  $('#transfer-category-field').hidden = isTransfer;
  categorySelect.disabled = isTransfer;
  $('#transfer-destination-field').hidden = !isTransfer;
  destinationSelect.disabled = !isTransfer;
  sourceSelect.closest('label').firstChild.textContent = isTransfer ? 'Kas sumber' : 'Akun kas';

  const categories = state.kategori.filter((category) => category.jenis === $('#field-jenis').value);
  const selectedCategory = categorySelect.value;
  categorySelect.innerHTML = categories.length ? categories.map((category) => `<option value="${category.id}">${escapeHtml(category.nama)}</option>`).join('') : '<option value="">Tambahkan kategori yang sesuai</option>';
  if (categories.some((category) => category.id === selectedCategory)) categorySelect.value = selectedCategory;
  updateItemDescriptionField();
  $('#modal-description').textContent = isTransfer
    ? 'Pindahkan saldo antar akun kas tanpa mengubah pemasukan atau pengeluaran cafe.'
    : 'Pilih arah, sumber kas, dan kategori pencatatan.';
}

function updateItemDescriptionField() {
  const category = state.kategori.find((item) => item.id === $('#field-kategori_id')?.value);
  const field = $('#field-detail_catatan');
  const label = field?.closest('label');
  if (!field || !label) return;
  const isSale = category?.jenis === 'masuk' && category.nama.toLocaleLowerCase('id-ID').includes('penjualan');
  label.firstChild.textContent = isSale ? 'Nama minuman / produk' : 'Rincian item / catatan';
  field.placeholder = isSale ? 'Contoh: Caffe, Latte, Americano' : 'Contoh: Latte, Americano, atau modal awal';
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  document.body.classList.remove('modal-open');
  state.modal = null;
}

async function saveModal(event) {
  event.preventDefault();
  if (!state.modal) return;
  const { kind, item } = state.modal;
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const button = $('#modal-submit');
  button.disabled = true;
  $('#modal-error').textContent = '';
  try {
    if (kind === 'transaction') {
        if (!state.kas.length) throw new Error('Tambahkan akun kas terlebih dahulu.');
      let payload;
      if (data.jenis === 'transfer') {
        if (!data.kas_tujuan_id || data.kas_id === data.kas_tujuan_id) throw new Error('Pilih kas sumber dan kas tujuan yang berbeda.');
        payload = { tanggal: data.tanggal, jenis: 'transfer', catatan: data.catatan, kas_id: data.kas_id, kas_tujuan_id: data.kas_tujuan_id, nominal: Number(data.nominal) };
      } else {
        if (!state.kategori.some((category) => category.jenis === data.jenis)) throw new Error('Tambahkan kategori yang sesuai sebelum mencatat transaksi.');
        payload = { tanggal: data.tanggal, jenis: data.jenis, catatan: data.catatan, kas_id: data.kas_id, kategori_id: data.kategori_id, nominal: Number(data.nominal), detail_catatan: data.detail_catatan };
      }
      await request(item ? `/api/transaksi/${item.id}` : '/api/transaksi', { method: item ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    } else {
      const path = kind === 'account' ? '/api/kas' : '/api/kategori';
      const payload = kind === 'account' ? { ...data, induk_kas_id: data.induk_kas_id || null } : data;
      await request(`${path}${item ? `/${item.id}` : ''}`, { method: item ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    }
    closeModal();
    await loadData();
    toast(kind === 'transaction' ? 'Transaksi tersimpan.' : kind === 'account' ? 'Akun kas tersimpan.' : 'Kategori tersimpan.');
  } catch (error) {
    $('#modal-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deleteItem(kind, id) {
  const names = { transaction: 'transaksi', account: 'akun kas', category: 'kategori' };
  if (kind === 'account' && state.kas.some((account) => account.induk_kas_id === id)) {
    toast('Akun utama masih memiliki akun rincian. Pindahkan atau hapus akun rinciannya terlebih dahulu.', true);
    return;
  }
  if (!window.confirm(`Hapus ${names[kind]} ini? Tindakan ini tidak dapat dibatalkan.`)) return;
  const path = kind === 'transaction' ? '/api/transaksi' : kind === 'account' ? '/api/kas' : '/api/kategori';
  try {
    await request(`${path}/${id}`, { method: 'DELETE' });
    await loadData();
    toast(`${names[kind][0].toUpperCase()}${names[kind].slice(1)} dihapus.`);
  } catch (error) {
    toast(error.message, true);
  }
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast${error ? ' toast-error' : ''}`;
  element.innerHTML = `${icon(error ? 'circle-alert' : 'circle-check')}<span>${escapeHtml(message)}</span>`;
  $('#toast-region').append(element);
  refreshIcons();
  window.setTimeout(() => element.remove(), 3600);
}

function setTodayLabel() {
  $('#today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today);
  $('.page-heading .eyebrow').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(today).toLocaleUpperCase('id-ID');
  $('#month-filter').value = '';
  state.reportFrom = `${monthIso}-01`;
  state.reportTo = todayIso;
  $('#report-start').value = state.reportFrom;
  $('#report-end').value = state.reportTo;
}

function initializeEvents() {
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#login-message');
    message.textContent = 'Memeriksa akun...';
    const formData = new FormData(event.currentTarget);
    try {
      const result = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: formData.get('email'), password: formData.get('password') }) });
      state.token = result.access_token;
      showApp(result.user);
      await loadData();
    } catch (error) { message.textContent = error.message; }
  });
  $('#logout-button').addEventListener('click', async () => {
    try { await request('/api/auth/logout', { method: 'POST' }); } catch { /* Clear the local in-memory session even if logout cannot reach Supabase. */ }
    showLogin();
  });
  $$('.nav-link').forEach((link) => link.addEventListener('click', () => setView(link.dataset.view)));
  $$('[data-navigate]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.navigate)));
  $$('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.action;
    const accountId = action === 'new-transaction' && $('#view-account-detail').classList.contains('active') ? state.selectedAccountId : null;
    openModal(action === 'new-transaction' ? 'transaction' : action === 'new-account' ? 'account' : 'category', null, accountId);
  }));
  $$('#modal-backdrop [data-close-modal]').forEach((button) => button.addEventListener('click', closeModal));
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target === $('#modal-backdrop')) closeModal(); });
  $('#modal-form').addEventListener('submit', saveModal);
  $('#modal-form').addEventListener('invalid', (event) => {
    const field = event.target;
    const label = field.closest('label')?.firstChild?.textContent?.trim() || 'Kolom ini';
    $('#modal-error').textContent = field.validity.valueMissing
      ? `${label} wajib diisi.`
      : field.validity.rangeUnderflow
        ? `${label} harus lebih besar dari 0.`
        : 'Periksa kembali isian transaksi.';
  }, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal(); });
  $('#transaction-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderTransactions(); });
  $('#month-filter').addEventListener('change', (event) => { state.month = event.target.value; renderTransactions(); });
  $$('[data-report-scope]').forEach((button) => button.addEventListener('click', () => {
    state.reportScope = button.dataset.reportScope;
    renderReports();
  }));
  $('#report-account-select').addEventListener('change', (event) => {
    state.reportAccountId = event.target.value;
    renderReports();
  });
  $('#report-filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const start = $('#report-start').value;
    const end = $('#report-end').value;
    if (!start || !end || start > end) {
      $('#report-error').textContent = 'Tanggal awal harus sama dengan atau sebelum tanggal akhir.';
      return;
    }
    $('#report-error').textContent = '';
    state.reportFrom = start;
    state.reportTo = end;
    state.reportRangeTouched = true;
    renderReports();
  });
  $('#report-export').addEventListener('click', exportReportCsv);
  $('#report-print').addEventListener('click', () => window.print());
  $$('.segmented-control button').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.segmented-control button').forEach((option) => option.classList.toggle('selected', option === button));
    renderTransactions();
  }));
  $('#transaction-table').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-transaction]');
    const deleteButton = event.target.closest('[data-delete-transaction]');
    if (editButton) {
      const transaction = findTransaction(editButton.dataset.editTransaction);
      if (transaction) openModal('transaction', transaction);
      else toast('Transaksi tidak ditemukan. Muat ulang data terlebih dahulu.', true);
    }
    if (deleteButton) deleteItem('transaction', deleteButton.dataset.deleteTransaction);
  });
  $('#account-cards').addEventListener('click', (event) => {
    const openButton = event.target.closest('[data-open-account]');
    const editButton = event.target.closest('[data-edit-account]');
    const deleteButton = event.target.closest('[data-delete-account]');
    if (openButton) openAccountDetail(openButton.dataset.openAccount);
    if (editButton) openModal('account', state.kas.find((account) => account.id === editButton.dataset.editAccount));
    if (deleteButton) deleteItem('account', deleteButton.dataset.deleteAccount);
  });
  $('#account-detail-rows').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-transaction]');
    const deleteButton = event.target.closest('[data-delete-transaction]');
    if (editButton) {
      const transaction = findTransaction(editButton.dataset.editTransaction);
      if (transaction) openModal('transaction', transaction);
      else toast('Transaksi tidak ditemukan. Muat ulang data terlebih dahulu.', true);
    }
    if (deleteButton) deleteItem('transaction', deleteButton.dataset.deleteTransaction);
  });
  $('#category-cards').addEventListener('click', (event) => {
    const editButton = event.target.closest('[data-edit-category]');
    const deleteButton = event.target.closest('[data-delete-category]');
    if (editButton) openModal('category', state.kategori.find((category) => category.id === editButton.dataset.editCategory));
    if (deleteButton) deleteItem('category', deleteButton.dataset.deleteCategory);
  });
  $('#refresh-button').addEventListener('click', async () => {
    const iconElement = $('#refresh-button i');
    iconElement?.classList.add('spinning');
    try { await loadData(); toast('Data berhasil diperbarui.'); } catch (error) { toast(error.message, true); }
    iconElement?.classList.remove('spinning');
  });
  $('#menu-button').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
}

async function initialize() {
  initializeEvents();
  setTodayLabel();
  refreshIcons();
  showApp({ email: 'Annisa Beno', is_anonymous: true });
  try {
    const health = await request('/api/health');
    if (!health.configured) {
      const setup = directSupabaseMode
        ? 'Isi url dan anonKey pada konstanta directSupabaseConfig di frontend/js/apps.js.'
        : 'Atur variabel koneksi di terminal server, lalu jalankan ulang backend.';
      $('#sync-label').textContent = 'Belum tersambung';
      toast(`Supabase belum dikonfigurasi. ${setup} Belum siap: ${health.missing.join(', ')}.`, true);
      return;
    }
    const session = await request('/api/auth/anonymous-login', { method: 'POST' });
    state.token = session.access_token;
    showApp(session.user);
    await loadData();
  } catch (error) {
    $('#sync-label').textContent = 'Gagal tersinkron';
    toast(error.message, true);
  }
}

document.addEventListener('DOMContentLoaded', initialize);

(() => {
  const journal = {
    accountId: 'all',
    from: '',
    to: '',
    printMode: null,
    initialized: false
  };

  const accountName = (id) => state.kas.find((account) => account.id === id)?.nama || 'Akun dihapus';
  const isFile = window.location.protocol === 'file:' || window.location.hostname.endsWith('.github.io');
  const today = new Date();
  const todayDate = dateKey(today);
  const monthStart = `${todayDate.slice(0, 7)}-01`;

  function defaultJournalFrom() {
    return state.transaksi.map((transaction) => transaction.tanggal).sort()[0] || monthStart;
  }

  function currentPrintRoute() {
    if (window.location.pathname === '/cetak/kas-semua') return { mode: 'all' };
    const match = window.location.pathname.match(/^\/cetak\/kas\/([0-9a-f-]{36})$/i);
    if (match) return { mode: 'account', accountId: match[1] };
    if (isFile && window.location.hash.startsWith('#cetak-kas-semua')) return { mode: 'all' };
    if (isFile && window.location.hash.startsWith('#cetak-kas-')) return { mode: 'account', accountId: window.location.hash.slice('#cetak-kas-'.length) };
    return null;
  }

  function setRoute(route) {
    if (isFile) {
      window.location.hash = route === '/jurnal-kas' ? 'jurnal-kas' : route.replaceAll('/', '-').slice(1);
      return;
    }
    window.history.pushState({}, '', route);
  }

  function ensurePanel() {
    let panel = document.getElementById('view-jurnal-kas');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.className = 'view-panel jurnal-kas-view';
    panel.id = 'view-jurnal-kas';
    panel.innerHTML = `
      <div class="page-heading jurnal-heading no-print">
        <div><p class="eyebrow">BUKU BESAR KAS</p><h1>Jurnal <em>kas</em></h1><p class="muted">Saldo awal dihitung dari seluruh mutasi sebelum tanggal mulai.</p></div>
        <button class="button button-quiet" type="button" id="journal-back"><i data-lucide="arrow-left"></i> Kembali</button>
      </div>
      <div class="jurnal-print-header"><strong>ANNISA BENO TEA HOUSE</strong><h1 id="journal-print-title">BUKU KAS</h1><p id="journal-print-period"></p></div>
      <form class="jurnal-filter no-print" id="journal-filter">
        <label>Akun kas<select id="journal-account"></select></label>
        <label>Dari tanggal<input id="journal-from" type="date" required></label>
        <label>Sampai tanggal<input id="journal-to" type="date" required></label>
        <button class="button button-primary" type="submit"><i data-lucide="filter"></i> Terapkan</button>
        <span class="jurnal-filter-spacer"></span>
        <button class="button button-quiet" type="button" id="journal-print-account"><i data-lucide="printer"></i> Cetak Akun Ini</button>
        <button class="button button-quiet" type="button" id="journal-print-all"><i data-lucide="printer"></i> Cetak Semua Kas</button>
        <p class="jurnal-error" id="journal-error" aria-live="polite"></p>
      </form>
      <div class="jurnal-print-account" id="journal-account-report">
        <div class="jurnal-summary"><div><span>Saldo awal</span><strong id="journal-opening">Rp0</strong></div><div><span>Total debit / masuk</span><strong class="jurnal-debit" id="journal-debit">Rp0</strong></div><div><span>Total kredit / keluar</span><strong class="jurnal-credit" id="journal-credit">Rp0</strong></div><div><span>Saldo akhir</span><strong id="journal-closing">Rp0</strong></div></div>
        <div class="jurnal-table-wrap"><table class="jurnal-table"><thead><tr><th>TANGGAL</th><th>KETERANGAN</th><th class="jurnal-number">DEBIT (MASUK)</th><th class="jurnal-number">KREDIT (KELUAR)</th><th class="jurnal-number">SALDO</th></tr></thead><tbody id="journal-rows"></tbody><tfoot><tr><th colspan="2">TOTAL MUTASI PERIODE</th><th class="jurnal-number jurnal-debit" id="journal-total-debit">Rp0</th><th class="jurnal-number jurnal-credit" id="journal-total-credit">Rp0</th><th class="jurnal-number" id="journal-total-balance">Rp0</th></tr></tfoot></table></div>
        <div class="jurnal-signatures"><div>Dibuat oleh,<span></span></div><div>Disetujui oleh,<span></span></div></div>
      </div>
      <div class="jurnal-print-all" id="journal-all-report">
        <div class="jurnal-table-wrap"><table class="jurnal-table"><thead><tr><th>NO</th><th>NAMA AKUN</th><th class="jurnal-number">SALDO AWAL</th><th class="jurnal-number">TOTAL MASUK</th><th class="jurnal-number">TOTAL KELUAR</th><th class="jurnal-number">SALDO AKHIR</th></tr></thead><tbody id="journal-all-rows"></tbody><tfoot><tr><th colspan="2">TOTAL</th><th class="jurnal-number" id="journal-all-opening">Rp0</th><th class="jurnal-number jurnal-debit" id="journal-all-debit">Rp0</th><th class="jurnal-number jurnal-credit" id="journal-all-credit">Rp0</th><th class="jurnal-number" id="journal-all-closing">Rp0</th></tr></tfoot></table></div>
        <div class="jurnal-signatures"><div>Dibuat oleh,<span></span></div><div>Disetujui oleh,<span></span></div></div>
      </div>`;
    document.querySelector('.main-content').append(panel);
    bindPanelEvents(panel);
    return panel;
  }

  function movements(accountId = 'all') {
    const rows = [];
    state.transaksi.forEach((transaction) => {
      (transaction.detail_transaksi || []).forEach((detail) => {
        if (accountId !== 'all' && detail.kas_id !== accountId) return;
        const direction = transaction.jenis === 'transfer' ? detail.arah : transaction.jenis;
        if (!['masuk', 'keluar'].includes(direction)) return;
        rows.push({
          tanggal: transaction.tanggal,
          createdAt: transaction.created_at || '',
          keterangan: transaction.catatan,
          akun: accountName(detail.kas_id),
          rincian: detail.catatan || detail.kategori?.nama || '',
          arah: direction,
          nominal: Number(detail.nominal || 0),
          jenis: transaction.jenis
        });
      });
    });
    return rows.sort((first, second) => first.tanggal.localeCompare(second.tanggal) || first.createdAt.localeCompare(second.createdAt));
  }

  function accountPeriod(accountId) {
    const allRows = movements(accountId);
    const openingRows = allRows.filter((row) => row.tanggal < journal.from);
    const periodRows = allRows.filter((row) => row.tanggal >= journal.from && row.tanggal <= journal.to);
    const opening = openingRows.reduce((balance, row) => balance + (row.arah === 'masuk' ? row.nominal : -row.nominal), 0);
    let balance = opening;
    let debit = 0;
    let credit = 0;
    const rows = periodRows.map((row) => {
      if (row.arah === 'masuk') debit += row.nominal;
      else credit += row.nominal;
      balance += row.arah === 'masuk' ? row.nominal : -row.nominal;
      return { ...row, saldo: balance };
    });
    return { opening, debit, credit, closing: balance, rows };
  }

  function renderJournal() {
    const panel = ensurePanel();
    const accountSelect = panel.querySelector('#journal-account');
    journal.from = journal.from || defaultJournalFrom();
    journal.to = journal.to || todayDate;
    const printRoute = currentPrintRoute();
    if (printRoute?.mode === 'account') journal.accountId = printRoute.accountId;
    const selectedAccount = journal.accountId || state.kas.find((account) => account.nama === 'Kas Utama')?.id || state.kas[0]?.id || 'all';
    journal.accountId = selectedAccount;
    accountSelect.innerHTML = `<option value="all">Semua Kas</option>${orderedKas().map((account) => `<option value="${account.id}">${escapeHtml(account.nama)}</option>`).join('')}`;
    accountSelect.value = selectedAccount;
    panel.querySelector('#journal-from').value = journal.from || monthStart;
    panel.querySelector('#journal-to').value = journal.to || todayDate;
    const account = state.kas.find((item) => item.id === journal.accountId);
    const allMode = journal.printMode === 'all' || printRoute?.mode === 'all';
    const selectedAccountId = journal.accountId === 'all' ? 'all' : journal.accountId;
    const period = accountPeriod(selectedAccountId);

    panel.querySelector('#journal-print-title').textContent = allMode ? 'REKAPITULASI SEMUA AKUN KAS' : `BUKU KAS - ${account?.nama || 'Semua Kas'}`;
    panel.querySelector('#journal-print-period').textContent = `Periode ${displayDate(journal.from)} s.d. ${displayDate(journal.to)}`;
    panel.querySelector('#journal-account-report').hidden = allMode;
    panel.querySelector('#journal-all-report').hidden = !allMode;
    panel.querySelector('#journal-print-account').disabled = state.kas.length === 0;

    panel.querySelector('#journal-opening').textContent = money(period.opening);
    panel.querySelector('#journal-debit').textContent = money(period.debit);
    panel.querySelector('#journal-credit').textContent = money(period.credit);
    panel.querySelector('#journal-closing').textContent = money(period.closing);
    panel.querySelector('#journal-total-debit').textContent = money(period.debit);
    panel.querySelector('#journal-total-credit').textContent = money(period.credit);
    panel.querySelector('#journal-total-balance').textContent = money(period.closing);
    panel.querySelector('#journal-rows').innerHTML = [
      `<tr class="jurnal-opening-row"><td>${displayDate(journal.from)}</td><td>Saldo Awal</td><td class="jurnal-number">-</td><td class="jurnal-number">-</td><td class="jurnal-number">${money(period.opening)}</td></tr>`,
      ...period.rows.map((row) => `<tr><td>${displayDate(row.tanggal)}</td><td>${escapeHtml(row.keterangan)}${journal.accountId === 'all' ? ` · ${escapeHtml(row.akun)}` : ''}${row.rincian ? `<small>${escapeHtml(row.rincian)}</small>` : ''}</td><td class="jurnal-number jurnal-debit">${row.arah === 'masuk' ? money(row.nominal) : '-'}</td><td class="jurnal-number jurnal-credit">${row.arah === 'keluar' ? money(row.nominal) : '-'}</td><td class="jurnal-number">${money(row.saldo)}</td></tr>`)
    ].join('');

    const accounts = state.kas.map((item) => {
      const summary = accountPeriod(item.id);
      return { nama: item.nama, ...summary };
    });
    const allTotals = accounts.reduce((totals, item) => ({ opening: totals.opening + item.opening, debit: totals.debit + item.debit, credit: totals.credit + item.credit, closing: totals.closing + item.closing }), { opening: 0, debit: 0, credit: 0, closing: 0 });
    panel.querySelector('#journal-all-rows').innerHTML = accounts.map((item, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(item.nama)}</td><td class="jurnal-number">${money(item.opening)}</td><td class="jurnal-number jurnal-debit">${money(item.debit)}</td><td class="jurnal-number jurnal-credit">${money(item.credit)}</td><td class="jurnal-number">${money(item.closing)}</td></tr>`).join('');
    panel.querySelector('#journal-all-opening').textContent = money(allTotals.opening);
    panel.querySelector('#journal-all-debit').textContent = money(allTotals.debit);
    panel.querySelector('#journal-all-credit').textContent = money(allTotals.credit);
    panel.querySelector('#journal-all-closing').textContent = money(allTotals.closing);
    refreshIcons();
  }

  function activateJournalView() {
    const panel = ensurePanel();
    document.querySelectorAll('.view-panel').forEach((item) => item.classList.toggle('active', item === panel));
    document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item.dataset.view === 'jurnal-kas'));
    document.querySelector('#breadcrumb-current').textContent = 'Jurnal Kas';
    document.querySelector('#sidebar').classList.remove('open');
  }

  function openJournal(route = true) {
    ensurePanel();
    if (!journal.from) journal.from = defaultJournalFrom();
    if (!journal.to) journal.to = todayDate;
    activateJournalView();
    renderJournal();
    if (route) setRoute('/jurnal-kas');
  }

  function printAccount() {
    if (journal.accountId === 'all') {
      const accountWithActivity = state.kas.find((account) => movements(account.id).some((row) => row.tanggal >= journal.from && row.tanggal <= journal.to));
      journal.accountId = accountWithActivity?.id || state.kas.find((account) => account.nama === 'Kas Utama')?.id || state.kas[0]?.id || '';
    }
    if (!journal.accountId) return;
    journal.printMode = 'account';
    setRoute(`/cetak/kas/${journal.accountId}`);
    activateJournalView();
    renderJournal();
    document.body.classList.add('jurnal-printing');
    window.print();
  }

  function printAllAccounts() {
    journal.printMode = 'all';
    setRoute('/cetak/kas-semua');
    activateJournalView();
    renderJournal();
    document.body.classList.add('jurnal-printing');
    window.print();
  }

  function bindPanelEvents(panel) {
    panel.querySelector('#journal-filter').addEventListener('submit', (event) => {
      event.preventDefault();
      const from = panel.querySelector('#journal-from').value;
      const to = panel.querySelector('#journal-to').value;
      if (!from || !to || from > to) {
        panel.querySelector('#journal-error').textContent = 'Tanggal awal harus sama dengan atau sebelum tanggal akhir.';
        return;
      }
      panel.querySelector('#journal-error').textContent = '';
      journal.from = from;
      journal.to = to;
      journal.accountId = panel.querySelector('#journal-account').value;
      renderJournal();
    });
    panel.querySelector('#journal-account').addEventListener('change', (event) => {
      journal.accountId = event.target.value;
      renderJournal();
    });
    panel.querySelector('#journal-print-account').addEventListener('click', printAccount);
    panel.querySelector('#journal-print-all').addEventListener('click', printAllAccounts);
    panel.querySelector('#journal-back').addEventListener('click', () => {
      setView('overview');
      document.querySelector('#breadcrumb-current').textContent = 'Ringkasan';
      setRoute('/');
    });
  }

  function setupJournal() {
    const link = document.querySelector('[data-view="jurnal-kas"]');
    if (link) link.addEventListener('click', (event) => {
      event.preventDefault();
      openJournal();
    });

    window.addEventListener('afterprint', () => {
      journal.printMode = null;
      document.body.classList.remove('jurnal-printing', 'jurnal-print-all');
      if ((!isFile && window.location.pathname.startsWith('/cetak/')) || (isFile && window.location.hash.startsWith('#cetak-kas'))) setRoute('/jurnal-kas');
      activateJournalView();
      renderJournal();
    });

    const printRoute = currentPrintRoute();
    const journalRoute = window.location.pathname === '/jurnal-kas' || (isFile && window.location.hash === '#jurnal-kas');
    if (printRoute) {
      journal.printMode = printRoute.mode;
      if (printRoute.accountId) journal.accountId = printRoute.accountId;
    }

    const appShell = document.querySelector('#app-shell');
    const syncLabel = document.querySelector('#sync-label');
    let initialRouteHandled = false;
    const observer = new MutationObserver(() => {
      if (appShell.hidden || syncLabel.textContent !== 'Tersinkron') return;
      if (!initialRouteHandled) {
        initialRouteHandled = true;
        if (printRoute) {
          journal.from = journal.from || defaultJournalFrom();
          journal.to = journal.to || todayDate;
          openJournal(false);
          renderJournal();
          window.setTimeout(() => window.print(), 150);
        } else if (journalRoute) {
          openJournal(false);
        }
        return;
      }
      if (document.querySelector('#view-jurnal-kas.active')) renderJournal();
    });
    observer.observe(syncLabel, { childList: true, characterData: true, subtree: true });
    observer.observe(appShell, { attributes: true, attributeFilter: ['hidden'] });
    if (!appShell.hidden && syncLabel.textContent === 'Tersinkron') {
      if (printRoute) {
        journal.from = journal.from || defaultJournalFrom();
        journal.to = journal.to || todayDate;
        openJournal(false);
        renderJournal();
        window.setTimeout(() => window.print(), 150);
      } else if (journalRoute) {
        openJournal(false);
      }
      initialRouteHandled = true;
    }

    window.addEventListener('popstate', () => {
      if (window.location.pathname === '/jurnal-kas') openJournal(false);
      else if (!window.location.pathname.startsWith('/cetak/')) {
        setView('overview');
        document.querySelector('#breadcrumb-current').textContent = 'Ringkasan';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupJournal();
    if (window.location.hash === '#jurnal-kas' && !document.querySelector('#app-shell').hidden) openJournal(false);
  });
})();
