/**
 * Модалка настроек: провайдер, модели, контекст, поиск, оформление, данные.
 */

import { icon } from './icons.js';
import { escapeHtml } from './markdown.js';
import { openModal, confirmDialog, toast, download } from './modals.js';
import { state, bus, persistSettings, applyTheme, applyScale } from './state.js';
import * as store from './storage.js';
import { testConnection, parseExtraHeaders } from './api.js';
import { formatNumber } from './pricing.js';
import { MODALITIES, PROVIDERS, guessContext, prettyModelName, effortsOf, DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS } from './config.js';

const TABS = [
  { id: 'provider', label: 'Подключение', icon: 'link' },
  { id: 'models', label: 'Модели', icon: 'cpu' },
  { id: 'context', label: 'Контекст', icon: 'compress' },
  { id: 'search', label: 'Веб-поиск', icon: 'globe' },
  { id: 'look', label: 'Оформление', icon: 'sun' },
  { id: 'data', label: 'Данные', icon: 'folder' },
];

const html = (s) => String(s ?? '');
const escapeAttr = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getModel = (id, settings) =>
  (settings.models || []).find((m) => m.id === id) || (settings.models || [])[0] || {
    id: '',
    name: 'Модель не выбрана',
    context: 128000,
    priceIn: 0,
    priceOut: 0,
  };

