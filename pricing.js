/**
 * Подсчёт стоимости и оценка токенов.
 * Цены моделей задаются в рублях за 1 млн токенов (вход/выход).
 */

/** Грубая оценка: ~3.2 символа на токен для смеси русского и кода. */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cyr = (s.match(/[А-Яа-яЁё]/g) || []).length;
  const other = s.length - cyr;
  return Math.ceil(cyr / 2.2 + other / 3.9);
}

export function messageTokens(m) {
  if (!m) return 0;
  let n = estimateTokens(m.content) + 4;
  if (m.images && m.images.length) n += m.images.length * 850;
  if (m.toolCalls && m.toolCalls.length) {
    n += m.toolCalls.reduce((a, c) => a + estimateTokens(c.name) + estimateTokens(JSON.stringify(c.args || {})), 0);
  }
  return n;
}

export function historyTokens(messages) {
  return (messages || []).reduce((a, m) => a + messageTokens(m), 0);
}

export function costOf(model, inTokens, outTokens) {
  if (!model) return 0;
  const pin = Number(model.priceIn) || 0;
  const pout = Number(model.priceOut) || 0;
  return (inTokens / 1e6) * pin + (outTokens / 1e6) * pout;
}

/** Форматирование денег: 12,48 ₽ */
export function formatRub(value) {
  const v = Number(value) || 0;
  if (v === 0) return '0 ₽';
  if (v < 0.01) return '<0,01 ₽';
  const digits = v < 1 ? 3 : 2;
  return (
    v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/\u00a0/g, ' ') +
    ' ₽'
  );
}

export function formatNumber(n) {
  return Math.round(Number(n) || 0)
    .toLocaleString('ru-RU')
    .replace(/\u00a0/g, ' ');
}

export function formatCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1).replace('.', ',') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1).replace('.', ',') + 'K';
  return String(v);
}

/** Эффективный размер контекста выбранной модели с учётом пользовательского лимита. */
export function effectiveContext(model, settings, effort) {
  let ctx = Number(model && model.context) || 32000;
  const cap = Number(settings && settings.contextCap) || 0;
  if (cap > 0) ctx = Math.min(ctx, cap);
  const reserve = Math.min(4000, Math.round(ctx * 0.12));
  return Math.max(2000, ctx - reserve);
}
