/**
 * Лента сообщений и композер.
 */

import { icon } from './icons.js';
import { md, escapeHtml } from './markdown.js';
import { state, bus, currentModel, currentEffort, getModel, contextInfo, sessionStats, setModel, setEffort } from './state.js';
import { EFFORTS, SUGGESTIONS } from './config.js';
import { formatRub, formatNumber, formatCompact } from './pricing.js';
import { renderFileCard, renderToolChip, openFileViewer, isPreviewable } from './files.js';
import { openPreview } from './preview.js';
import { copyText, toast, openMenu, closeMenu } from './modals.js';

const el = (id) => document.getElementById(id);

const MOD_LABEL = { text: 'текст', image: 'изображения', audio: 'аудио', file: 'файлы' };

let scrollEl, innerEl, promptEl, composerEl, attachEl, sendBtn;

/* ------------------------------ Инициализация --------------------------- */

export function initChat({ onSend, onStop, onRegenerate }) {
  scrollEl = el('chatScroll');
  innerEl = el('chatInner');
  promptEl = el('prompt');
  composerEl = el('composer');
  attachEl = el('attachments');
  sendBtn = el('btnSend');

  scrollEl.addEventListener('scroll', () => {
    const scrolled = scrollEl.scrollTop > 4;
    el('topbar').classList.toggle('is-scrolled', scrolled);
  });

  promptEl.addEventListener('input', () => {
    autosize();
    refreshSendState();
  });

  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && state.settings.sendOnEnter && !e.isComposing) {
      const isMobile = window.matchMedia('(max-width: 640px)').matches;
      if (!isMobile) {
        e.preventDefault();
        if (!state.busy) onSend();
      }
    }
  });

  composerEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) return onStop();
    onSend();
  });

  sendBtn.addEventListener('click', (e) => {
    if (state.busy) {
      e.preventDefault();
      onStop();
    }
  });

  el('btnAttach').addEventListener('click', () => el('fileInput').click());
  el('fileInput').addEventListener('change', (e) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  promptEl.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imgs = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs);
    }
  });

  ['dragover', 'dragenter'].forEach((ev) =>
    composerEl.addEventListener(ev, (e) => {
      e.preventDefault();
      composerEl.classList.add('is-drag');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    composerEl.addEventListener(ev, (e) => {
      e.preventDefault();
      composerEl.classList.remove('is-drag');
    }),
  );
  composerEl.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  });

  el('btnModel').addEventListener('click', (e) => {
    e.stopPropagation();
    openModelPicker(el('btnModel'));
  });

  el('ctxMeter').addEventListener('click', () => showContextDetails());

  innerEl.addEventListener('click', onBoardClick);

  bus.on('chat:opened', () => renderChat());
  bus.on('chat:created', () => renderChat());
  bus.on('chat:cleared', () => renderChat());
  bus.on('chat:meta', () => {
    renderChat();
    refreshHeader();
  });
  bus.on('messages:updated', () => renderChat());
  bus.on('files:updated', () => {
    refreshHeader();
    if (!state.busy) renderChat();
  });
  bus.on('usage:updated', () => {
    refreshHeader();
    refreshCost();
  });
  bus.on('model:changed', () => {
    refreshModelButton();
    refreshHeader();
    refreshComposerMeta();
  });
  bus.on('settings:changed', () => {
    refreshModelButton();
    refreshComposerMeta();
    refreshHeader();
  });
  bus.on('settings:saved', () => {
    refreshModelButton();
    refreshComposerMeta();
    refreshHeader();
    if (!state.busy) renderChat();
  });
  bus.on('busy:changed', (busy) => {
    sendBtn.classList.toggle('send-btn--stop', busy);
    sendBtn.innerHTML = busy
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`;
    sendBtn.setAttribute('aria-label', busy ? 'Остановить' : 'Отправить');
    sendBtn.disabled = busy ? false : !promptEl.value.trim() && !state.attachments.length;
    promptEl.placeholder = busy ? 'Модель работает… можно остановить кнопкой' : 'Спросите что угодно или попросите создать файл…';
    refreshHeader();
  });

  refreshModelButton();
  refreshHeader();
  refreshComposerMeta();
  refreshCost();
  autosize();
}

/* -------------------------------- Рендер -------------------------------- */

export function renderChat() {
  if (!innerEl) return;
  const chat = state.chat;
  if (!chat || !chat.messages.length) {
    innerEl.innerHTML = '';
    el('chatScroll').innerHTML = emptyState();
    bindEmpty();
    refreshHeader();
    return;
  }

  const scroller = el('chatScroll');
  // Восстанавливаем контейнер, если был пустой экран
  if (!scroller.contains(innerEl)) {
    scroller.innerHTML = '';
    scroller.appendChild(innerEl);
  }

  const atBottom = isNearBottom();

  // Живой ответ уже виден на экране. Когда ход завершается, в ленту встаёт
  // готовое сообщение — анимировать его заново не нужно, иначе картинка
  // «прыгает» ровно в момент окончания стрима.
  const prevLive = innerEl.querySelector('[data-live]');
  const liveWasVisible = !!(
    prevLive && prevLive.querySelector('[data-live-text]:not([hidden])')
  );

  // Сообщения, которые уже были на экране, не должны заново проигрывать
  // анимацию появления: иначе лента «вспыхивает» при каждой полной перерисовке
  // (например, когда ответ дописан). Анимируем только новые.
  const seen = new Set();
  innerEl.querySelectorAll('[data-msg], [data-tool]').forEach((n) => {
    seen.add(n.dataset.msg || n.dataset.tool);
  });

  const frag = chat.messages.map((m) => renderMessage(m)).join('');
  innerEl.innerHTML = frag + (state.live ? renderLive() : '');
  if (seen.size) {
    innerEl.querySelectorAll('[data-msg], [data-tool]').forEach((n) => {
      if (seen.has(n.dataset.msg || n.dataset.tool)) n.classList.add('no-anim');
    });
  }
  if (liveWasVisible && !state.live) {
    // Всё, что появилось после стрима, уже было видно в живом блоке.
    innerEl.querySelectorAll('[data-msg], [data-tool]').forEach((n) => {
      if (!seen.has(n.dataset.msg || n.dataset.tool)) n.classList.add('no-anim');
    });
  }
  const liveNode = innerEl.querySelector('[data-live]');
  if (liveNode) applyLive(liveNode);
  decorate();
  refreshHeader();
  refreshCost();
  if (atBottom) scrollToBottom(false);
}

function emptyState() {
  const model = currentModel();
  const noModel = !model.id;
  return `<div class="empty">
    <h1>Что создаём сегодня?</h1>
    <p>${
      noModel
        ? 'Осталось подключить модель: выберите провайдера в настройках, вставьте ключ и загрузите список моделей. Это займёт минуту.'
        : 'Опишите задачу — модель напишет файл в виртуальном проекте. Код можно открыть, скопировать, скачать или сразу посмотреть в предпросмотре.'
    }</p>
    ${
      noModel
        ? `<div class="empty__setup">
            <button type="button" class="btn btn--primary" data-empty-settings>${icon(
              'link',
              15,
            )} Подключить API</button>
            <span class="tip">Поддерживается любой OpenAI-совместимый API: DeepSeek, OpenRouter, OpenAI, Groq, свой сервер.</span>
          </div>`
        : `<div class="suggestions" id="suggestions">
      ${SUGGESTIONS.map(
        (s) =>
          `<button type="button" class="suggestion" data-prompt="${escapeHtml(s.text)}"><strong>${escapeHtml(
            s.title,
          )}</strong><span>${escapeHtml(s.text)}</span></button>`,
      ).join('')}
    </div>`
    }
    <div class="row" style="margin-top:20px;gap:8px;flex-wrap:wrap">
      <span class="badge">${escapeHtml(model.name)}</span>
      <span class="badge">свой проект у чата</span>
      <span class="badge">предпросмотр HTML</span>
    </div>
  </div>`;
}

function bindEmpty() {
  const setup = document.querySelector('[data-empty-settings]');
  if (setup) {
    setup.addEventListener('click', () => bus.emit('open-settings', 'provider'));
    return;
  }
  const box = document.getElementById('suggestions');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-prompt]');
    if (!btn) return;
    promptEl.value = btn.dataset.prompt;
    autosize();
    refreshSendState();
    promptEl.focus();
    el('composer').dispatchEvent(new Event('submit', { cancelable: true }));
  });
}

function renderMessage(m) {
  if (m.hidden) return '';

  if (m.role === 'user') {
    const imgs =
      m.images && m.images.length
        ? `<div class="msg__images">${m.images
            .map((src, i) => `<img src="${escapeHtml(src.data || src)}" alt="Вложение ${i + 1}" loading="lazy">`)
            .join('')}</div>`
        : '';
    return `<div class="msg msg--user" data-msg="${m.id}">
      <div class="msg__bubble">${imgs}${escapeHtml(m.content || '')}</div>
    </div>`;
  }

  if (m.role === 'tool') {
    // Файловые изменения видны карточками на сообщении ассистента, поэтому
    // отдельная плашка не нужна. Но ошибку показать надо: иначе неудачная
    // правка исчезает из ленты вместе с «в процессе».
    const failed = m.toolResult && m.toolResult.error;
    if (['write_file', 'edit_file', 'delete_file'].includes(m.toolName) && !failed) return '';
    return `<div data-tool="${m.id}">${renderToolChip({ name: m.toolName, args: m.toolArgs }, m.toolResult)}</div>`;
  }

  // assistant
  const model = getModel(m.modelId || state.settings.activeModelId);
  const silentLabel = !m.content && !m.reasoning && m.files && m.files.length ? 'обновил проект' : '';

  // Шаг, в котором модель только вызвала инструмент, ничего не сказав, — это
  // служебная запись для API. Раньше она рисовалась пустым блоком с названием
  // модели, и несколько поисков подряд выглядели как повторяющиеся сообщения.
  if (!m.content && !m.reasoning && !silentLabel && !m.deleted && !m.compacted) return '';
  const reasoning =
    m.reasoning && m.reasoning.trim()
      ? `<details class="reasoning"><summary>${icon('brain', 14)} Размышления ${icon('chevronRight', 13)}</summary><div class="reasoning__text">${escapeHtml(
          m.reasoning,
        )}</div></details>`
      : '';
  const files = (m.files || []).map((f) => renderFileCard(f)).join('');
  const deleted =
    m.deleted && !(m.files || []).some((f) => f.path === m.deleted)
      ? renderFileCard({ path: m.deleted, content: '', status: 'deleted' })
      : '';
  const visibleContent = m.compacted ? '' : m.content ? `<div class="msg__content md">${md(m.content)}</div>` : '';
  const compact = m.compacted
    ? `<div class="compact-card"><button type="button" class="compact-card__head" data-compact-toggle>
        ${icon('compress', 15)}<span class="grow">История сжата<span>Нажмите, чтобы посмотреть сводку</span></span>${icon(
          'chevronDown',
          14,
        )}
      </button><div class="compact-card__body" hidden>${md(m.content.replace(/^Сводка предыдущей части разговора:\s*/i, ''))}</div></div>`
    : '';

  return `<div class="msg" data-msg="${m.id}">
    <div class="msg__body">
      <div class="msg__head"><span>${escapeHtml(model.name)}</span>${
        m.usage && m.usage.cost ? `<span class="dot"></span><span>${formatRub(m.usage.cost)}</span>` : ''
      }${silentLabel ? `<span class="dot"></span><span>${silentLabel}</span>` : ''}</div>
      ${reasoning}
      ${compact}
      ${visibleContent}
      ${files}
      ${deleted}
      <div class="msg__actions">
        <button type="button" class="icon-btn icon-btn--sm" data-copy="${m.id}" title="Скопировать ответ">${icon(
          'copy',
          15,
        )}</button>
        ${
          m.content
            ? `<button type="button" class="icon-btn icon-btn--sm" data-regen="${m.id}" title="Повторить запрос">${icon(
                'refresh',
                15,
              )}</button>`
            : ''
        }
      </div>
    </div>
  </div>`;
}

/**
 * Каркас «живого» сообщения. Содержимое наполняется через applyLive():
 * так при каждом куске текста мы не пересоздаём весь блок (иначе мигает
 * анимация появления и дёргается вёрстка).
 */
function renderLive() {
  const model = currentModel();
  return `<div class="msg msg--live" data-live="1">
    <div class="msg__body">
      <div class="msg__head"><span>${escapeHtml(model.name)}</span><span class="dot"></span><span data-live-phase>работает</span></div>
      <details class="reasoning" data-live-reasoning hidden open>
        <summary>${icon('brain', 14)} Размышляю… ${icon('chevronRight', 13)}</summary>
        <div class="reasoning__text" data-live-reasoning-text></div>
      </details>
      <div class="typing" data-live-typing><i></i><i></i><i></i></div>
      <div class="msg__note" data-live-status hidden></div>
      <div data-live-tools></div>
      <div class="msg__content md" data-live-text hidden></div>
    </div>
  </div>`;
}

/**
 * Точечно обновляет живой блок: трогает только те части, что изменились.
 * Повторный рендер markdown делается лишь при новом тексте.
 */
function applyLive(node) {
  const l = state.live;
  if (!node || !l) return;

  const textEl = node.querySelector('[data-live-text]');
  const reasoningEl = node.querySelector('[data-live-reasoning]');
  const typingEl = node.querySelector('[data-live-typing]');
  const statusEl = node.querySelector('[data-live-status]');
  const toolsEl = node.querySelector('[data-live-tools]');

  const reasoning = (l.reasoning || '').trim();
  if (node.__reasoning !== reasoning) {
    node.__reasoning = reasoning;
    if (reasoningEl) {
      reasoningEl.hidden = !reasoning;
      const body = reasoningEl.querySelector('[data-live-reasoning-text]');
      if (body) body.textContent = reasoning;
    }
  }

  const text = l.text || '';
  if (node.__text !== text) {
    node.__text = text;
    if (textEl) {
      if (!text) {
        textEl.hidden = true;
        textEl.innerHTML = '';
      } else {
        textEl.hidden = false;
        textEl.innerHTML = md(text);
        decorate();
      }
    }
  }

  if (typingEl) typingEl.hidden = !!(text || reasoning);

  const status = l.status || '';
  if (node.__status !== status) {
    node.__status = status;
    if (statusEl) {
      statusEl.hidden = !status;
      statusEl.innerHTML = status ? `${icon('info', 14)}<span>${escapeHtml(status)}</span>` : '';
    }
  }

  const tools = l.tools || [];
  // Сравниваем не количество, а содержимое: карточка инструмента меняется
  // с «выполняется» на результат при той же длине массива.
  const toolsHtml = tools.map((t) => (t.card ? t.card : '')).join('');
  if (node.__toolsHtml !== toolsHtml) {
    node.__toolsHtml = toolsHtml;
    if (toolsEl) toolsEl.innerHTML = toolsHtml;
  }
}

/** Пост-обработка: кнопки копирования, предпросмотр, сводка. */
function decorate() {
  innerEl.querySelectorAll('[data-copy-code]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const block = btn.closest('.code-block');
      const code = block.querySelector('pre code');
      if (code && (await copyText(code.textContent))) toast('Код скопирован', 'ok');
    });
  });
}

function onBoardClick(e) {
  const t = e.target;

  const copyBtn = t.closest('[data-copy]');
  if (copyBtn) {
    const m = state.chat?.messages.find((x) => x.id === copyBtn.dataset.copy);
    if (m) copyText(m.content).then((ok) => ok && toast('Ответ скопирован', 'ok'));
    return;
  }

  const regen = t.closest('[data-regen]');
  if (regen) {
    bus.emit('regenerate', regen.dataset.regen);
    return;
  }

  const compact = t.closest('[data-compact-toggle]');
  if (compact) {
    const body = compact.nextElementSibling;
    body.hidden = !body.hidden;
    return;
  }

  const filePath = t.closest('[data-file-path]');
  if (filePath) {
    openFileViewer(filePath.dataset.filePath);
    return;
  }

  const copyFile = t.closest('[data-copy-file]');
  if (copyFile) {
    const path = copyFile.dataset.copyFile;
    import('./state.js').then(({ store }) => {
      store.getFile(state.chat.id, path).then(async (rec) => {
        if (rec && (await copyText(rec.content))) toast('Код файла скопирован', 'ok');
      });
    });
    return;
  }

  const dl = t.closest('[data-download]');
  if (dl) {
    const path = dl.dataset.download;
    import('./state.js').then(({ store }) => {
      store.getFile(state.chat.id, path).then((rec) => {
        if (!rec) return toast('Файл не найден', 'error');
        import('./modals.js').then(({ download }) => download(path.split('/').pop(), rec.content));
      });
    });
    return;
  }

  const prev = t.closest('[data-preview-path]');
  if (prev) {
    openPreview(prev.dataset.previewPath);
    return;
  }

  const sug = t.closest('[data-prompt]');
  if (sug) {
    promptEl.value = sug.dataset.prompt;
    autosize();
    refreshSendState();
    promptEl.focus();
  }
}

/* ------------------------------ Композер -------------------------------- */

function autosize() {
  if (!promptEl) return;
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, window.innerHeight * 0.4) + 'px';
}

export function refreshSendState() {
  if (!sendBtn || state.busy) return;
  sendBtn.disabled = !promptEl.value.trim() && !state.attachments.length;
}

export function clearComposer() {
  promptEl.value = '';
  state.attachments = [];
  renderAttachments();
  autosize();
  refreshSendState();
}

export function focusComposer() {
  autosize();
  if (window.matchMedia('(min-width: 900px)').matches) promptEl.focus();
}

function addFiles(files) {
  const room = 4 - state.attachments.length;
  for (const f of files.slice(0, Math.max(0, room))) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 6 * 1024 * 1024) {
      toast(`Файл больше 6 МБ: ${f.name}`, 'error');
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.attachments.push({ data: String(reader.result), name: f.name, type: f.type });
      renderAttachments();
      refreshSendState();
    };
    reader.readAsDataURL(f);
  }
  if (files.length > room) toast('Можно приложить не больше 4 изображений');
}

function renderAttachments() {
  if (!attachEl) return;
  if (!state.attachments.length) {
    attachEl.hidden = true;
    attachEl.innerHTML = '';
    return;
  }
  attachEl.hidden = false;
  attachEl.innerHTML = state.attachments
    .map(
      (a, i) =>
        `<div class="attachment"><img src="${escapeHtml(a.data)}" alt="${escapeHtml(a.name)}"><button type="button" data-rm="${
          i
        }" aria-label="Убрать вложение">${icon('close', 11)}</button></div>`,
    )
    .join('');
  attachEl.querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      state.attachments.splice(Number(b.dataset.rm), 1);
      renderAttachments();
      refreshSendState();
    }),
  );
}