export function openSettings(initialTab = 'provider') {
  let tab = initialTab;
  const draft = structuredClone(state.settings);

  const modal = openModal({
    title: 'Настройки',
    subtitle: 'Всё хранится только в этом браузере',
    wide: true,
    className: 'modal--settings',
    body: `<div class="settings">
      <nav class="settings__nav" id="setNav" role="tablist"></nav>
      <section class="settings__pane" id="setPane"></section>
    </div>`,
    footer: `<span class="tip" id="saveHint"></span><span class="spacer"></span>
      <button type="button" class="btn" data-close>Закрыть</button>
      <button type="button" class="btn btn--primary" data-save>${icon('check', 15)} Сохранить</button>`,
  });

  const nav = modal.root.querySelector('#setNav');
  const pane = modal.root.querySelector('#setPane');

  const renderNav = () => {
    nav.innerHTML = TABS.map(
      (t) =>
        `<button type="button" role="tab" aria-selected="${t.id === tab}" class="${
          t.id === tab ? 'is-active' : ''
        }" data-tab="${t.id}">${icon(t.icon, 15)} ${t.label}</button>`,
    ).join('');
  };

  const render = () => {
    renderNav();
    pane.innerHTML = renderPane(tab, draft);
    bindPane(tab);
    applyDraftPreview();
  };

  const bindPane = (id) => {
    // Универсальные привязки к draft
    pane.querySelectorAll('[data-bind]').forEach((input) => {
      const path = input.dataset.bind.split('.');
      const isCheck = input.type === 'checkbox';
      const value = isCheck ? input.checked : input.value;
      setPath(draft, path, isCheck ? value : input.type === 'number' ? Number(value) : value);
      input.addEventListener(isCheck || input.tagName === 'SELECT' ? 'change' : 'input', () => {
        const v = isCheck ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
        setPath(draft, path, v);
        hintDirty();
        if (id === 'look') applyDraftPreview();
      });
    });

    if (id === 'provider') bindProvider();
    if (id === 'models') bindModels();
    if (id === 'context') bindContext();
    if (id === 'search') bindSearch();
    if (id === 'look') bindLook();
    if (id === 'data') bindData();
  };

  const hintDirty = () => {
    const hint = modal.root.querySelector('#saveHint');
    if (hint) hint.textContent = 'Есть несохранённые изменения';
  };

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    tab = btn.dataset.tab;
    render();
  });

  modal.root.querySelector('[data-save]').addEventListener('click', () => {
    // Отбрасываем пустые строки моделей, иначе в списке останется «Новая модель»
    draft.models = (draft.models || []).filter((m) => String(m.id || '').trim());
    if (!draft.models.some((m) => m.id === draft.activeModelId)) {
      draft.activeModelId = draft.models[0]?.id || '';
    }
    persistSettings(draft);
    applyTheme(draft.theme);
    applyScale(draft.fontScale);
    state.settings = draft;
    modal.close();
    bus.emit('settings:saved');
    toast('Настройки сохранены', 'ok');
    if (!state.settings.models.length) {
      setTimeout(() => toast('Моделей нет — добавьте хотя бы одну, чтобы начать чат.', 'info'), 900);
    }
  });

  /* ------------------------------ Подключение --------------------------- */

  function bindProvider() {
    const testBtn = pane.querySelector('[data-test]');
    const status = pane.querySelector('[data-test-status]');
    const baseUrlInput = pane.querySelector('#baseUrlInput');
    const keyInput = pane.querySelector('#apiKeyInput');
    const headersInput = pane.querySelector('#headersInput');

    // Пресет провайдера подставляет URL, заголовки и рекомендованные модели
    pane.querySelectorAll('[data-provider-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = PROVIDERS.find((x) => x.id === btn.dataset.providerPreset);
        if (!p) return;
        if (draft.provider.preset !== p.id && draft.provider.apiKey) {
          // Ключ одного провайдера нельзя отправлять другому
          keyInput.value = '';
          draft.provider.apiKey = '';
        }
        draft.provider.preset = p.id;
        draft.provider.baseUrl = p.baseUrl || '';
        baseUrlInput.value = p.baseUrl || '';
        draft.provider.extraHeaders = p.extraHeaders || '';
        headersInput.value = p.extraHeaders || '';
        pane.querySelectorAll('[data-provider-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
        hintDirty();
      });
    });

    // Ручная правка URL — пресет больше не соответствует адресу
    baseUrlInput.addEventListener('input', () => {
      const v = baseUrlInput.value.trim().replace(/\/+$/, '');
      const match = PROVIDERS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === v);
      const next = match ? match.id : 'custom';
      if (draft.provider.preset === next) return;
      draft.provider.preset = next;
      pane
        .querySelectorAll('[data-provider-preset]')
        .forEach((b) => b.classList.toggle('is-active', b.dataset.providerPreset === next));
    });

    testBtn.addEventListener('click', async () => {
      const baseUrl = baseUrlInput.value.trim();
      if (!baseUrl) {
        status.textContent = 'Сначала укажите URL API';
        status.style.color = 'var(--danger)';
        return;
      }
      testBtn.disabled = true;
      status.textContent = 'Проверяю…';
      status.style.color = 'var(--muted)';
      try {
        const list = await testConnection({
          baseUrl,
          apiKey: keyInput.value,
          extraHeaders: parseExtraHeaders(headersInput.value),
        });
        if (!list.length) {
          status.textContent = 'Соединение есть, но список моделей пуст';
          status.style.color = 'var(--warning, var(--accent-ink))';
          return;
        }

        const res = importModels(list);
        const withEfforts = list.filter((m) => m.efforts && m.efforts.length).length;
        const parts = [`Доступно моделей: ${list.length}`];
        if (res.added) parts.push(`добавлено: ${res.added}`);
        if (res.updated) parts.push(`обновлено: ${res.updated}`);
        if (!res.added && !res.updated) parts.push('новых нет');
        if (withEfforts) parts.push(`с уровнями усилий: ${withEfforts}`);
        status.textContent = `Успешно. ${parts.join(', ')}`;
        status.style.color = 'var(--success)';

        const datalist = pane.querySelector('#modelsDatalist');
        if (datalist) {
          datalist.innerHTML = list
            .slice(0, 300)
            .map((m) => `<option value="${escapeAttr(m.id)}"></option>`)
            .join('');
        }
        toast(
          res.added || res.updated
            ? `Модели обновлены: добавлено ${res.added}, обновлено ${res.updated}`
            : 'Список моделей уже актуален',
          'ok',
        );
      } catch (err) {
        status.textContent = err.message || 'Ошибка подключения';
        status.style.color = 'var(--danger)';
      } finally {
        testBtn.disabled = false;
      }
    });

    pane.querySelector('[data-toggle-key]').addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });
  }

  /**
   * Добавляет модели провайдера в черновик настроек.
   *
   * Всё, что шлюз сообщил о модели (контекст, уровни рассуждений, инструменты),
   * берём оттуда. Чего не сообщил — остаётся пустым: угаданные уровни усилий
   * приводили к полям, которых провайдер не знает.
   *
   * Уже добавленные модели тоже обновляем: иначе после обновления приложения
   * уровни усилий не появились бы без удаления модели.
   */
  function importModels(list) {
    let added = 0;
    let updated = 0;
    const firstNew = [];
    list.forEach((info) => {
      const id = typeof info === 'string' ? info : info.id;
      if (!id) return;
      const efforts = (typeof info === 'object' && info.efforts) || [];
      const context = (typeof info === 'object' && info.context) || 0;

      const existing = (draft.models || []).find((m) => m.id === id);
      if (existing) {
        let touched = false;
        if (efforts.length && effortsOf(existing).join(',') !== efforts.join(',')) {
          existing.efforts = efforts;
          touched = true;
        }
        if (context && Number(existing.context) !== context) {
          existing.context = context;
          touched = true;
        }
        if (touched) updated++;
        return;
      }

      draft.models.push({
        id,
        name: prettyModelName(id),
        context: context || guessContext(id),
        tools: !/embed|whisper|tts|dall|moderation/i.test(id),
        efforts,
        input: /vision|vl|claude|gpt-4|gemini|qwen.*vl/i.test(id) ? ['text', 'image'] : ['text'],
        output: ['text'],
        priceIn: 0,
        priceOut: 0,
        note: '',
      });
      firstNew.push(id);
      added++;
    });
    if (!draft.models.some((m) => m.id === draft.activeModelId)) {
      draft.activeModelId = firstNew[0] || draft.models.find((m) => m.id)?.id || '';
    }
    if (added || updated) hintDirty();
    return { added, updated };
  }

  /* -------------------------------- Модели ------------------------------ */

  function onModelsClick(e) {
    if (e.target.closest('[data-open-provider]')) {
      tab = 'provider';
      render();
      return;
    }

    const del = e.target.closest('[data-del-model]');
    if (del) {
      const id = del.dataset.delModel;
      const row = del.closest('[data-model-row]');
      const idx = row ? Number(row.dataset.modelRow) : -1;
      draft.models = draft.models.filter((m, i) => (id ? m.id !== id : i !== idx));
      if (!draft.models.some((m) => m.id === draft.activeModelId)) {
        draft.activeModelId = draft.models.find((m) => m.id)?.id || '';
      }
      render();
      hintDirty();
      return;
    }

    const add = e.target.closest('[data-add-model]');
    if (add) {
      draft.models.push({
        id: '',
        name: 'Новая модель',
        context: 128000,
        tools: true,
        input: ['text'],
        output: ['text'],
        priceIn: 0,
        priceOut: 0,
        note: '',
      });
      render();
      hintDirty();
      const rows = pane.querySelectorAll('[data-model-row]');
      const last = rows[rows.length - 1];
      last && last.querySelector('input')?.focus();
      return;
    }

    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const p = JSON.parse(decodeURIComponent(preset.dataset.preset));
      if (!draft.models.some((m) => m.id === p.id)) draft.models.push({ ...p });
      if (!draft.activeModelId) draft.activeModelId = p.id;
      render();
      hintDirty();
    }
  }

  function bindModels() {
    // Клик-обработчик вешается на контейнер pane, который не пересоздаётся между
    // рендерами вкладки. Без флага он накапливался бы и один клик добавлял
    // модель несколько раз.
    if (!pane.dataset.modelsBound) {
      pane.dataset.modelsBound = '1';
      pane.addEventListener('click', onModelsClick);
    }

    // Редактирование полей модели
    pane.querySelectorAll('[data-model-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const idx = Number(input.dataset.modelRow);
        const field = input.dataset.modelField;
        const m = draft.models[idx];
        if (!m) return;
        if (field === 'tools') m.tools = input.checked;
        else if (field === 'efforts') {
          m.efforts = String(input.value || '')
            .split(/[,;\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        } else if (field === 'context' || field === 'priceIn' || field === 'priceOut') m[field] = Number(input.value) || 0;
        else m[field] = input.value;
        hintDirty();
      });
      input.addEventListener('change', () => input.dispatchEvent(new Event('input')));
    });

    // Модальности входа/выхода — чипы-переключатели
    pane.querySelectorAll('[data-modal-field]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.modelRow);
        const field = btn.dataset.modalField;
        const value = btn.dataset.modalValue;
        const m = draft.models[idx];
        if (!m) return;
        const arr = new Set(m[field] || []);
        if (arr.has(value)) arr.delete(value);
        else arr.add(value);
        if (!arr.size) arr.add('text');
        m[field] = [...arr];
        btn.classList.toggle('is-active');
        hintDirty();
      });
    });
  }

  /* ------------------------------- Контекст ----------------------------- */

  function bindContext() {
    const range = pane.querySelector('#thresholdRange');
    const label = pane.querySelector('#thresholdLabel');
    range.addEventListener('input', () => {
      label.textContent = `${range.value} %`;
      draft.compactThreshold = Number(range.value) / 100;
      hintDirty();
    });
  }

  /* ---------------------------- Веб-поиск ------------------------------ */

  function bindSearch() {
    const native = pane.querySelector('#nativeSearch');
    if (!native) return;
    // Поле «свои поля запроса» появляется только в режиме custom, поэтому при
    // смене режима панель нужно перерисовать — иначе поле не покажется.
    native.addEventListener('change', () => {
      draft.search.native = native.value;
      hintDirty();
      render();
    });
  }

  /* ----------------------------- Оформление ----------------------------- */

  function bindLook() {
    pane.querySelectorAll('[data-theme-opt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.theme = btn.dataset.themeOpt;
        applyTheme(draft.theme);
        pane.querySelectorAll('[data-theme-opt]').forEach((b) => b.classList.toggle('is-active', b === btn));
        hintDirty();
      });
    });
    pane.querySelectorAll('[data-scale]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.fontScale = Number(btn.dataset.scale);
        applyScale(draft.fontScale);
        pane.querySelectorAll('[data-scale]').forEach((b) => b.classList.toggle('is-active', b === btn));
        hintDirty();
      });
    });
  }

  /* -------------------------------- Данные ------------------------------ */

  function bindData() {
    pane.querySelector('[data-export]').addEventListener('click', async () => {
      const data = await store.exportAll();
      download(`qubit-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast('Резервная копия скачана', 'ok');
    });

    const fileInput = pane.querySelector('#importFile');
    pane.querySelector('[data-import]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const ok = await confirmDialog({
          title: 'Импортировать данные?',
          message: 'Чаты из файла добавятся к существующим. Настройки будут заменены.',
          confirmLabel: 'Импортировать',
          danger: false,
        });
        if (!ok) return;
        await store.importAll(data);
        state.settings = store.loadSettings();
        applyTheme(state.settings.theme);
        await bus.emit('chats:updated');
        toast('Данные импортированы', 'ok');
        modal.close();
        location.reload();
      } catch (err) {
        toast(err.message || 'Не удалось прочитать файл', 'error');
      } finally {
        fileInput.value = '';
      }
    });

    pane.querySelector('[data-clear-all]').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Удалить все чаты?',
        message: 'Все чаты и все файлы проектов будут удалены. Настройки останутся.',
        confirmLabel: 'Удалить всё',
      });
      if (!ok) return;
      await store.clearAllChats();
      state.chat = null;
      state.files = [];
      await bus.emit('chats:updated');
      modal.close();
      location.reload();
    });
  }

  function applyDraftPreview() {
    if (tab === 'look') {
      applyTheme(draft.theme);
      applyScale(draft.fontScale);
    }
  }

  render();
  return modal;
}

/* ------------------------------ Разметка ------------------------------- */

function renderPane(id, d) {
  if (id === 'provider') return paneProvider(d);
  if (id === 'models') return paneModels(d);
  if (id === 'context') return paneContext(d);
  if (id === 'search') return paneSearch(d);
  if (id === 'look') return paneLook(d);
  if (id === 'data') return paneData(d);
  return '';
}

function paneProvider(d) {
  const preset = PROVIDERS.find((p) => p.id === d.provider.preset) || PROVIDERS[0];
  const list = (d.models || []).filter((m) => m.id);
  return `<h3>Подключение к API</h3>
  <p class="pane-desc">Любой OpenAI-совместимый сервер: /chat/completions. Выберите провайдера — URL, заголовки и модели подставятся сами.</p>

  <div class="settings-block">
    <h4>${icon('link', 14)} Провайдер</h4>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      ${PROVIDERS.map(
        (p) =>
          `<button type="button" class="chip ${p.id === preset.id ? 'is-active' : ''}" data-provider-preset="${p.id}">${escapeAttr(
            p.name,
          )}</button>`,
      ).join('')}
    </div>
    <p class="tip" style="margin:10px 0 0;line-height:1.6">${escapeAttr(preset.hint)}${
      preset.keyUrl ? ` Ключ: <a href="${escapeAttr(preset.keyUrl)}" target="_blank" rel="noopener">${escapeAttr(preset.keyUrl)}</a>` : ''
    }</p>
  </div>

  <div class="form-grid">
    <div class="field">
      <label for="baseUrlInput">URL API</label>
      <input class="input mono" id="baseUrlInput" data-bind="provider.baseUrl" placeholder="https://api.example.com/v1" spellcheck="false" value="${escapeAttr(
        d.provider.baseUrl,
      )}">
      <span class="hint">Без /chat/completions — клиент добавит его сам.</span>
    </div>
    <div class="field">
      <label for="apiKeyInput">API-ключ</label>
      <div style="display:flex;gap:6px">
        <input class="input mono" id="apiKeyInput" type="password" data-bind="provider.apiKey" placeholder="sk-…" spellcheck="false" autocomplete="off" value="${escapeAttr(
          d.provider.apiKey,
        )}">
        <button type="button" class="icon-btn" data-toggle-key aria-label="Показать ключ">${icon('eye', 16)}</button>
      </div>
      <span class="hint">Ключ хранится в localStorage этого браузера и отправляется только на указанный URL.</span>
    </div>
    <div class="field">
      <label for="headersInput">Дополнительные заголовки</label>
      <textarea class="textarea mono" id="headersInput" data-bind="provider.extraHeaders" rows="3" spellcheck="false" placeholder="HTTP-Referer: https://example.com&#10;X-Title: Qubit AI">${html(
        d.provider.extraHeaders,
      )}</textarea>
      <span class="hint">По одному в строке, формат «Имя: значение». Нужно для OpenRouter.</span>
    </div>
    <div class="settings-block">
      <h4>${icon('tools', 14)} Возможности</h4>
      <label class="toggle-row">
        <span class="toggle-row__text"><strong>Потоковые ответы</strong><span>Показывать текст по мере генерации</span></span>
        <span class="switch"><input type="checkbox" data-bind="provider.stream" ${
          d.provider.stream ? 'checked' : ''
        }><span class="track"></span></span>
      </label>
      <div class="row" style="margin-top:12px;flex-wrap:wrap;align-items:center">
        <button type="button" class="btn btn--sm" data-test>${icon('link', 14)} Проверить и загрузить модели</button>
        <span class="tip" data-test-status></span>
      </div>
      <span class="hint" style="display:block;margin-top:6px">Запрос к /models. Найденные модели добавятся в список с примерным контекстом и нулевыми ценами — цены можно уточнить на вкладке «Модели».</span>
      <datalist id="modelsDatalist">${list.map((m) => `<option value="${escapeAttr(m.id)}"></option>`).join('')}</datalist>
    </div>
  </div>`;
}

function paneModels(d) {
  const preset = PROVIDERS.find((p) => p.id === d.provider.preset);
  const rec = preset && preset.models ? preset.models : [];
  return `<h3>Модели</h3>
  <p class="pane-desc">ID модели и имя, которое видно в интерфейсе. Контекст, цены и возможности влияют на расчёты и на выбор инструментов.</p>
  ${
    d.models.some((m) => m.id && !m.priceIn && !m.priceOut)
      ? `<div class="settings-block settings-block--hint">
          <p class="tip" style="margin:0;line-height:1.65">У импортированных моделей цены нулевые: список <code>/models</code> их не отдаёт. Впишите стоимость входа и выхода в рублях за 1M токенов — тогда счётчик расхода будет точным.</p>
        </div>`
      : ''
  }
  ${
    d.models.filter((m) => m.id).length
      ? ''
      : `<div class="settings-block settings-block--empty">
          <h4>${icon('cpu', 14)} Пока нет ни одной модели</h4>
          <p class="tip" style="margin:0 0 10px;line-height:1.65">Нажмите «Проверить и загрузить модели» на вкладке «Подключение» — список придёт из API. Либо добавьте модель вручную.</p>
        </div>`
  }
  <div class="model-editor">
    ${d.models
      .map((m, i) => modelRow(m, i))
      .join('')}
  </div>
  <div class="row" style="margin-top:12px;flex-wrap:wrap">
    <button type="button" class="btn btn--sm" data-add-model>${icon('plus', 14)} Добавить модель</button>
    <button type="button" class="btn btn--sm" data-open-provider>${icon('link', 14)} Загрузить из API</button>
  </div>
  ${
    rec.length
      ? `<div class="settings-block" style="margin-top:14px">
          <h4>${icon('plus', 14)} Рекомендуемые для ${escapeAttr(preset.name)}</h4>
          <div class="row" style="flex-wrap:wrap;gap:6px">
            ${rec
              .map(
                (p) =>
                  `<button type="button" class="chip ${d.models.some((m) => m.id === p.id) ? 'is-active' : ''}" data-preset="${encodeURIComponent(
                    JSON.stringify(p),
                  )}">${escapeAttr(p.name)}</button>`,
              )
              .join('')}
          </div>
        </div>`
      : ''
  }`;
}

