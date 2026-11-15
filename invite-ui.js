/**
 * Приём ссылки-приглашения.
 *
 * Открывается при загрузке, если в адресе есть `#i=...`. Показывает, какие
 * модели предлагают, и спрашивает подтверждение: молча добавлять провайдера
 * с чужим ключом нельзя.
 */

import { icon } from './icons.js';
import { escapeHtml } from './markdown.js';
import { openModal, toast } from './modals.js';
import { parseInviteFromHash } from './invite.js';
import { addProvider } from './state.js';
import { guessContext, prettyModelName } from './config.js';
import { providerHost, newProviderId } from './providers.js';

/**
 * Проверяет адрес на приглашение.
 *
 * @returns {Promise<boolean>} true, если приглашение было обработано
 */
export async function handleInviteFromUrl() {
  const invite = await parseInviteFromHash(location.hash);
  if (!invite) return false;

  // Данные из ссылки больше не нужны в адресной строке: убираем их сразу,
  // чтобы ключ не остался в истории браузера и не ушёл в закладки.
  clearHash();

  const models = invite.models.map((m) => ({
    ...m,
    context: guessContext(m.id),
  }));

  const modal = openModal({
    title: 'Приглашение к провайдеру',
    subtitle: invite.name || providerHost({ baseUrl: invite.baseUrl }) || 'Новое подключение',
    body: `<div class="invite">
      <div class="invite__head">
        ${icon('link', 18)}
        <div>
          <strong>${escapeHtml(invite.name || 'Провайдер')}</strong>
          <span>${escapeHtml(providerHost({ baseUrl: invite.baseUrl }) || 'адрес скрыт')}</span>
        </div>
      </div>
      <p class="invite__text">Вам передали доступ к моделям. Адрес API и ключ в ссылке зашифрованы и в интерфейсе не показываются.</p>
      <div class="invite__models">
        <div class="invite__models-head"><strong>Доступные модели</strong><span>${models.length}</span></div>
        ${
          models.length
            ? `<ul class="invite__list">${models
                .map(
                  (m) =>
                    `<li><span>${escapeHtml(m.name || prettyModelName(m.id))}</span><span class="tip">${
                      m.context ? Math.round(m.context / 1000) + 'K' : ''
                    }</span></li>`,
                )
                .join('')}</ul>`
            : '<p class="tip" style="margin:0">Список моделей не передан — будут доступны все модели провайдера.</p>'
        }
      </div>
      <div class="invite__note">${icon('info', 15)}<span>${
        models.length
          ? 'Добавленные модели будут выключены: включите нужные в настройках. Отправитель сможет отозвать ключ у себя.'
          : 'После добавления нажмите «Загрузить модели» в настройках подключения.'
      }</span></div>
    </div>`,
    footer: `<button type="button" class="btn" data-invite-cancel>Отмена</button><span class="spacer"></span>
      <button type="button" class="btn btn--primary" data-invite-accept>${icon('check', 15)} Добавить провайдера</button>`,
  });

  modal.root.querySelector('[data-invite-cancel]').addEventListener('click', () => {
    modal.close();
    toast('Приглашение отклонено', 'info');
  });

  modal.root.querySelector('[data-invite-accept]').addEventListener('click', () => {
    const providerId = newProviderId();
    const provider = {
      id: providerId,
      name: invite.name || 'Провайдер',
      preset: 'custom',
      baseUrl: invite.baseUrl,
      apiKey: invite.apiKey,
      extraHeaders: headersToText(invite.headers),
      stream: true,
      enabled: true,
      restricted: models.length > 0,
    };
    addProvider(
      provider,
      models.map((m) => ({
        id: m.id,
        name: m.name || prettyModelName(m.id),
        context: m.context,
        // Присланные модели включаем по одной: получатель сам решит, что
        // показывать в чате. Так список не превращается в свалку.
        enabled: models.length <= 3,
      })),
    );
    modal.close();
    toast(`Провайдер «${provider.name}» добавлен`, 'ok');
    // Даём понять, что дальше делать.
    setTimeout(() => toast('Проверьте список моделей в настройках: лишние можно выключить.', 'info'), 1200);
  });

  return true;
}

/** Заголовки объектом → текст «Имя: значение» (формат настроек). */
function headersToText(headers) {
  return Object.entries(headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

/** Убирает `#i=` из адреса, не добавляя запись в историю. */
function clearHash() {
  const clean = location.pathname + location.search;
  try {
    history.replaceState(null, '', clean);
  } catch {
    location.hash = '';
  }
}
