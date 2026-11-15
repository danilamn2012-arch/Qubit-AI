/**
 * Сайдбар: список чатов, группы, поиск, закрепление, drawer.
 */

import { icon } from './icons.js';
import { state, bus, refreshChats, openChat, newChat, deleteChat, persistSettings, getModel } from './state.js';
import { openMenu, confirmDialog, toast } from './modals.js';
import { openSettings } from './settings.js';
import { formatRub } from './pricing.js';
import * as store from './storage.js';

const el = (id) => document.getElementById(id);

let searchQuery = '';

export function initShell() {
  el('btnMenu').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 900px)').matches) toggleDrawer();
    else toggleSidebarCollapse();
  });
  el('btnSidebarClose').addEventListener('click', () => toggleDrawer(false));
  el('scrim').addEventListener('click', () => toggleDrawer(false));

  el('btnNewChat').addEventListener('click', () => {
    newChat();
    toggleDrawer(false);
    bus.emit('focus-composer');
  });
  el('btnNewChatTop').addEventListener('click', () => {
    newChat();
    bus.emit('focus-composer');
  });

  el('btnSettings').addEventListener('click', () => {
    toggleDrawer(false);
    openSettings();
  });

  el('btnFiles').addEventListener('click', () => bus.emit('open-files'));
  el('btnChatMenu').addEventListener('click', () => openChatMenu());

  const search = el('chatSearch');
  let t = null;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      searchQuery = search.value.trim().toLowerCase();
      renderChatList();
    }, 120);
  });

  el('chatList').addEventListener('click', onListClick);

  bus.on('chats:updated', renderChatList);
  bus.on('chat:opened', () => {
    renderChatList();
    toggleDrawer(false);
  });
  bus.on('chat:cleared', renderChatList);

  renderChatList();
  bindKeys();

  if (state.settings.sidebarCollapsed) el('app').classList.add('sidebar-collapsed');
}

function refreshThemeLabel() {}

/* ------------------------------ Drawer --------------------------------- */

export function toggleDrawer(open) {
  const app = el('app');
  if (!window.matchMedia('(max-width: 900px)').matches) return;
  const isOpen = app.classList.contains('drawer-open');
  const next = open === undefined ? !isOpen : open;
  app.classList.toggle('drawer-open', next);
  document.body.style.overflow = next ? 'hidden' : '';
  if (next) {
    const sb = el('sidebar');
    const focusable = sb.querySelector('button, input');
    focusable && setTimeout(() => focusable.focus(), 60);
  }
}

/** Сворачивание сайдбара на десктопе (на мобильном открывает drawer). */
export function toggleSidebarCollapse() {
  const app = el('app');
  const collapsed = app.classList.toggle('sidebar-collapsed');
  persistSettings({ sidebarCollapsed: collapsed });
}

export function drawerOpen() {
  return el('app').classList.contains('drawer-open');
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen()) toggleDrawer(false);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      toggleDrawer(true);
      setTimeout(() => el('chatSearch').focus(), 80);
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      newChat();
      bus.emit('focus-composer');
    }
  });
}

/* ----------------------------- Список чатов ----------------------------- */

function groupOf(chat) {
  const now = Date.now();
  const diff = now - chat.updatedAt;
  const day = 86400000;
  if (chat.pinned) return 'Закреплённые';
  if (diff < day) return 'Сегодня';
  if (diff < day * 2) return 'Вчера';
  if (diff < day * 7) return 'На этой неделе';
  if (diff < day * 30) return 'В этом месяце';
  return 'Раньше';
}

const GROUP_ORDER = ['Закреплённые', 'Сегодня', 'Вчера', 'На этой неделе', 'В этом месяце', 'Раньше'];