function modelRow(m, i) {
  return `<div class="model-row${m.id ? '' : ' model-row--new'}" data-model-row="${i}">
    <div class="model-row__head">
      <strong>${escapeAttr(m.name || m.id || 'Новая модель')}</strong>
      <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-del-model="${escapeAttr(
        m.id,
      )}" title="Удалить модель">${icon('trash', 14)}</button>
    </div>
    <div class="form-row">
      <div class="field">
        <label>ID модели</label>
        <input class="input mono" data-model-field="id" data-model-row="${i}" list="modelsDatalist" spellcheck="false" value="${escapeAttr(
          m.id,
        )}" placeholder="provider/model-name">
      </div>
      <div class="field">
        <label>Показываемое имя</label>
        <input class="input" data-model-field="name" data-model-row="${i}" value="${escapeAttr(m.name)}">
      </div>
    </div>
    <div class="form-row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="field">
        <label>Контекст, токенов</label>
        <input class="input" type="number" min="1000" step="1000" data-model-field="context" data-model-row="${i}" value="${m.context}">
      </div>
      <div class="field">
        <label>Вход, ₽ за 1M</label>
        <input class="input" type="number" min="0" step="0.01" data-model-field="priceIn" data-model-row="${i}" value="${m.priceIn}">
      </div>
      <div class="field">
        <label>Выход, ₽ за 1M</label>
        <input class="input" type="number" min="0" step="0.01" data-model-field="priceOut" data-model-row="${i}" value="${m.priceOut}">
      </div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>Вход</label>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          ${Object.entries(MODALITIES)
            .map(
              ([k, v]) =>
                `<button type="button" class="chip ${(m.input || []).includes(k) ? 'is-active' : ''}" data-modal-field="input" data-modal-value="${k}" data-model-row="${i}">${v}</button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="field">
        <label>Выход</label>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          ${Object.entries(MODALITIES)
            .map(
              ([k, v]) =>
                `<button type="button" class="chip ${(m.output || []).includes(k) ? 'is-active' : ''}" data-modal-field="output" data-modal-value="${k}" data-model-row="${i}">${v}</button>`,
            )
            .join('')}
        </div>
      </div>
    </div>
    <div class="row" style="justify-content:space-between">
      <label class="switch">
        <input type="checkbox" data-model-field="tools" data-model-row="${i}" ${m.tools !== false ? 'checked' : ''}>
        <span class="track"></span>
        <span>Поддерживает инструменты</span>
      </label>
      <input class="input" style="max-width:260px" data-model-field="note" data-model-row="${i}" value="${escapeAttr(
        m.note || '',
      )}" placeholder="Короткое описание">
    </div>
    <div class="field" style="margin-top:10px">
      <label>Уровни усилий от провайдера</label>
      <input class="input mono" data-model-field="efforts" data-model-row="${i}" spellcheck="false"
        value="${escapeAttr(effortsOf(m).join(', '))}"
        placeholder="не заданы — выбора не будет">
      <span class="hint">Через запятую, ровно как называет провайдер: например <code>low, medium, high</code>. Пустое поле — усилия не выбираются и <code>reasoning_effort</code> в запрос не уходит. У OpenRouter список приходит из <code>/models</code> автоматически.</span>
    </div>
  </div>`;
}

function paneContext(d) {
  const model = getModel(d.activeModelId, d);
  return `<h3>Контекст и сжатие</h3>
  <p class="pane-desc">Когда история заполняет порог, старые сообщения заменяются сводкой. Пользователь может открыть её в чате.</p>
  <div class="form-grid">
    <div class="field">
      <label for="thresholdRange">Порог сжатия — <span id="thresholdLabel">${Math.round(
        (d.compactThreshold || 0.8) * 100,
      )} %</span></label>
      <input type="range" id="thresholdRange" min="50" max="95" step="5" value="${Math.round(
        (d.compactThreshold || 0.8) * 100,
      )}" style="width:100%;accent-color:var(--accent)">
      <span class="hint">Сжатие срабатывает, когда контекст заполнен на указанный процент.</span>
    </div>
    <div class="form-row">
      <div class="field">
        <label for="keepLast">Сколько последних сообщений сохранять</label>
        <input class="input" id="keepLast" type="number" min="2" max="40" data-bind="compactKeepLast" value="${d.compactKeepLast}">
      </div>
      <div class="field">
        <label for="contextCap">Свой лимит контекста, токенов</label>
        <input class="input" id="contextCap" type="number" min="0" step="1000" data-bind="contextCap" value="${d.contextCap}">
        <span class="hint">0 — использовать лимит модели${model ? ` (${formatNumber(model.context)})` : ''}.</span>
      </div>
    </div>
    <div class="form-row">
      <div class="field">
        <label for="maxSteps">Шагов агента за один ответ</label>
        <input class="input" id="maxSteps" type="number" min="4" max="200" step="1" data-bind="maxSteps" value="${
          d.maxSteps ?? DEFAULT_MAX_STEPS
        }">
        <span class="hint">Сколько раз модель может вызвать инструменты, прежде чем ход завершится. Длинная задача требует больше шагов: 16 не хватало даже на таймер.</span>
      </div>
      <div class="field">
        <label for="maxTokens">Лимит вывода, токенов</label>
        <input class="input" id="maxTokens" type="number" min="2048" step="1000" data-bind="maxTokens" value="${
          d.maxTokens ?? DEFAULT_MAX_TOKENS
        }">
        <span class="hint">Потолок длины одного ответа. Слишком маленький обрывает большие файлы.</span>
      </div>
    </div>
    <div class="settings-block">
      <h4>${icon('info', 14)} Как это работает</h4>
      <ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--text-2);line-height:1.7">
        <li>Первые два сообщения и последние N остаются как есть.</li>
        <li>Середина заменяется краткой сводкой от модели.</li>
        <li>Сводка видна в чате в акцентной карточке.</li>
        <li>Расход сессии при сжатии не сбрасывается.</li>
      </ul>
    </div>
  </div>`;
}

function paneSearch(d) {
  const s = d.search;
  return `<h3>Веб-поиск</h3>
  <p class="pane-desc">Инструмент web_search даёт модели доступ к поиску, если провайдер не умеет искать сам. По умолчанию используется открытый API Википедии — работает без ключа.</p>
  <div class="form-grid">
    <div class="form-row">
      <div class="field">
        <label for="searchMode">Источник</label>
        <select class="select" id="searchMode" data-bind="search.mode">
          <option value="off" ${s.mode === 'off' ? 'selected' : ''}>Выключен</option>
          <option value="wikipedia" ${s.mode === 'wikipedia' ? 'selected' : ''}>Википедия (без ключа)</option>
          <option value="custom" ${s.mode === 'custom' ? 'selected' : ''}>Свой JSON-API</option>
        </select>
      </div>
      <div class="field">
        <label for="searchMax">Запросов за один ответ</label>
        <input class="input" id="searchMax" type="number" min="0" max="20" data-bind="search.maxPerTurn" value="${
          s.maxPerTurn ?? 4
        }">
        <span class="hint">0 — без ограничения (в рамках 16 шагов агента).</span>
      </div>
    </div>
    <div class="field">
      <label for="nativeSearch">Встроенный поиск провайдера</label>
      <select class="select" id="nativeSearch" data-bind="search.native">
        <option value="auto" ${s.native === 'auto' ? 'selected' : ''}>Определить по провайдеру</option>
        <option value="off" ${s.native === 'off' ? 'selected' : ''}>Не использовать</option>
        <option value="openrouter" ${s.native === 'openrouter' ? 'selected' : ''}>OpenRouter — plugins: web</option>
        <option value="openai" ${s.native === 'openai' ? 'selected' : ''}>OpenAI — web_search_preview</option>
        <option value="xai" ${s.native === 'xai' ? 'selected' : ''}>xAI / Grok — search_parameters</option>
        <option value="custom" ${s.native === 'custom' ? 'selected' : ''}>Свои поля запроса (JSON)</option>
      </select>
      <span class="hint">Некоторые провайдеры ищут сами и отдают готовые ссылки. Если шлюз не понял поля, запрос автоматически повторится без него.</span>
    </div>
    ${
      s.native === 'custom'
        ? `<div class="field">
            <label for="nativeBody">Поля тела запроса, JSON</label>
            <textarea class="textarea mono" id="nativeBody" rows="3" data-bind="search.nativeBody" spellcheck="false" placeholder='{"plugins":[{"id":"web"}]}'>${html(
              s.nativeBody,
            )}</textarea>
          </div>`
        : ''
    }
    <div class="field">
      <label for="searchEndpoint">URL шаблона</label>
      <input class="input mono" id="searchEndpoint" data-bind="search.endpoint" spellcheck="false" value="${escapeAttr(
        s.endpoint,
      )}">
      <span class="hint">Подстановки: {query} и {limit}. Ответ должен быть JSON; путь к массиву задаётся ниже.</span>
    </div>
    <div class="form-row" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="field">
        <label>Путь к массиву</label>
        <input class="input mono" data-bind="search.resultPath" value="${escapeAttr(s.resultPath)}" placeholder="results">
      </div>
      <div class="field">
        <label>Ключ заголовка</label>
        <input class="input mono" data-bind="search.titleKey" value="${escapeAttr(s.titleKey)}" placeholder="title">
      </div>
      <div class="field">
        <label>Ключ сниппета</label>
        <input class="input mono" data-bind="search.snippetKey" value="${escapeAttr(s.snippetKey)}" placeholder="snippet">
      </div>
    </div>
    <div class="form-row">
      <div class="field">
        <label>URL результата</label>
        <input class="input mono" data-bind="search.urlTemplate" value="${escapeAttr(
          s.urlTemplate,
        )}" placeholder="https://site.ru/{title}">
      </div>
      <div class="field">
        <label>Заголовок авторизации (необязательно)</label>
        <div style="display:flex;gap:6px">
          <input class="input mono" data-bind="search.headerName" placeholder="X-API-Key" value="${escapeAttr(s.headerName)}">
          <input class="input mono" data-bind="search.headerValue" placeholder="значение" value="${escapeAttr(
            s.headerValue,
          )}">
        </div>
      </div>
    </div>
    <div class="alert" style="background:var(--surface-2);border-color:var(--border);color:var(--text-2)">
      ${icon('info', 16)}
      <span>Сторонние поисковые API должны разрешать CORS. Википедия и большинство публичных API — разрешают.
      Поиск ждёт ответа не дольше 12 секунд, а одинаковые запросы повторно из сети не берутся.
      Лимит запросов за один ответ задаётся выше; выключить поиск в отдельном чате можно в меню чата «⋯».</span>
    </div>
  </div>`;
}

function paneLook(d) {
  return `<h3>Оформление</h3>
  <p class="pane-desc">Тема и размер текста применяются сразу, до сохранения.</p>
  <div class="form-grid">
    <div>
      <div class="field-label" style="margin-bottom:8px">Тема</div>
      <div class="row" style="flex-wrap:wrap">
        <button type="button" class="chip ${d.theme === 'auto' ? 'is-active' : ''}" data-theme-opt="auto">${icon(
          'monitor',
          14,
        )} Как в системе</button>
        <button type="button" class="chip ${d.theme === 'light' ? 'is-active' : ''}" data-theme-opt="light">${icon(
          'sun',
          14,
        )} Светлая</button>
        <button type="button" class="chip ${d.theme === 'dark' ? 'is-active' : ''}" data-theme-opt="dark">${icon(
          'moon',
          14,
        )} Тёмная</button>
      </div>
      <span class="hint" style="display:block;margin-top:6px">В режиме «Как в системе» тема меняется вместе с настройками устройства.</span>
    </div>
    <div>
      <div class="field-label" style="margin-bottom:8px">Размер текста</div>
      <div class="row">
        <button type="button" class="chip ${d.fontScale === 0.94 ? 'is-active' : ''}" data-scale="0.94">Компактный</button>
        <button type="button" class="chip ${d.fontScale === 1 ? 'is-active' : ''}" data-scale="1">Обычный</button>
        <button type="button" class="chip ${d.fontScale === 1.08 ? 'is-active' : ''}" data-scale="1.08">Крупный</button>
      </div>
    </div>
    <div class="settings-block">
      <h4>${icon('keyboard', 14)} Поведение</h4>
      <label class="toggle-row">
        <span class="toggle-row__text"><strong>Enter отправляет сообщение</strong><span>Shift+Enter — перенос строки</span></span>
        <span class="switch"><input type="checkbox" data-bind="sendOnEnter" ${
          d.sendOnEnter ? 'checked' : ''
        }><span class="track"></span></span>
      </label>
      <label class="toggle-row">
        <span class="toggle-row__text"><strong>Автоматические названия чатов</strong><span>По первому сообщению</span></span>
        <span class="switch"><input type="checkbox" data-bind="autoTitle" ${d.autoTitle ? 'checked' : ''}><span class="track"></span></span>
      </label>
      <label class="toggle-row">
        <span class="toggle-row__text"><strong>Показывать детали токенов</strong><span>Вход и выход в подсказке</span></span>
        <span class="switch"><input type="checkbox" data-bind="showTokenDetails" ${
          d.showTokenDetails ? 'checked' : ''
        }><span class="track"></span></span>
      </label>
    </div>
  </div>`;
}

function paneData(d) {
  return `<h3>Данные</h3>
  <p class="pane-desc">Чаты и файлы хранятся в IndexedDB этого браузера. Ключ API — в localStorage. Экспорт позволяет перенести всё на другое устройство.</p>
  <div class="form-grid">
    <div class="settings-block">
      <h4>${icon('download', 14)} Резервная копия</h4>
      <p class="tip" style="margin:0 0 10px">Один JSON-файл: настройки, чаты и файлы всех проектов.</p>
      <div class="row" style="flex-wrap:wrap">
        <button type="button" class="btn btn--sm" data-export>${icon('download', 14)} Экспортировать</button>
        <button type="button" class="btn btn--sm" data-import>${icon('folder', 14)} Импортировать</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
    </div>
    <div class="settings-block">
      <h4 style="color:var(--danger)">${icon('alert', 14)} Опасная зона</h4>
      <p class="tip" style="margin:0 0 10px">Удаление необратимо. Сначала сделайте резервную копию.</p>
      <button type="button" class="btn btn--sm btn--danger" data-clear-all>${icon('trash', 14)} Удалить все чаты</button>
    </div>
    <div class="settings-block">
      <h4>${icon('info', 14)} О приложении</h4>
      <p class="tip" style="margin:0;line-height:1.7">
        Qubit AI · версия 1.1<br>
        Статический клиент для GitHub Pages, без сервера и без аналитики.<br>
        Сообщения и файлы не покидают браузер, кроме запросов к вашему API.
      </p>
    </div>
  </div>`;
}

/* ------------------------------- Утилиты ------------------------------- */

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cur[path[i]] || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
    cur = cur[path[i]];
  }
  cur[path[path.length - 1]] = value;
}
