/**
 * Провайдеры: чистые помощники без DOM и без состояния.
 *
 * Провайдер — это один подключённый API: адрес, ключ, заголовки. Раньше он был
 * один на всё приложение (`settings.provider`), поэтому второй ключ добавить
 * было нельзя. Теперь их список, а каждая модель знает своего провайдера через
 * `providerId`.
 */

/** Список провайдеров из настроек. */
export function providersOf(settings) {
  const list = settings && settings.providers;
  return Array.isArray(list) ? list.filter((p) => p && typeof p === 'object') : [];
}

export function providerById(settings, id) {
  if (!id) return null;
  return providersOf(settings).find((p) => p.id === id) || null;
}

/** Провайдер включён. Выключенный не показывается в чате, но остаётся в списке. */
export function isProviderEnabled(provider) {
  return !!provider && provider.enabled !== false;
}

/**
 * Провайдер модели. Если у модели нет providerId (старые записи) — первый
 * включённый, иначе первый в списке.
 */
export function providerForModel(settings, model) {
  const list = providersOf(settings);
  if (model && model.providerId) {
    const own = list.find((p) => p.id === model.providerId);
    if (own) return own;
  }
  return list.find(isProviderEnabled) || list[0] || null;
}

export function providerLabel(provider) {
  if (!provider) return 'Провайдер';
  return String(provider.name || provider.preset || 'Провайдер');
}

/** Хост без пути и без ключа — его безопасно показывать. */
export function providerHost(provider) {
  const raw = String((provider && provider.baseUrl) || '');
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').split('/')[0];
  }
}

export function newProviderId() {
  return 'prov-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * Ключ модели в интерфейсе.
 *
 * Один и тот же ID может прийти от разных провайдеров (gpt-4.1 есть и у OpenAI,
 * и у OpenRouter), поэтому одного `id` для выбора мало.
 */
export function modelKey(model) {
  if (!model) return '';
  return `${model.providerId || ''}::${model.id || ''}`;
}

/** Обратный разбор ключа модели. */
export function splitModelKey(key) {
  const raw = String(key || '');
  const at = raw.indexOf('::');
  if (at < 0) return { providerId: '', id: raw };
  return { providerId: raw.slice(0, at), id: raw.slice(at + 2) };
}
