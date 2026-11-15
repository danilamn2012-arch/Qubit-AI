/**
 * Ссылки-приглашения: передача доступа к провайдеру без открытого ключа.
 *
 * Задача — отправить человеку ссылку, по которой он получит доступ к вашим
 * моделям, но:
 *   - URL API и ключ не видны в адресной строке открытым текстом;
 *   - ссылка укладывается в разумную длину (цель — до 200 символов);
 *   - можно ограничить набор моделей, и получатель увидит только названия.
 *
 * Шифрование намеренно простое. Это не защита от того, кому ключ и так
 * предназначен: получатель должен суметь воспользоваться ключом, значит он
 * есть внутри ссылки. Задача — не показывать секрет в истории браузера,
 * мессенджерах и логах и не давать скопировать его вручную.
 *
 * Схема:
 *   1. JSON { u: baseUrl, k: apiKey, h: {headers}, n: name, m: [[id, name]] }
 *   2. UTF-8 → XOR с ключевым потоком → base64url.
 *
 * Ключевой поток — SHA-256 от общего секрета (константа + соль ссылки),
 * развёрнутый в нужную длину. Без секрета из кода приложения содержимое не
 * прочитать, но это не криптостойкая защита: код открыт, и тот, кто знает
 * формат, может расшифровать. Так и задумано — ссылка и есть носитель ключа.
 */

const SECRET = 'qubit-invite-v1';
const MAX_LINK = 4000;

/* ------------------------------ Base64url ------------------------------ */

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const s = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------------------- Поток ключа ------------------------------ */

/** SHA-256 от строки. Нужен только для растягивания пароля в поток. */
async function sha256(text) {
  if (globalThis.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return new Uint8Array(buf);
  }
  return simpleHash(text);
}

/** Запасной хеш на случай, если страница открыта не по https. */
function simpleHash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  const src = enc.encode(text);
  for (const b of src) {
    h1 = (h1 ^ b) * 16777619;
    h2 = (h2 + b) * 2654435761;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (h1 >>> (i % 4) * 8) ^ (h2 >>> (i % 4) * 8);
    h1 = h1 * 1664525 + 1013904223;
    h2 = h2 * 22695477 + 1;
  }
  return out;
}

/** Поток нужной длины из соли: повторяем SHA-256 над солью и счётчиком. */
async function keyStream(salt, length) {
  const out = new Uint8Array(length);
  let block = await sha256(SECRET + '|' + salt);
  let pos = 0;
  let counter = 0;
  while (pos < length) {
    for (let i = 0; i < block.length && pos < length; i++, pos++) out[pos] = block[i];
    counter++;
    block = await sha256(SECRET + '|' + salt + '|' + counter);
  }
  return out;
}

/** Случайная соль: 6 байт дают короткий, но не повторяющийся хвост. */
function newSalt() {
  const bytes = new Uint8Array(6);
  if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return toBase64Url(bytes);
}

/* ------------------------------ Сжатие -------------------------------- */

/**
 * deflate — в браузере есть почти везде. Без него ссылка тоже работает, просто
 * длиннее: старый формат читается тем же кодом, потому что сжатие помечено
 * префиксом.
 */
async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/* ------------------------------ Кодирование ---------------------------- */

async function encryptString(text, salt) {
  let data = enc.encode(text);
  // Метка сжатия: первый байт «z» значит «внутри deflate».
  const packed = await deflate(data);
  if (packed) {
    const marked = new Uint8Array(packed.length + 1);
    marked[0] = 0x7a; // 'z'
    marked.set(packed, 1);
    data = marked;
  }
  const stream = await keyStream(salt, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  return toBase64Url(out);
}

async function decryptString(payload, salt) {
  const data = fromBase64Url(payload);
  const stream = await keyStream(salt, data.length);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ stream[i];
  if (out[0] === 0x7a) {
    const inflated = await inflate(out.slice(1));
    if (inflated) return dec.decode(inflated);
  }
  return dec.decode(out);
}

/* -------------------------------- Модели ------------------------------- */

/**
 * Сжимает модель до пары [id, подпись].
 *
 * Получатель видит только название, но приложение обращается к API по ID,
 * поэтому ID передаётся внутри ссылки вместе с подписью. Контекст, цены и
 * прочие характеристики не передаём: их можно получить из `/models`
 * провайдера, а лишние байты удлиняют ссылку.
 */
function packModels(models) {
  return (models || [])
    .filter((m) => m && m.id)
    .map((m) => [String(m.id), String(m.name || m.id)]);
}

function unpackModels(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => Array.isArray(r) && r[0])
    .map((r) => ({ id: String(r[0]), name: String(r[1] || r[0]) }));
}

/* ------------------------------- Сборка -------------------------------- */

/**
 * Формирует ссылку-приглашение.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {object} [opts.headers]  дополнительные заголовки объектом
 * @param {string} [opts.name]     подпись провайдера для получателя
 * @param {Array}  [opts.models]   разрешённые модели [{id,name}]
 * @param {string} [opts.origin]   адрес сайта; по умолчанию текущий
 * @returns {Promise<{url:string, tooLong:boolean, length:number}>}
 */
export async function buildInviteLink({ baseUrl, apiKey, headers, name, models, origin } = {}) {
  const payload = {
    u: String(baseUrl || '').trim(),
    k: String(apiKey || '').trim(),
  };
  const h = cleanHeaders(headers);
  if (Object.keys(h).length) payload.h = h;
  if (name) payload.n = String(name).slice(0, 60);
  const packed = packModels(models);
  if (packed.length) payload.m = packed;

  const salt = newSalt();
  const body = await encryptString(JSON.stringify(payload), salt);
  // Соль идёт отдельным сегментом: получатель узнает её из ссылки, а без неё
  // поток ключа не собрать.
  const base = String(origin || location.origin + location.pathname).replace(/[?#].*$/, '');
  const url = `${base}#i=${salt}.${body}`;
  return { url, tooLong: url.length > MAX_LINK, length: url.length };
}

/** Дополнительные заголовки: только строки, без пустых значений. */
function cleanHeaders(headers) {
  const out = {};
  Object.entries(headers || {}).forEach(([k, v]) => {
    const key = String(k || '').trim();
    const value = String(v == null ? '' : v).trim();
    if (key && value) out[key] = value;
  });
  return out;
}

/**
 * Разбирает `#i=...` из адреса.
 *
 * Данные намеренно в хэше, а не в query: хэш не уходит на сервер, поэтому ключ
 * не попадёт в логи и в Referer.
 *
 * @returns {Promise<null|{baseUrl,apiKey,headers,name,models}>}
 */
export async function parseInviteFromHash(hash) {
  const raw = String(hash || '');
  const m = raw.match(/(?:^#|&)i=([^&]+)/);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 2) return null;
  const [salt, body] = parts;
  let json;
  try {
    json = JSON.parse(await decryptString(body, salt));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || !json.u) return null;
  return {
    baseUrl: String(json.u),
    apiKey: String(json.k || ''),
    headers: json.h && typeof json.h === 'object' ? json.h : {},
    name: String(json.n || ''),
    models: unpackModels(json.m),
  };
}