/* ------------------------------- Шапка ---------------------------------- */

export function refreshHeader() {
  const chat = state.chat;
  const model = currentModel();
  const title = el('topTitle');
  if (title) {
    title.querySelector('strong').textContent = chat ? chat.title : 'Новый чат';
    const filesCount = state.files.length;
    const searchOff =
      (chat && chat.searchOff) || !state.settings.search || state.settings.search.mode === 'off';
    title.querySelector('span').textContent = `${model.name}${
      filesCount ? ` · ${filesCount} ${filesCount === 1 ? 'файл' : filesCount < 5 ? 'файла' : 'файлов'}` : ''
    }${searchOff ? ' · без поиска' : ''}`;
  }

  const ctx = contextInfo();
  const label = el('ctxLabel');
  const fill = el('ctxFill');
  const meter = el('ctxMeter');
  if (label) label.textContent = `${ctx.percent} %`;
  if (fill) fill.style.width = `${ctx.percent}%`;
  if (meter) {
    meter.classList.toggle('is-warn', ctx.percent >= 75);
    meter.title = `Контекст: ${formatNumber(ctx.used)} из ${formatNumber(ctx.limit)} токенов`;
  }
  refreshModelButton();
}

function refreshCost() {
  const s = sessionStats();
  const costEl = el('costValue');
  const tokEl = el('tokenValue');
  if (costEl) costEl.textContent = formatRub(s.cost);
  if (tokEl) tokEl.textContent = `${formatCompact(s.in)} / ${formatCompact(s.out)} токенов`;
  const pill = el('costPill');
  if (pill) {
    pill.title = `Вход: ${formatNumber(s.in)} · Выход: ${formatNumber(s.out)}${
      s.estimated ? ' · часть значений оценена' : ''
    }`;
  }
}

