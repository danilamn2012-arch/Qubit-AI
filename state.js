/**
 * Единое состояние приложения и события.
 * UI-модули читают state и подписываются на изменения через bus.
 */

import * as store from './storage.js';
import { effectiveContext, historyTokens, costOf } from './pricing.js';
import { effortsOf } from './config.js';
import { providerForModel, isProviderEnabled, providersOf, providerById, modelKey, splitModelKey } from './providers.js';

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

/**
 * Включена ли модель.
 *
 * У шлюзов вроде OpenRouter в одном API сотни моделей. При импорте они
 * добавляются выключенными: иначе список в чате превращался в свалку.
 * Старые записи без поля `enabled` считаем включёнными — иначе после
 * обновления у пользователя пропали бы все модели.
 */
export function isModelEnabled(model) {
  return !!model && model.enabled !== false;
}

/** Модели, которые показываются в чате: с ID, включённые и у включённого провайдера. */
export function enabledModels(list) {
  const src = Array.isArray(list) ? list : state.settings.models || [];
  return src.filter((m) => m.id && isModelEnabled(m) && providerUsable(state.settings, m));
}

/** Доступен ли провайдер модели: он существует и включён. */
export function providerUsable(settings, model) {
  const provider = providerForModel(settings, model);
  return !!provider && isProviderEnabled(provider);
}

/**
 * Модель по ID. Ищем и среди выключенных: старые сообщения должны сохранять
 * название модели, даже если её потом отключили.
 *
 * `providerId` уточняет поиск: одинаковый ID бывает у разных провайдеров.
 */
export function getModel(id, providerId) {
  const list = state.settings.models || [];
  const wanted = id || state.settings.activeModelId;
  const pid = providerId || (id ? '' : state.settings.activeProviderId);
  const found = pid
    ? list.find((m) => m.id === wanted && (m.providerId || pid) === pid)
    : list.find((m) => m.id === wanted);
  if (found) return found;
  if (wanted) {
    const loose = list.find((m) => m.id === wanted);
    if (loose) return loose;
  }
  return list.find((m) => m.id && isModelEnabled(m)) || list[0] || NO_MODEL;
}

/**
 * Модель по ключу «провайдер::id».
 *
 * Один и тот же ID бывает у разных провайдеров, поэтому выбор в интерфейсе
 * хранит ключ, а не голый id.
 */
export function getModelByKey(key) {
  const { providerId, id } = splitModelKey(key);
  const list = state.settings.models || [];
  const found = list.find((m) => m.id === id && (!providerId || (m.providerId || providerId) === providerId));
  return found || getModel(id);
}

/** Ключ модели для интерфейса. */
export function keyOf(model) {
  return modelKey(model);
}

/** Есть ли хоть одна включённая модель с ID. */
export function hasModel() {
  return (state.settings.models || []).some((m) => m.id && isModelEnabled(m) && providerUsable(state.settings, m));
}

export function currentModel() {
  const id = (state.chat && state.chat.modelId) || state.settings.activeModelId;
  const pid = state.chat && state.chat.modelId ? state.chat.modelProviderId : state.settings.activeProviderId;
  const model = getModel(id, pid);
  // В API нельзя отправить выключенную модель: если старая модель в чате
  // отключена (или выключен её провайдер), берём первую доступную.
  if (model.id && (!isModelEnabled(model) || !providerUsable(state.settings, model))) {
    return (state.settings.models || []).find((m) => m.id && isModelEnabled(m) && providerUsable(state.settings, m)) || NO_MODEL;
  }
  return model;
}

export function setModel(key) {
  if (state.busy) return;
  // Ключ может быть «провайдер::id»: один и тот же ID бывает у разных
  // провайдеров, и выбрать нужно именно нужную запись.
  const { providerId, id } = splitModelKey(key);
  const target = (state.settings.models || []).find(
    (m) => m.id === id && (!providerId || (m.providerId || providerId) === providerId),
  );
  // Выключенную модель выбрать нельзя: в чате показываются только включённые.
  if (target && !isModelEnabled(target)) return;
  // Модель запоминается в чате, чтобы старые диалоги не меняли поведение
  if (state.chat) {
    state.chat.modelId = id;
    state.chat.modelProviderId = providerId || (target && target.providerId) || '';
    scheduleSave();
  }
  persistSettings({
    activeModelId: id,
    activeProviderId: providerId || (target && target.providerId) || state.settings.activeProviderId,
  });
  bus.emit('model:changed', target || getModel(id));
}

/**
 * Текущий уровень рассуждений.
 *
 * Значение имеет смысл только если модель его объявила. Если список пуст —
 * возвращаем null: интерфейс не показывает выбор, а в запрос не уходит
 * `reasoning_effort`.
 */
export function currentEffort() {
  const model = currentModel();
  const allowed = effortsOf(model);
  if (!allowed.length) return null;
  const wanted = (state.chat && state.chat.effort) || state.settings.effort || '';
  return allowed.includes(wanted) ? wanted : allowed[0];
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

/* ----------------------------- Провайдеры ------------------------------- */

/** Провайдер, к которому относится текущая модель. */
export function currentProvider() {
  return providerForModel(state.settings, currentModel());
}

export function providerList() {
  return providersOf(state.settings);
}

/**
 * Добавляет провайдера и его модели.
 *
 * Используется и ручным добавлением, и ссылкой-приглашением. Возвращает
 * созданного провайдера: вызывающий код показывает его в интерфейсе.
 */
export function addProvider(provider, models = []) {
  const list = providerList().slice();
  const entry = {
    stream: true,
    enabled: true,
    restricted: false,
    name: 'Провайдер',
    ...provider,
  };
  list.push(entry);
  const nextModels = (state.settings.models || []).filter(
    (m) => !(m.providerId === entry.id && models.some((x) => x.id === m.id)),
  );
  models.forEach((m) => nextModels.push({ enabled: true, tools: true, input: ['text'], output: ['text'], ...m, providerId: entry.id }));
  persistSettings({ providers: list, models: nextModels });
  return entry;
}

export function updateProvider(id, patch) {
  const list = providerList().map((p) => (p.id === id ? { ...p, ...patch } : p));
  persistSettings({ providers: list });
}

/**
 * Удаляет провайдера вместе с его моделями.
 *
 * Чаты, где эти модели использовались, не трогаем: `currentModel` сам перейдёт
 * на доступную модель, а старые сообщения сохранят название.
 */
export function removeProvider(id) {
  const providers = providerList().filter((p) => p.id !== id);
  const models = (state.settings.models || []).filter((m) => m.providerId !== id);
  persistSettings({ providers, models });
  const active = state.settings.activeModelId;
  if (!models.some((m) => m.id === active && m.enabled !== false)) {
    state.settings.activeModelId = models.find((m) => m.id && m.enabled !== false)?.id || '';
    store.saveSettings(state.settings);
  }
  if (!providers.some((p) => p.id === state.settings.activeProviderId)) {
    state.settings.activeProviderId = providers[0]?.id || '';
    store.saveSettings(state.settings);
  }
  bus.emit('settings:changed', state.settings);
}

/** Включает или выключает провайдера: его модели пропадают из чата. */
export function setProviderEnabled(id, enabled) {
  updateProvider(id, { enabled: !!enabled });
  const active = currentModel();
  if (active.id) persistSettings({ activeModelId: active.id });
  bus.emit('model:changed', active);
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