export function renderChatList() {
  const list = el('chatList');
  if (!list) return;
  const chats = state.chats.filter((c) => {
    if (!searchQuery) return true;
    return (c.title + ' ' + (c.preview || '')).toLowerCase().includes(searchQuery);
  });

  if (!chats.length) {
    list.innerHTML = `<div style="padding:24px 10px;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.6">
      ${searchQuery ? 'Ничего не найдено' : 'Пока нет чатов.<br>Создайте первый — он появится здесь.'}
    </div>`;
    return;
  }

  const groups = new Map();
  chats.forEach((c) => {
    const g = groupOf(c);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  });

  let html = '';
  GROUP_ORDER.forEach((name) => {
    const items = groups.get(name);
    if (!items || !items.length) return;
    html += `<div class="chat-group"><div class="chat-group__label">${name}</div>`;
    html += items
      .map((c) => {
        const active = state.chat && state.chat.id === c.id;
        return `<div class="chat-item${active ? ' is-active' : ''}${c.pinned ? ' is-pinned' : ''}" role="listitem" data-chat="${
          c.id
        }" tabindex="0">
          ${c.pinned ? `<span class="chat-item__pin">${icon('pin', 12)}</span>` : ''}
          <span class="chat-item__title" title="${escapeAttr(c.title)}">${escapeHtml(c.title)}</span>
          <span class="chat-item__actions">
            <button type="button" class="icon-btn icon-btn--sm" data-pin="${c.id}" aria-label="${
              c.pinned ? 'Открепить' : 'Закрепить'
            }" title="${c.pinned ? 'Открепить' : 'Закрепить'}">${icon('pin', 13)}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-more="${c.id}" aria-label="Ещё" title="Ещё">${icon(
              'more',
              13,
            )}</button>
          </span>
        </div>`;
      })
      .join('');
    html += '</div>';
  });
  list.innerHTML = html;
}

function onListClick(e) {
  const pin = e.target.closest('[data-pin]');
  if (pin) {
    e.stopPropagation();
    togglePin(pin.dataset.pin);
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    const chat = state.chats.find((c) => c.id === more.dataset.more);
    openMenu(more, [
      { label: chat && chat.pinned ? 'Открепить' : 'Закрепить', icon: 'pin', onClick: () => togglePin(more.dataset.more) },
      {
        label: 'Переименовать',
        icon: 'edit',
        onClick: () => renameChat(more.dataset.more),
      },
      { sep: true },
      {
        label: 'Удалить чат',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const chat = state.chats.find((c) => c.id === more.dataset.more);
          const ok = await confirmDialog({
            title: 'Удалить чат?',
            message: `«${chat ? chat.title : 'Чат'}» и все его файлы будут удалены без возможности восстановления.`,
          });
          if (ok) {
            await deleteChat(more.dataset.more);
            toast('Чат удалён', 'ok');
          }
        },
      },
    ]);
    return;
  }
  const item = e.target.closest('[data-chat]');
  if (item) {
    openChat(item.dataset.chat).then((ok) => {
      if (ok) toggleDrawer(false);
    });
  }
}

async function togglePin(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  const { store } = await import('./state.js');
  const full = await store.getChat(id);
  if (!full) return;
  full.pinned = !full.pinned;
  await store.saveChat(full);
  if (state.chat && state.chat.id === id) state.chat.pinned = full.pinned;
  await refreshChats();
}

async function renameChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  const { openModal } = await import('./modals.js');
  const modal = openModal({
    title: 'Переименовать чат',
    body: `<div class="field"><label for="renameInput">Название</label><input class="input" id="renameInput" data-autofocus maxlength="80" value="${escapeAttr(
      chat.title,
    )}"></div>`,
    footer: `<button class="btn" data-close>Отмена</button><span class="spacer"></span><button class="btn btn--primary" data-save>Сохранить</button>`,
  });
  const input = modal.root.querySelector('#renameInput');
  const save = async () => {
    const title = input.value.trim() || 'Без названия';
    const { store } = await import('./state.js');
    const full = await store.getChat(id);
    full.title = title;
    await store.saveChat(full);
    if (state.chat && state.chat.id === id) state.chat.title = title;
    await refreshChats();
    bus.emit('chats:updated');
    modal.close();
  };
  modal.root.querySelector('[data-save]').addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
}

/* ---------------------------- Меню чата -------------------------------- */