function refreshComposerMeta() {
  const model = currentModel();
  const meta = el('composerMeta');
  if (!meta) return;
  const hint = el('composerHint');
  if (hint) {
    hint.innerHTML = window.matchMedia('(max-width: 640px)').matches
      ? ''
      : `Enter — отправить · Shift+Enter — новая строка`;
  }
  refreshCost();
  refreshSendState();
  const cost = el('costPill');
  if (cost && model.priceIn === 0 && model.priceOut === 0) {
    cost.querySelector('b').textContent = '0 ₽';
  }
}

function refreshModelButton() {
  const model = currentModel();
  const nameEl = el('modelName');
  if (nameEl) nameEl.textContent = model.name;
  const dot = el('modelDot');
  if (dot) dot.style.background = model.id ? 'var(--accent)' : 'var(--muted)';
}

export function showContextDetails() {
  const ctx = contextInfo();
  const model = ctx.model;
  const rows = [
    ['Модель', model.name],
    ['Лимит модели', `${formatNumber(model.context)} токенов`],
    ['Пользовательский лимит', state.settings.contextCap ? `${formatNumber(state.settings.contextCap)} токенов` : 'не задан'],
    ['Доступно для диалога', `${formatNumber(ctx.limit)} токенов`],
    ['Занято сейчас', `${formatNumber(ctx.used)} токенов (${ctx.percent} %)`],
    ['Порог сжатия', `${Math.round((state.settings.compactThreshold || 0.8) * 100)} %`],
    ['Потрачено в сессии', `${formatNumber(sessionStats().in)} вход · ${formatNumber(sessionStats().out)} выход`],
    ['Стоимость сессии', formatRub(sessionStats().cost)],
  ];
  import('./modals.js').then(({ openModal, toast: t }) => {
    const modal = openModal({
      title: 'Контекст и расход',
      subtitle: 'Чем ближе к лимиту, тем чаще история сжимается',
      body: `<div style="display:flex;flex-direction:column;gap:0">
        ${rows
          .map(
            ([k, v]) =>
              `<div class="toggle-row" style="padding:9px 0"><span class="toggle-row__text"><strong style="font-weight:550">${escapeHtml(
                k,
              )}</strong></span><span class="mono" style="color:var(--text-2);font-size:12.5px">${escapeHtml(v)}</span></div>`,
          )
          .join('')}
      </div>`,
      footer: `<button type="button" class="btn" data-close>Закрыть</button><span class="spacer"></span>
        <button type="button" class="btn btn--primary" data-compact>${icon('compress', 15)} Сжать сейчас</button>`,
    });
    modal.root.querySelector('[data-compact]').addEventListener('click', async () => {
      modal.close();
      bus.emit('compact-request');
    });
  });
}

