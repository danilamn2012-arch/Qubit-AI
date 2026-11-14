/**
 * Единое состояние приложения и события.
 * UI-модули читают state и подписываются на изменения через bus.
 */

import * as store from './storage.js';
import { effectiveContext, historyTokens, costOf } from './pricing.js';

/* ------------------------------- События ------------------------------- */

const listeners = new Map();

export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  },
  emit(event, payload) {
    (listeners.get(event) || new Set()).forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error('Ошибка обработчика', event, err);
      }
    });
  },
};

/* ------------------------------- Состояние ------------------------------ */

export const state = {
  settings: store.loadSettings(),
  chats: [],
  chat: null,
  files: [],
  attachments: [],
  busy: false,
  controller: null,
  live: null,
  ready: false,
};

/* ------------------------------ Настройки ------------------------------ */

export function persistSettings(patch) {
  if (patch) Object.assign(state.settings, patch);
  store.saveSettings(state.settings);
  bus.emit('settings:changed', state.settings);
}

/** Заглушка, пока пользователь не подключил API и не добавил модель. */
export const NO_MODEL = {
  id: '',
  name: 'Модель не выбрана',
  context: 128000,
  tools: true,
  input: ['text'],
  output: ['text'],
  priceIn: 0,
  priceOut: 0,
  note: 'Добавьте модель в настройках',
};

export function getModel(id) {
  const list = state.settings.models || [];
  const wanted = id || state.settings.activeModelId;
  return list.find((m) => m.id === wanted) || list[0] || NO_MODEL;
}

/** Есть ли хоть одна рабочая модель (с непустым ID). */
export function hasModel() {
  return (state.settings.models || []).some((m) => m.id);
}

export function currentModel() {
  const id = (state.chat && state.chat.modelId) || state.settings.activeModelId;
  return getModel(id);
}

export function setModel(id) {
  if (state.busy) return;
  // Модель запоминается в чате, чтобы старые диалоги не меняли поведение
  if (state.chat) {
    state.chat.modelId = id;
    scheduleSave();
  }
  persistSettings({ activeModelId: id });
  bus.emit('model:changed', getModel(id));
}

export function setEffort(id) {
  if (state.busy) return;
  if (state.chat) {
    state.chat.effort = id;
    scheduleSave();
  }
  persistSettings({ effort: id });
  bus.emit('effort:changed', id);
}

export function currentEffort() {
  return (state.chat && state.chat.effort) || state.settings.effort || 'medium';
}

export function applyTheme(theme) {
  const t = theme || 'auto';
  state.settings.theme = t;
  const resolved = t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#171613' : '#f7f5ef');
}

/** Следит за системной темой, когда выбран режим «как в системе». */
export function watchSystemTheme() {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (state.settings.theme === 'auto') applyTheme('auto');
  };
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else if (mq.addListener) mq.addListener(handler);
}

export function applyScale(scale) {
  const s = Number(scale) || 1;
  document.documentElement.style.setProperty('--scale', String(s));
}

/* -------------------------------- Чаты --------------------------------- */

export async function refreshChats() {
  state.chats = await store.listChats();
  bus.emit('chats:updated', state.chats);
}

export async function openChat(id) {
  const chat = await store.getChat(id);
  if (!chat) return false;
  state.chat = chat;
  if (!chat.stats) chat.stats = { in: 0, out: 0, cost: 0 };
  state.files = await store.listFiles(id);
  state.attachments = [];
  bus.emit('chat:opened', chat);
  bus.emit('files:updated', state.files);
  return true;
}

/** Обновляет запись чата в списке без полной перезагрузки. */
export async function touchChat(chat) {
  if (!chat) return;
  await store.saveChat(chat);
  await refreshChats();
}

export function newChat() {
  state.chat = null;
  state.files = [];
  state.attachments = [];
  bus.emit('chat:cleared');
  bus.emit('files:updated', []);
}

export async function ensureChat() {
  if (state.chat) return state.chat;
  const chat = store.createChat();
  await store.saveChat(chat);
  state.chat = chat;
  await refreshChats();
  bus.emit('chat:created', chat);
  return chat;
}

let saveTimer = null;

export function scheduleSave() {
  if (!state.chat) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow();
  }, 350);
}

export async function saveNow() {
  if (!state.chat) return;
  clearTimeout(saveTimer);
  await store.saveChat(state.chat);
  await refreshChats();
}

export async function deleteChat(id) {
  await store.deleteChat(id);
  if (state.chat && state.chat.id === id) newChat();
  await refreshChats();
}

/* -------------------------------- Файлы -------------------------------- */

export async function reloadFiles() {
  state.files = state.chat ? await store.listFiles(state.chat.id) : [];
  bus.emit('files:updated', state.files);
  return state.files;
}

/* ------------------------------ Контекст ------------------------------- */

export function contextInfo() {
  const model = currentModel();
  const limit = effectiveContext(model, state.settings);
  const messages = state.chat ? state.chat.messages.filter((m) => m.role !== 'tool') : [];
  const used =
    historyTokens(messages.map((m) => ({ content: m.content, images: m.images, toolCalls: m.toolCalls }))) +
    (state.chat && state.chat.summary ? Math.ceil(state.chat.summary.length / 3) : 0) +
    900;
  const percent = Math.min(100, Math.round((used / limit) * 100));
  return { used, limit, percent, model };
}

export function sessionStats() {
  const s = (state.chat && state.chat.stats) || { in: 0, out: 0, cost: 0 };
  return { ...s };
}

export function addUsage(inTok, outTok, estimated) {
  if (!state.chat) return;
  const model = currentModel();
  const cost = costOf(model, inTok, outTok);
  const s = (state.chat.stats = state.chat.stats || { in: 0, out: 0, cost: 0 });
  s.in += inTok;
  s.out += outTok;
  s.cost += cost;
  s.estimated = !!estimated || s.estimated;
  bus.emit('usage:updated', sessionStats());
}

/* ------------------------------- Утилиты ------------------------------- */

export function setBusy(value, controller) {
  state.busy = value;
  state.controller = value ? controller : null;
  bus.emit('busy:changed', value);
}

export function autoTitle(text) {
  if (!state.chat || !state.settings.autoTitle) return;
  if (state.chat.title && state.chat.title !== 'Новый чат') return;
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 56);
  state.chat.title = t || 'Новый чат';
  scheduleSave();
}

export { store };