/**
 * Поиск выключен для чата флагом chat.searchOff: настройки общие, а этот
 * переключатель действует только на текущий разговор и сохраняется в нём.
 */
async function toggleChatSearch() {
  const chat = state.chat;
  if (!chat) {
    openSettings('search');
    return;
  }
  chat.searchOff = !chat.searchOff;
  await store.saveChat(chat);
  bus.emit('chat:meta');
  toast(chat.searchOff ? 'Поиск выключен для этого чата' : 'Поиск включён для этого чата', 'ok');
}

function openChatMenu() {
  const anchor = el('btnChatMenu');
  const chat = state.chat;
  const items = [
    {
      label: 'Переименовать',
      icon: 'edit',
      onClick: () => chat && renameChat(chat.id),
    },
    {
      label: 'Закрепить в истории',
      icon: 'pin',
      onClick: () => chat && togglePin(chat.id),
    },
    {
      label: 'Экспорт чата (Markdown)',
      icon: 'download',
      onClick: () => exportChatMarkdown(),
    },
    { sep: true },
    {
      label: !chat ? 'Поиск: как в настройках' : chat.searchOff ? 'Включить поиск в этом чате' : 'Выключить поиск в этом чате',
      icon: 'globe',
      onClick: () => toggleChatSearch(),
    },
    {
      label: 'Сжать контекст сейчас',
      icon: 'compress',
      onClick: () => bus.emit('compact-request'),
    },
    {
      label: 'Файлы проекта',
      icon: 'folder',
      onClick: () => bus.emit('open-files'),
    },
    {
      label: 'Настройки',
      icon: 'settings',
      onClick: () => openSettings(),
    },
    { sep: true },
    {
      label: 'Удалить чат',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        if (!chat) return;
        const ok = await confirmDialog({
          title: 'Удалить чат?',
          message: `«${chat.title}» и все файлы проекта будут удалены.`,
        });
        if (ok) {
          await deleteChat(chat.id);
          toast('Чат удалён', 'ok');
        }
      },
    },
  ];
  openMenu(anchor, items, { align: 'right' });
}

async function exportChatMarkdown() {
  if (!state.chat) return;
  const { download } = await import('./modals.js');
  const model = getModel(state.chat.modelId || state.settings.activeModelId);
  const lines = [
    `# ${state.chat.title}`,
    '',
    `Модель: ${model.name} · ${new Date(state.chat.createdAt).toLocaleString('ru-RU')}`,
    '',
    '---',
    '',
  ];
  for (const m of state.chat.messages) {
    if (m.role === 'user') lines.push(`## Пользователь`, '', m.content || '', '');
    else if (m.role === 'assistant') {
      // Шаг, где модель только вызвала инструмент, ничего не сказав, — это
      // служебная запись. В экспорте от неё оставался пустой заголовок модели,
      // из-за чего лента выглядела как повторяющиеся сообщения.
      const hasText = (m.content || '').trim();
      if (hasText) lines.push(`## ${model.name}`, '', m.content, '');
      const files = m.files || [];
      if (files.length) {
        const paths = files.map((f) => `\`${f.path}\``).join(', ');
        lines.push(hasText ? `Файл: ${paths}` : `## ${model.name}`, '', hasText ? '' : `Файл: ${paths}`, '');
      }
    } else if (m.role === 'tool') {
      // Ошибки инструментов полезны в экспорте, успешные вызовы дублируют
      // карточки файлов выше.
      if (m.toolResult && m.toolResult.error) {
        lines.push(`> Инструмент \`${m.toolName}\`: ${String(m.toolResult.error).slice(0, 200)}`, '');
      }
    }
  }
  const stats = state.chat.stats || {};
  lines.push('---', '', `Расход: ${formatRub(stats.cost)} · ${stats.in || 0} вход / ${stats.out || 0} выход токенов`);
  download(`${slug(state.chat.title)}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
}

function slug(s) {
  return (
    String(s || 'chat')
      .toLowerCase()
      .replace(/[^a-zа-я0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'chat'
  );
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeAttr(s) {
  return escapeHtml(s);
}