/* --------------------------- Выбор модели ------------------------------ */

function openModelPicker(anchor) {
  closeMenu();
  const model = currentModel();
  const models = state.settings.models || [];
  const effort = currentEffort();

  const pop = document.createElement('div');
  pop.className = 'popover popover--model';
  pop.innerHTML = `
    <div class="popover-head"><strong>Модель</strong><button class="btn btn--sm btn--ghost" data-open-settings>${icon(
      'settings',
      13,
    )} Настроить</button></div>
    <div class="model-list">
      ${
        models.length
          ? models
              .map((m) => {
                const specs = [
                  `<span class="model-spec" title="Контекстное окно">${formatCompact(m.context)} контекст</span>`,
                  `<span class="model-spec" title="Поддерживаемый вход">вход: ${(m.input || ['text'])
                    .map((x) => MOD_LABEL[x] || x)
                    .join(', ')}</span>`,
                  `<span class="model-spec" title="Поддерживаемый выход">выход: ${(m.output || ['text'])
                    .map((x) => MOD_LABEL[x] || x)
                    .join(', ')}</span>`,
                  `<span class="model-spec" title="Инструменты">${
                    m.tools === false ? 'без инструментов' : 'инструменты'
                  }</span>`,
                ].join('');
                return `<button type="button" class="model-opt${m.id === model.id ? ' is-active' : ''}" data-model="${escapeHtml(
                  m.id,
                )}">
            <span class="model-opt__check">${m.id === model.id ? icon('check', 15) : ''}</span>
            <span class="model-opt__body">
              <span class="model-opt__title">${escapeHtml(m.name)}${
                  m.tools === false ? '<span class="badge">без инструментов</span>' : ''
                }</span>
              ${m.note ? `<span class="model-opt__note">${escapeHtml(m.note)}</span>` : ''}
              <span class="model-specs">${specs}</span>
            </span>
          </button>`;
              })
              .join('')
          : `<div class="model-list__empty">
              <strong>Моделей пока нет</strong>
              <span>Подключите провайдера и загрузите список моделей — они появятся здесь.</span>
              <button type="button" class="btn btn--sm btn--primary" data-open-settings>${icon(
                'plus',
                14,
              )} Добавить модель</button>
            </div>`
      }
    </div>
    <div class="popover-head" style="border-top:1px solid var(--border);border-bottom:0;padding:9px 12px 4px"><strong>Усилия</strong><span class="tip" data-effort-hint></span></div>
    <div class="effort-row">
      ${EFFORTS.map(
        (e) =>
          `<button type="button" class="effort-opt${e.id === effort ? ' is-active' : ''}" data-effort="${e.id}" title="${escapeHtml(
            e.hint,
          )}">
            <span class="effort-bars"><i></i><i></i><i></i></span>${escapeHtml(e.label.split(' ')[0])}
          </button>`,
      ).join('')}
    </div>`;

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  let left = Math.min(r.left, window.innerWidth - w - 10);
  left = Math.max(8, left);
  let top = r.bottom + 8;
  const h = pop.offsetHeight;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  pop.style.position = 'fixed';
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const hint = pop.querySelector('[data-effort-hint]');
  const setHint = () => {
    const cur = EFFORTS.find((e) => e.id === currentEffort());
    hint.textContent = cur ? cur.hint : '';
  };
  setHint();

  pop.addEventListener('click', (e) => {
    const m = e.target.closest('[data-model]');
    if (m) {
      setModel(m.dataset.model);
      pop.remove();
      toast(`Модель: ${getModel(m.dataset.model).name}`);
      return;
    }
    const ef = e.target.closest('[data-effort]');
    if (ef) {
      setEffort(ef.dataset.effort);
      pop.querySelectorAll('.effort-opt').forEach((b) => b.classList.toggle('is-active', b === ef));
      setHint();
      return;
    }
    if (e.target.closest('[data-open-settings]')) {
      pop.remove();
      bus.emit('open-settings', 'models');
    }
  });

  const dismiss = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) {
      pop.remove();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', onEsc, true);
    }
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') {
      pop.remove();
      document.removeEventListener('click', dismiss, true);
      document.removeEventListener('keydown', onEsc, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', onEsc, true);
  }, 0);
}

/* ------------------------------- Скролл --------------------------------- */

export function isNearBottom(threshold = 120) {
  if (!scrollEl) return true;
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < threshold;
}

export function scrollToBottom(smooth = true) {
  if (!scrollEl) return;
  requestAnimationFrame(() => {
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

let liveFrame = 0;

/**
 * Обновление «живого» сообщения во время стрима.
 *
 * Раньше весь блок заменялся новым элементом на каждый кусок текста: срабатывала
 * анимация появления и экран мигал. Теперь узел живёт до конца ответа, а меняется
 * только содержимое. Вызовы схлопываются в один кадр — при быстром потоке это
 * ещё и заметно дешевле.
 */
export function patchLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const live = innerEl.querySelector('[data-live]');
    const stick = isNearBottom();
    if (!live) {
      renderChat();
      if (stick) scrollToBottom(false);
      return;
    }
    applyLive(live);
    if (stick) scrollToBottom(false);
    refreshCost();
  });
}

export { promptEl, autosize };
