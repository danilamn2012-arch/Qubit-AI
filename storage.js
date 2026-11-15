/**
 * Хранилище Qubit AI.
 *
 * IndexedDB: чаты (с сообщениями) и виртуальные файлы проектов.
 * localStorage: настройки (провайдер, ключ, модели, тема).
 *
 * Схема:
 *   chats  { id, title, createdAt, updatedAt, pinned, messages[], summary, stats, modelId, effort }
 *   files  { chatId, path, content, updatedAt }   keyPath ['chatId','path']
 */

import { APP, DEFAULT_SETTINGS, PROVIDERS } from './config.js';

const DB_NAME = 'qubit-ai';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('chats')) {
        const chats = db.createObjectStore('chats', { keyPath: 'id' });
        chats.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('files')) {
        const files = db.createObjectStore('files', { keyPath: ['chatId', 'path'] });
        files.createIndex('chatId', 'chatId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        try {
          result = fn(s);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const wrap = (req) => ({ __req: req });

/* ------------------------------- Чаты ------------------------------- */

export function newChatId() {
  return 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function createChat(overrides = {}) {
  const now = Date.now();
  return {
    id: newChatId(),
    title: 'Новый чат',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    messages: [],
    summary: null,
    stats: { in: 0, out: 0, cost: 0 },
    modelId: null,
    effort: null,
    ...overrides,
  };
}

export async function listChats() {
  const rows = await tx('chats', 'readonly', (s) => wrap(s.getAll()));
  return (rows || [])
    .map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      pinned: !!c.pinned,
      messageCount: c.messages ? c.messages.length : 0,
      preview: previewOf(c),
      stats: c.stats || { in: 0, out: 0, cost: 0 },
    }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

function previewOf(chat) {
  const last = [...(chat.messages || [])].reverse().find((m) => m.role === 'user' && m.content);
  if (!last) return 'Пустой чат';
  return String(last.content).replace(/\s+/g, ' ').slice(0, 80);
}

export function getChat(id) {
  return tx('chats', 'readonly', (s) => wrap(s.get(id)));
}

export async function saveChat(chat) {
  chat.updatedAt = Date.now();
  await tx('chats', 'readwrite', (s) => s.put(structuredClone(chat)));
  return chat;
}

export async function deleteChat(id) {
  await tx('chats', 'readwrite', (s) => s.delete(id));
  await deleteAllFiles(id);
}

export async function clearAllChats() {
  const ids = (await listChats()).map((c) => c.id);
  await tx('chats', 'readwrite', (s) => s.clear());
  for (const id of ids) await deleteAllFiles(id);
}

/* ------------------------------ Файлы ------------------------------- */

export async function listFiles(chatId) {
  const rows = await tx('files', 'readonly', (s) => wrap(s.index('chatId').getAll(chatId)));
  return (rows || []).sort((a, b) => a.path.localeCompare(b.path));
}

export function getFile(chatId, path) {
  return tx('files', 'readonly', (s) => wrap(s.get([chatId, path])));
}

export async function putFile(chatId, path, content) {
  const rec = { chatId, path, content, updatedAt: Date.now() };
  await tx('files', 'readwrite', (s) => s.put(rec));
  return rec;
}

export function deleteFile(chatId, path) {
  return tx('files', 'readwrite', (s) => s.delete([chatId, path]));
}

export async function deleteAllFiles(chatId) {
  const rows = await listFiles(chatId);
  await Promise.all(rows.map((r) => deleteFile(chatId, r.path)));
}

/* ----------------------------- Настройки ---------------------------- */

/**
 * Приводит настройки к текущей схеме.
 *
 * До 1.4.0 подключение было одно: `provider` + плоский список `models`.
 * Теперь провайдеров несколько, и модель знает своего через `providerId`.
 * Миграция не должна ничего терять: старый ключ и модели переезжают в первый
 * провайдер, иначе после обновления пользователь остался бы без подключения.
 */
function mergeSettings(base, patch) {
  const out = { ...base, ...patch };
  out.search = { ...base.search, ...(patch.search || {}) };

  /* --- Провайдеры --- */
  let providers = Array.isArray(patch.providers) ? patch.providers.filter((p) => p && typeof p === 'object') : [];
  if (!providers.length && patch.provider) {
    // Старая схема: единственный провайдер.
    const old = patch.provider;
    providers = [
      {
        ...base.providers[0],
        preset: old.preset || base.providers[0].preset,
        baseUrl: old.baseUrl || base.providers[0].baseUrl,
        apiKey: old.apiKey || '',
        extraHeaders: old.extraHeaders || '',
        stream: old.stream !== false,
      },
    ];
  }
  if (!providers.length) providers = base.providers.map((p) => ({ ...p }));

  providers = providers.map((p, i) => ({
    ...base.providers[0],
    ...p,
    id: p.id || (i === 0 ? base.providers[0].id : 'prov-' + i + '-' + Math.random().toString(36).slice(2, 7)),
    name: p.name || presetName(p.preset) || 'Провайдер',
    stream: p.stream !== false,
    enabled: p.enabled !== false,
  }));

  // IDs должны быть уникальны, иначе модели перепутают провайдеров.
  const seen = new Set();
  providers = providers.map((p) => {
    let id = p.id;
    while (seen.has(id)) id = id + '-' + Math.random().toString(36).slice(2, 5);
    seen.add(id);
    return { ...p, id };
  });
  out.providers = providers;

  /* --- Модели --- */
  if (!Array.isArray(out.models) || !out.models.length) out.models = base.models;
  // Демо-режим удалён: старые записи из localStorage больше не нужны
  out.models = out.models.filter((m) => m && !m.demo && m.id !== 'qubit/demo');
  out.models = out.models.map((m) => {
    const next = { ...m };
    // Поле `enabled` появилось в 1.3.6: у старых моделей его нет — включаем,
    // иначе после обновления список в чате оказался бы пустым.
    if (next.enabled === undefined) next.enabled = true;
    // Провайдер модели появился в 1.4.0: старые модели принадлежат первому.
    if (!next.providerId) next.providerId = providers[0].id;
    return next;
  });

  /* --- Активные значения --- */
  const enabledModels = out.models.filter((m) => m.id && m.enabled !== false);
  if (!enabledModels.some((m) => m.id === out.activeModelId)) out.activeModelId = enabledModels[0]?.id || '';
  if (!providers.some((p) => p.id === out.activeProviderId)) {
    out.activeProviderId = providers.find((p) => p.enabled !== false)?.id || providers[0].id;
  }
  // Старое поле больше не используется, но оставленный ключ в localStorage
  // означал бы дубль секрета — убираем.
  delete out.provider;
  return out;
}

/** Имя провайдера по пресету — для миграции и новых записей. */
function presetName(presetId) {
  const p = PROVIDERS.find((x) => x.id === presetId);
  return p ? p.name : '';
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(APP.storageKey);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(APP.storageKey, JSON.stringify(settings));
  } catch (err) {
    console.warn('Не удалось сохранить настройки', err);
  }
}

/* --------------------------- Экспорт/импорт -------------------------- */

export async function exportAll() {
  const chats = [];
  for (const meta of await listChats()) {
    const chat = await getChat(meta.id);
    const files = await listFiles(meta.id);
    chats.push({ ...chat, files });
  }
  return { app: APP.name, version: APP.version, exportedAt: new Date().toISOString(), settings: loadSettings(), chats };
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.chats)) throw new Error('Неверный формат файла резервной копии');
  if (data.settings) saveSettings(mergeSettings(DEFAULT_SETTINGS, data.settings));
  for (const chat of data.chats) {
    const { files, ...rest } = chat;
    await saveChat(rest);
    for (const f of files || []) await putFile(rest.id, f.path, f.content);
  }
}
