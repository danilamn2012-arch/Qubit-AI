/**
 * Модалка настроек: провайдер, модели, контекст, поиск, оформление, данные.
 */

import { icon } from './icons.js';
import { escapeHtml } from './markdown.js';
import { openModal, confirmDialog, toast, download, copyText } from './modals.js';
import { buildInviteLink } from './invite.js';
import { state, bus, persistSettings, applyTheme, applyScale } from './state.js';
import * as store from './storage.js';
import { testConnection, parseExtraHeaders } from './api.js';
import { formatNumber, formatCompact } from './pricing.js';
import { MODALITIES, PROVIDERS, guessContext, prettyModelName, effortsOf, DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, DEFAULT_PROVIDER } from './config.js';
import { newProviderId, providerHost, providerLabel } from './providers.js';

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
  (settings.models || []).find((m) => m.id === id) ||
  (settings.models || []).find((m) => m.id && m.enabled !== false) ||
  (settings.models || [])[0] || {
    id: '',
    name: 'Модель не выбрана',
    context: 128000,
    priceIn: 0,
    priceOut: 0,
  };

export function openSettings(initialTab = 'provider') {
  let tab = initialTab;
  const draft = structuredClone(state.settings);
  /**
   * Какие модели раскрыты и что введено в поиск. Живёт вне render(): панель
   * перерисовывается на каждое действие, и без этого раскрытая карточка
   * схлопывалась бы после каждого переключения тумблера.
   */
  const modelView = { expanded: new Set(), query: '', provider: '' };
  /** Раскрытый провайдер, черновик нового подключения и статус проверки. */
  const providerView = { open: '', adding: false, status: {} };
  /**
   * Были ли правки, которые пользователь не сохранил. Сравниваем с исходными
   * настройками: без этого закрытие по Esc или клику по фону молча теряло
   * введённый ключ и URL.
   */
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    const hint = document.querySelector('#saveHint');
    if (hint) hint.textContent = 'Есть несохранённые изменения';
  };

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
      <button type="button" class="btn btn--primary" data-save>${icon('check', 15)} Сохранить</button>`,
    onBeforeClose: async () => {
      if (!dirty) return true;
      return confirmDialog({
        title: 'Закрыть без сохранения?',
        message: 'В настройках есть несохранённые изменения. Если закрыть сейчас, они пропадут.',
        confirmLabel: 'Закрыть без сохранения',
        cancelLabel: 'Вернуться',
        danger: true,
      });
    },
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
    pane.innerHTML = renderPane(tab, draft, modelView, providerView);
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
    markDirty();
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
    // Модель без провайдера некуда отправить: привязываем к первому.
    const firstProvider = (draft.providers || [])[0];
    if (firstProvider) {
      draft.models.forEach((m) => {
        if (!m.providerId) m.providerId = firstProvider.id;
      });
    }
    // Активной может быть только включённая модель.
    if (!draft.models.some((m) => m.id === draft.activeModelId && m.enabled !== false)) {
      draft.activeModelId = draft.models.find((m) => m.enabled !== false)?.id || '';
    }
    if (!(draft.providers || []).some((p) => p.id === draft.activeProviderId)) {
      draft.activeProviderId = draft.providers?.[0]?.id || '';
    }
    persistSettings(draft);
    applyTheme(draft.theme);
    applyScale(draft.fontScale);
    state.settings = draft;
    dirty = false;
    modal.close();
    bus.emit('settings:saved');
    toast('Настройки сохранены', 'ok');
    if (!state.settings.models.length) {
      setTimeout(() => toast('Моделей нет — добавьте хотя бы одну, чтобы начать чат.', 'info'), 900);
    } else if (!state.settings.models.some((m) => m.enabled !== false)) {
      setTimeout(() => toast('Все модели выключены — включите хотя бы одну во вкладке «Модели».', 'info'), 900);
    }
  });

  /* ------------------------------ Подключение --------------------------- */

  const draftProviders = () => {
    if (!Array.isArray(draft.providers)) draft.providers = [];
    return draft.providers;
  };

  const curProvider = () => {
    const list = draftProviders();
    return list.find((p) => p.id === draft.activeProviderId) || list[0] || null;
  };

  function bindProvider() {
    // Выбор активного провайдера в списке
    pane.querySelectorAll('[data-select-provider]').forEach((btn) => {
      btn.addEventListener('click', () => {
        draft.activeProviderId = btn.dataset.selectProvider;
        providerView.open = btn.dataset.selectProvider;
        hintDirty();
        render();
      });
    });

    // Раскрытие карточки провайдера
    pane.querySelectorAll('[data-provider-toggle]').forEach((head) => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('.switch') || e.target.closest('[data-del-provider]')) return;
        const id = head.dataset.providerToggle;
        providerView.open = providerView.open === id ? '' : id;
        draft.activeProviderId = id;
        render();
      });
    });

    // Тумблер провайдера: выключенный пропадает из чата вместе с моделями
    pane.querySelectorAll('[data-provider-enabled]').forEach((box) => {
      box.addEventListener('change', () => {
        const p = draftProviders().find((x) => x.id === box.dataset.providerEnabled);
        if (!p) return;
        p.enabled = !!box.checked;
        hintDirty();
        render();
      });
    });

    const delBtn = pane.querySelector('[data-del-provider]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        const id = delBtn.dataset.delProvider;
        const p = draftProviders().find((x) => x.id === id);
        if (!p) return;
        const count = draft.models.filter((m) => m.providerId === id).length;
        const ok = await confirmDialog({
          title: 'Удалить провайдера?',
          message: `«${p.name}» и ${count ? `его моделей: ${count}` : 'его модели'} будут удалены из настроек. Ключ тоже удалится из этого браузера.`,
          confirmLabel: 'Удалить',
          danger: true,
        });
        if (!ok) return;
        draft.providers = draftProviders().filter((x) => x.id !== id);
        draft.models = draft.models.filter((m) => m.providerId !== id);
        if (draft.activeProviderId === id) draft.activeProviderId = draft.providers[0]?.id || '';
        if (!draft.models.some((m) => m.id === draft.activeModelId)) {
          draft.activeModelId = draft.models.find((m) => m.id && m.enabled !== false)?.id || '';
        }
        providerView.open = '';
        hintDirty();
        render();
      });
    }

    // Добавление нового провайдера
    const addBtn = pane.querySelector('[data-add-provider]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        providerView.adding = true;
        providerView.open = '';
        render();
        const first = pane.querySelector('#newProviderBaseUrl');
        if (first) first.focus();
      });
    }

    const cancelAdd = pane.querySelector('[data-cancel-add-provider]');
    if (cancelAdd) {
      cancelAdd.addEventListener('click', () => {
        providerView.adding = false;
        render();
      });
    }

    // Пресеты в форме нового провайдера
    pane.querySelectorAll('[data-new-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = PROVIDERS.find((x) => x.id === btn.dataset.newPreset);
        if (!p) return;
        const form = pane.querySelector('[data-new-provider]');
        if (!form) return;
        form.querySelector('[name="newBaseUrl"]').value = p.baseUrl || '';
        form.querySelector('[name="newHeaders"]').value = p.extraHeaders || '';
        form.querySelector('[name="newName"]').value = p.name;
        form.dataset.preset = p.id;
        pane.querySelectorAll('[data-new-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });

    // Сохранение нового провайдера (только в черновик)
    const newForm = pane.querySelector('[data-new-provider]');
    if (newForm) {
      newForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = newForm.querySelector('[name="newName"]').value.trim() || 'Провайдер';
        const baseUrl = newForm.querySelector('[name="newBaseUrl"]').value.trim();
        if (!baseUrl) {
          toast('Укажите URL API', 'error');
          return;
        }
        const provider = {
          ...structuredClone(DEFAULT_PROVIDER),
          id: newProviderId(),
          name,
          preset: newForm.dataset.preset || 'custom',
          baseUrl,
          apiKey: newForm.querySelector('[name="newApiKey"]').value.trim(),
          extraHeaders: newForm.querySelector('[name="newHeaders"]').value.trim(),
        };
        draftProviders().push(provider);
        draft.activeProviderId = provider.id;
        providerView.adding = false;
        providerView.open = provider.id;
        hintDirty();
        render();
        toast(`Провайдер «${provider.name}» добавлен. Загрузите его модели.`, 'ok');
      });
    }

    // Редактирование полей открытого провайдера
    pane.querySelectorAll('[data-provider-field]').forEach((input) => {
      const apply = () => {
        const p = draftProviders().find((x) => x.id === input.dataset.providerId);
        if (!p) return;
        p[input.dataset.providerField] = input.value;
        hintDirty();
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });

    // Пресет внутри открытой карточки
    pane.querySelectorAll('[data-provider-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = draftProviders().find((x) => x.id === btn.dataset.providerFor);
        const preset = PROVIDERS.find((x) => x.id === btn.dataset.providerPreset);
        if (!p || !preset) return;
        // Ключ одного провайдера нельзя отправлять другому
        if (p.preset !== preset.id && p.apiKey) p.apiKey = '';
        p.preset = preset.id;
        p.baseUrl = preset.baseUrl || '';
        p.extraHeaders = preset.extraHeaders || '';
        if (!p.name || p.name === 'Провайдер') p.name = preset.name;
        hintDirty();
        render();
      });
    });

    // Поделиться доступом: открывает окно со ссылкой для выбранного провайдера
    pane.querySelectorAll('[data-share-provider]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = draftProviders().find((x) => x.id === btn.dataset.shareProvider);
        if (!p) return;
        openShareDialog(p, draft.models.filter((m) => m.providerId === p.id && m.id));
      });
    });

    // Тумблер потоковых ответов у провайдера
    pane.querySelectorAll('[data-provider-stream]').forEach((box) => {
      box.addEventListener('change', () => {
        const p = draftProviders().find((x) => x.id === box.dataset.providerStream);
        if (!p) return;
        p.stream = !!box.checked;
        hintDirty();
      });
    });

    // Кнопка «Проверить и загрузить модели» у каждого провайдера
    pane.querySelectorAll('[data-test]').forEach((testBtn) => {
      const providerId = testBtn.dataset.test;
      const status = pane.querySelector(`[data-test-status="${providerId}"]`);
      testBtn.addEventListener('click', async () => {
        const p = draftProviders().find((x) => x.id === providerId);
        if (!p) return;
        const setStatus = (text, color) => {
          // Статус храним вне DOM: после импорта панель перерисовывается, и
          // текст, записанный напрямую в элемент, пропадал.
          providerView.status[providerId] = { text, color };
          if (status) {
            status.textContent = text;
            status.style.color = color || '';
          }
        };
        if (!p.baseUrl) {
          setStatus('Сначала укажите URL API', 'var(--danger)');
          return;
        }
        testBtn.disabled = true;
        setStatus('Проверяю…', 'var(--muted)');
        try {
          const list = await testConnection({
            baseUrl: p.baseUrl,
            apiKey: p.apiKey,
            extraHeaders: parseExtraHeaders(p.extraHeaders),
          });
          if (!list.length) {
            setStatus('Соединение есть, но список моделей пуст', 'var(--warning, var(--accent-ink))');
            return;
          }

          const res = importModels(list, providerId);
          const withEfforts = list.filter((m) => m.efforts && m.efforts.length).length;
          const parts = [`Доступно моделей: ${list.length}`];
          if (res.added) parts.push(`добавлено: ${res.added} — выключены`);
          if (res.updated) parts.push(`обновлено: ${res.updated}`);
          if (!res.added && !res.updated) parts.push('новых нет');
          if (withEfforts) parts.push(`с уровнями усилий: ${withEfforts}`);
          setStatus(`Успешно. ${parts.join(', ')}`, 'var(--success)');
          toast(
            res.added
              ? `Добавлено моделей: ${res.added}. Они выключены — включите нужные на вкладке «Модели».`
              : res.updated
                ? `Обновлено моделей: ${res.updated}`
                : 'Список моделей уже актуален',
            'ok',
          );
          // Список моделей мог наполниться: перерисовываем панель, чтобы
          // счётчик у провайдера обновился.
          render();
        } catch (err) {
          setStatus(err.message || 'Ошибка подключения', 'var(--danger)');
        } finally {
          testBtn.disabled = false;
        }
      });
    });

    pane.querySelectorAll('[data-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = pane.querySelector(btn.dataset.toggleKey);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
      });
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
  function importModels(list, providerId) {
    let added = 0;
    let updated = 0;
    const pid = providerId || draft.activeProviderId || draft.providers?.[0]?.id || '';
    list.forEach((info) => {
      const id = typeof info === 'string' ? info : info.id;
      if (!id) return;
      const efforts = (typeof info === 'object' && info.efforts) || [];
      const context = (typeof info === 'object' && info.context) || 0;

      // Модель ищем в пределах своего провайдера: одинаковый ID бывает у
      // разных шлюзов, и обновлять чужую запись нельзя.
      const existing = (draft.models || []).find((m) => m.id === id && (m.providerId || pid) === pid);
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
        providerId: pid,
        name: prettyModelName(id),
        // Импортированные модели приходят выключенными: у шлюзов их сотни,
        // и включёнными они завалили бы список выбора в чате. Пользователь
        // включает нужные тумблером.
        enabled: false,
        context: context || guessContext(id),
        tools: !/embed|whisper|tts|dall|moderation/i.test(id),
        efforts,
        input: /vision|vl|claude|gpt-4|gemini|qwen.*vl/i.test(id) ? ['text', 'image'] : ['text'],
        output: ['text'],
        priceIn: 0,
        priceOut: 0,
        note: '',
      });
      added++;
    });
    // Активную модель выбираем только среди включённых: иначе в чат попала бы
    // выключенная модель.
    if (!draft.models.some((m) => m.id === draft.activeModelId && m.enabled !== false)) {
      draft.activeModelId = draft.models.find((m) => m.id && m.enabled !== false)?.id || '';
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
      // Удаляем по индексу: одинаковый ID бывает у разных провайдеров, и
      // фильтр по id снёс бы несколько моделей сразу.
      draft.models = draft.models.filter((m, i) => (idx >= 0 ? i !== idx : m.id !== id));
      modelView.expanded.clear();
      if (!draft.models.some((m) => m.id === draft.activeModelId && m.enabled !== false)) {
        draft.activeModelId = draft.models.find((m) => m.id && m.enabled !== false)?.id || '';
      }
      render();
      hintDirty();
      return;
    }

    // Тумблеры моделей и «все модели» обрабатываются в bindModels через change:
    // клик по подложке переключателя достаётся label, а не input, поэтому
    // обработчик клика на контейнере его не видел.

    // Клик по тумблеру (в том числе по его подложке) не раскрывает карточку.
    if (e.target.closest('.model-row__switch')) return;

    // Раскрытие характеристик модели.
    const toggleRow = e.target.closest('[data-model-toggle]');
    if (toggleRow) {
      const idx = Number(toggleRow.dataset.modelToggle);
      if (modelView.expanded.has(idx)) modelView.expanded.delete(idx);
      else modelView.expanded.add(idx);
      render();
      return;
    }

    const add = e.target.closest('[data-add-model]');
    if (add) {
      // Новую модель сразу раскрываем и сбрасываем поиск: иначе строка может
      // оказаться вне фильтра, и пользователь её не увидит.
      modelView.query = '';
      draft.models.push({
        id: '',
        providerId: draft.activeProviderId || draft.providers?.[0]?.id || '',
        name: 'Новая модель',
        enabled: true,
        context: 128000,
        tools: true,
        input: ['text'],
        output: ['text'],
        priceIn: 0,
        priceOut: 0,
        note: '',
      });
      modelView.expanded.add(draft.models.length - 1);
      render();
      hintDirty();
      const rows = pane.querySelectorAll('.model-row[data-model-row]');
      const last = rows[rows.length - 1];
      last && last.querySelector('input')?.focus();
      return;
    }

    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const p = JSON.parse(decodeURIComponent(preset.dataset.preset));
      if (!draft.models.some((m) => m.id === p.id)) draft.models.push({ ...p, enabled: true });
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

    // Тумблер одной модели.
    pane.querySelectorAll('[data-model-enabled]').forEach((box) => {
      box.addEventListener('change', () => {
        const idx = Number(box.dataset.modelEnabled);
        const m = draft.models[idx];
        if (!m) return;
        m.enabled = !!box.checked;
        // Активной не может быть выключенная модель: переводим на первую включённую.
        if (!m.enabled && draft.activeModelId === m.id) {
          draft.activeModelId = draft.models.find((x) => x.id && x.id !== m.id && x.enabled !== false)?.id || '';
        }
        render();
        hintDirty();
      });
    });

    // «Все модели»: включаем или выключаем весь список разом.
    const allBox = pane.querySelector('[data-toggle-all-models]');
    if (allBox) {
      allBox.addEventListener('change', () => {
        const on = !!allBox.checked;
        draft.models.forEach((m) => {
          if (m.id) m.enabled = on;
        });
        if (!on) draft.activeModelId = '';
        else if (!draft.models.some((m) => m.id === draft.activeModelId && m.enabled !== false)) {
          draft.activeModelId = draft.models.find((m) => m.id)?.id || '';
        }
        render();
        hintDirty();
      });
    }

    // Поиск по моделям. Перерисовываем панель, но возвращаем фокус и позицию
    // курсора: иначе после первой же буквы ввод обрывался.
    const search = pane.querySelector('[data-model-search]');
    if (search) {
      search.addEventListener('input', () => {
        modelView.query = search.value;
        const pos = search.selectionStart;
        render();
        const next = pane.querySelector('[data-model-search]');
        if (next) {
          next.focus();
          try {
            next.setSelectionRange(pos, pos);
          } catch {}
        }
      });
    }

    // Редактирование полей модели
    pane.querySelectorAll('[data-model-field]').forEach((input) => {
      const apply = () => {
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
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', () => {
        apply();
        // Смена провайдера меняет подпись строки и порядок — перерисовываем.
        if (input.dataset.modelField === 'providerId') render();
      });
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

/**
 * Окно «Поделиться доступом».
 *
 * Показывает ссылку и даёт выбрать модели: получатель увидит только их
 * названия. Ссылка обновляется при каждом переключении, потому что набор
 * моделей зашит в неё.
 */
function openShareDialog(provider, models) {
  if (!provider.apiKey) {
    toast('У этого провайдера не указан ключ — ссылка будет бесполезной', 'error');
  }
  // По умолчанию делимся включёнными моделями: выключенные в чате не видны и
  // получателю тоже не нужны.
  const picked = new Set(models.filter((m) => m.enabled !== false).map((m) => m.id));
  // Если включённых нет — отмечаем все, иначе ссылка не даст ни одной модели.
  if (!picked.size) models.forEach((m) => picked.add(m.id));
  /** Тумблер «все модели» отражает фактический выбор, а не намерение. */
  let all = models.length > 0 && picked.size === models.length;

  let link = '';
  let tooLong = false;

  const modal = openModal({
    title: 'Поделиться доступом',
    subtitle: `${provider.name} · получатель увидит только выбранные модели`,
    body: `<div class="share">
      <div class="share__warn">
        ${icon('alert', 16)}
        <span>В ссылке лежит ключ в зашифрованном виде. Её не стоит публиковать в открытых местах: любой, кто получил ссылку, может тратить ваш ключ на выбранных моделях.</span>
      </div>
      <div class="field">
        <label>Ссылка</label>
        <div class="share__link">
          <input class="input mono" id="shareLink" readonly value="Создаю…" spellcheck="false">
          <button type="button" class="btn btn--sm btn--primary" data-copy-link>${icon('copy', 14)} Копировать</button>
        </div>
        <span class="hint" id="shareHint">Ссылка не содержит открытого URL и ключа. Чем меньше моделей, тем короче она будет.</span>
      </div>
      <div class="share__models">
        <div class="share__models-head">
          <strong>Модели в ссылке</strong>
          <label class="model-all">
            <span class="switch"><input type="checkbox" id="shareAll" ${
              all ? 'checked' : ''
            }><span class="track"></span></span>
            <span class="model-all__text"><span>Все модели провайдера</span></span>
          </label>
        </div>
        <div class="share__model-list" id="shareModels">
          ${models
            .map(
              (m) => `<label class="share__model">
                <input type="checkbox" data-share-model="${escapeAttr(m.id)}" ${
                  picked.has(m.id) ? 'checked' : ''
                }>
                <span class="share__model-name">${escapeAttr(m.name || m.id)}</span>
              </label>`,
            )
            .join('') || '<span class="tip">У провайдера пока нет моделей — загрузите их на вкладке «Модели».</span>'}
        </div>
        <span class="hint">Получатель увидит только названия. ID, адрес API и ключ в интерфейсе не показываются.</span>
      </div>
    </div>`,
    footer: `<button type="button" class="btn" data-close>Закрыть</button><span class="spacer"></span>
      <button type="button" class="btn btn--primary" data-share-copy-all>${icon('copy', 15)} Скопировать ссылку</button>`,
  });

  const input = modal.root.querySelector('#shareLink');
  const hint = modal.root.querySelector('#shareHint');
  const allBox = modal.root.querySelector('#shareAll');

  const rebuild = async () => {
    // Пустой выбор означает «все модели»: ссылка без списка ничего не
    // ограничивает, и человек получит доступ ко всему провайдеру. Это надо
    // сказать явно, чтобы пустой список не выглядел ошибкой.
    const unrestricted = picked.size === 0;
    const chosen = unrestricted ? [] : models.filter((m) => picked.has(m.id));
    const res = await buildInviteLink({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: parseExtraHeaders(provider.extraHeaders),
      name: provider.name,
      models: chosen,
      origin: location.origin + location.pathname,
    });
    link = res.url;
    tooLong = res.tooLong;
    input.value = link;
    if (unrestricted) {
      hint.textContent = `Модели не выбраны — в ссылку попадут все модели провайдера. Ссылка ${res.length} символов.`;
      hint.style.color = 'var(--warning, var(--accent))';
      return;
    }
    hint.textContent = tooLong
      ? `Ссылка получилась длинной (${res.length} символов) и может не пройти в некоторых мессенджерах. Уберите часть моделей.`
      : `Ссылка ${res.length} символов. Открытого URL и ключа в ней нет: данные зашифрованы и лежат в # после адреса, поэтому не попадают на сервер.`;
    hint.style.color = tooLong ? 'var(--danger)' : '';
  };

  const syncChecks = () => {
    modal.root.querySelectorAll('[data-share-model]').forEach((box) => {
      box.checked = picked.has(box.dataset.shareModel);
    });
    allBox.checked = models.length > 0 && picked.size === models.length;
  };

  modal.root.querySelectorAll('[data-share-model]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) picked.add(box.dataset.shareModel);
      else picked.delete(box.dataset.shareModel);
      syncChecks();
      rebuild();
    });
  });

  allBox.addEventListener('change', () => {
    if (allBox.checked) models.forEach((m) => picked.add(m.id));
    else picked.clear();
    syncChecks();
    rebuild();
  });

  const copy = async () => {
    const ok = await copyText(link);
    toast(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', ok ? 'ok' : 'error');
  };
  modal.root.querySelector('[data-copy-link]').addEventListener('click', copy);
  modal.root.querySelector('[data-share-copy-all]').addEventListener('click', copy);

  rebuild();
  return modal;
}

function renderPane(id, d, view, pview) {
  if (id === 'provider') return paneProvider(d, pview);
  if (id === 'models') return paneModels(d, view, pview);
  if (id === 'context') return paneContext(d);
  if (id === 'search') return paneSearch(d);
  if (id === 'look') return paneLook(d);
  if (id === 'data') return paneData(d);
  return '';
}

function paneProvider(d, pview) {
  const providers = Array.isArray(d.providers) ? d.providers : [];
  const open = (pview && pview.open) || '';
  const adding = !!(pview && pview.adding);
  const modelsOf = (id) => (d.models || []).filter((m) => m.providerId === id && m.id);

  return `<h3>Подключение к API</h3>
  <p class="pane-desc">Можно подключить несколько провайдеров: свой ключ у каждого. Модели из разных подключений видны в одном выборе.</p>

  ${
    providers.length
      ? `<div class="prov-list">
    ${providers
      .map((p) =>
        providerCard(p, open === p.id, modelsOf(p.id), adding, (pview && pview.status && pview.status[p.id]) || null),
      )
      .join('')}
  </div>`
      : `<div class="settings-block settings-block--empty">
          <h4>${icon('link', 14)} Нет ни одного подключения</h4>
          <p class="tip" style="margin:0 0 10px;line-height:1.65">Добавьте провайдера — вставьте адрес API и ключ. Или откройте ссылку-приглашение, которую вам прислали.</p>
        </div>`
  }

  ${
    adding
      ? `<form class="settings-block prov-add" data-new-provider data-preset="custom">
          <h4>${icon('plus', 14)} Новый провайдер</h4>
          <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:12px">
            ${PROVIDERS.map(
              (p) =>
                `<button type="button" class="chip" data-new-preset="${p.id}">${escapeAttr(p.name)}</button>`,
            ).join('')}
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Название</label>
              <input class="input" name="newName" placeholder="Например, OpenRouter" value="">
            </div>
            <div class="field">
              <label>URL API</label>
              <input class="input mono" name="newBaseUrl" id="newProviderBaseUrl" placeholder="https://api.example.com/v1" spellcheck="false">
            </div>
            <div class="field">
              <label>API-ключ</label>
              <div style="display:flex;gap:6px">
                <input class="input mono" name="newApiKey" type="password" placeholder="sk-…" autocomplete="off" spellcheck="false">
                <button type="button" class="icon-btn" data-toggle-key="#newProviderKey" aria-label="Показать ключ">${icon(
                  'eye',
                  16,
                )}</button>
              </div>
            </div>
            <div class="field">
              <label>Дополнительные заголовки</label>
              <textarea class="textarea mono" name="newHeaders" rows="2" spellcheck="false" placeholder="HTTP-Referer: https://example.com"></textarea>
            </div>
          </div>
          <div class="row" style="margin-top:12px;flex-wrap:wrap">
            <button type="submit" class="btn btn--sm btn--primary">${icon('check', 14)} Добавить</button>
            <button type="button" class="btn btn--sm" data-cancel-add-provider>Отмена</button>
          </div>
        </form>`
      : `<button type="button" class="btn btn--sm btn--block" data-add-provider>${icon('plus', 14)} Добавить провайдера</button>`
  }

  <div class="settings-block" style="margin-top:14px">
    <h4>${icon('link', 14)} Поделиться доступом</h4>
    <p class="tip" style="margin:0 0 10px;line-height:1.65">Ссылка передаёт получателю подключение без открытого URL и ключа. Можно разрешить только часть моделей — человек увидит их названия, но не адрес и не ключ.</p>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      ${(d.providers || [])
        .map(
          (p) =>
            `<button type="button" class="chip" data-share-provider="${escapeAttr(p.id)}">${icon(
              'link',
              13,
            )} ${escapeAttr(p.name)}</button>`,
        )
        .join('')}
    </div>
  </div>`;
}

/** Карточка одного провайдера: компактная строка или раскрытая форма. */
function providerCard(p, open, models, adding, status) {
  const on = p.enabled !== false;
  const enabledModels = models.filter((m) => m.enabled !== false).length;
  const specs = [
    providerHost(p),
    models.length ? `${enabledModels} из ${models.length} моделей` : 'модели не загружены',
    p.restricted ? 'по ссылке' : '',
  ].filter(Boolean);

  return `<div class="prov-card${open ? ' is-open' : ''}${on ? '' : ' is-off'}">
    <div class="prov-card__head" data-provider-toggle="${escapeAttr(p.id)}">
      <label class="switch prov-card__switch" title="${on ? 'Выключить провайдера' : 'Включить провайдера'}">
        <input type="checkbox" data-provider-enabled="${escapeAttr(p.id)}" ${on ? 'checked' : ''}>
        <span class="track"></span>
      </label>
      <span class="prov-card__title">
        <strong>${escapeAttr(p.name || 'Провайдер')}</strong>
        <span class="prov-card__specs">${escapeAttr(specs.join(' · '))}</span>
      </span>
      ${
        p.restricted
          ? `<span class="badge" title="Добавлен по ссылке: набор моделей ограничен">по ссылке</span>`
          : ''
      }
      <button type="button" class="model-row__chevron" aria-label="${
        open ? 'Свернуть' : 'Показать настройки'
      }" tabindex="-1">${icon(open ? 'chevronDown' : 'chevronRight', 15)}</button>
      <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-del-provider="${escapeAttr(
        p.id,
      )}" title="Удалить провайдера">${icon('trash', 14)}</button>
    </div>
    ${
      open
        ? `<div class="prov-card__body">
            <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
              ${PROVIDERS.map(
                (x) =>
                  `<button type="button" class="chip ${x.id === p.preset ? 'is-active' : ''}" data-provider-preset="${x.id}" data-provider-for="${escapeAttr(
                    p.id,
                  )}">${escapeAttr(x.name)}</button>`,
              ).join('')}
            </div>
            <div class="form-grid">
              <div class="field">
                <label>Название</label>
                <input class="input" data-provider-field="name" data-provider-id="${escapeAttr(p.id)}" value="${escapeAttr(
                  p.name || '',
                )}" placeholder="Провайдер">
              </div>
              <div class="field">
                <label>URL API</label>
                <input class="input mono" data-provider-field="baseUrl" data-provider-id="${escapeAttr(
                  p.id,
                )}" value="${escapeAttr(p.baseUrl || '')}" placeholder="https://api.example.com/v1" spellcheck="false">
                <span class="hint">Без /chat/completions — клиент добавит его сам.</span>
              </div>
              <div class="field">
                <label>API-ключ</label>
                <div style="display:flex;gap:6px">
                  <input class="input mono" id="key-${escapeAttr(p.id)}" type="password" data-provider-field="apiKey" data-provider-id="${escapeAttr(
                    p.id,
                  )}" value="${escapeAttr(p.apiKey || '')}" placeholder="sk-…" autocomplete="off" spellcheck="false">
                  <button type="button" class="icon-btn" data-toggle-key="#key-${escapeAttr(p.id)}" aria-label="Показать ключ">${icon(
                    'eye',
                    16,
                  )}</button>
                </div>
                <span class="hint">Ключ хранится в localStorage этого браузера и отправляется только на этот URL.</span>
              </div>
              <div class="field">
                <label>Дополнительные заголовки</label>
                <textarea class="textarea mono" rows="2" data-provider-field="extraHeaders" data-provider-id="${escapeAttr(
                  p.id,
                )}" spellcheck="false" placeholder="HTTP-Referer: https://example.com">${html(p.extraHeaders || '')}</textarea>
              </div>
            </div>
            <label class="toggle-row" style="border-top:0;padding-top:4px">
              <span class="toggle-row__text"><strong>Потоковые ответы</strong><span>Показывать текст по мере генерации</span></span>
              <span class="switch"><input type="checkbox" data-provider-stream="${escapeAttr(p.id)}" ${
                p.stream !== false ? 'checked' : ''
              }><span class="track"></span></span>
            </label>
            <div class="row" style="margin-top:8px;flex-wrap:wrap;align-items:center">
              <button type="button" class="btn btn--sm" data-test="${escapeAttr(p.id)}">${icon(
                'download',
                14,
              )} Проверить и загрузить модели</button>
              <span class="tip" data-test-status="${escapeAttr(p.id)}" style="${
                status ? `color:${escapeAttr(status.color || '')}` : ''
              }">${escapeAttr(status ? status.text : '')}</span>
            </div>
            <span class="hint" style="display:block;margin-top:6px">Запрос к /models. Модели появятся на вкладке «Модели» выключенными.</span>
          </div>`
        : ''
    }
  </div>`;
}

function paneModels(d, view, pview) {
  const providers = Array.isArray(d.providers) ? d.providers : [];
  const preset = PROVIDERS.find((p) => p.id === (providers[0] && providers[0].preset));
  const rec = preset && preset.models ? preset.models : [];
  const list = d.models || [];
  const withId = list.filter((m) => m.id);
  const enabledCount = withId.filter((m) => m.enabled !== false).length;
  const q = String((view && view.query) || '')
    .trim()
    .toLowerCase();
  const expanded = (view && view.expanded) || new Set();

  // Поиск фильтрует по имени и ID: в списке из сотни моделей иначе не найти.
  const visible = list
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !q || `${m.name || ''} ${m.id || ''}`.toLowerCase().includes(q));

  // Провайдер у модели: подписываем строку, когда подключений несколько.
  const providerOf = (m) => providers.find((p) => p.id === m.providerId) || providers[0] || null;
  const multi = providers.length > 1;

  return `<h3>Модели</h3>
  <p class="pane-desc">Модели всех подключений в одном списке. Включённые видны в чате, выключенные остаются под рукой.</p>
  ${
    withId.length
      ? ''
      : `<div class="settings-block settings-block--empty">
          <h4>${icon('cpu', 14)} Пока нет ни одной модели</h4>
          <p class="tip" style="margin:0 0 10px;line-height:1.65">Нажмите «Проверить и загрузить модели» на вкладке «Подключение» — список придёт из API. Либо добавьте модель вручную.</p>
        </div>`
  }
  ${
    withId.length
      ? `<div class="model-tools">
          <label class="model-all">
            <span class="switch"><input type="checkbox" data-toggle-all-models ${
              enabledCount === withId.length && withId.length ? 'checked' : ''
            }><span class="track"></span></span>
            <span class="model-all__text">
              <strong>Все модели</strong>
              <span>Включено ${enabledCount} из ${withId.length}</span>
            </span>
          </label>
          <div class="model-search">
            ${icon('search', 14)}
            <input class="input" type="search" data-model-search placeholder="Поиск по названию или ID" value="${escapeAttr(
              (view && view.query) || '',
            )}" spellcheck="false">
          </div>
        </div>`
      : ''
  }
  <div class="model-editor">
    ${
      visible.length
        ? visible
            .map(({ m, i }) => modelRow(m, i, expanded.has(i), multi ? providerOf(m) : null, providers))
            .join('')
        : withId.length
          ? `<div class="model-empty-note">Ничего не нашлось. Измените запрос поиска.</div>`
          : ''
    }
  </div>
  <div class="row" style="margin-top:12px;flex-wrap:wrap">
    <button type="button" class="btn btn--sm" data-add-model>${icon('plus', 14)} Добавить модель</button>
    <button type="button" class="btn btn--sm" data-open-provider>${icon('link', 14)} К подключениям</button>
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

/**
 * Компактная строка модели: тумблер, имя и раскрытие характеристик.
 *
 * Показывать сразу все поля у сотни моделей бессмысленно — список занимал
 * экраны. Поэтому по умолчанию видно только имя, а поля появляются по клику.
 */
function modelRow(m, i, open, provider, allProviders) {
  const providers = allProviders || [];
  const on = m.enabled !== false;
  const specs = [
    provider ? providerLabel(provider) : '',
    m.context ? `${formatCompact(m.context)} контекст` : '',
    m.priceIn || m.priceOut ? `${Number(m.priceIn) || 0} / ${Number(m.priceOut) || 0} ₽` : '',
    m.tools === false ? 'без инструментов' : '',
    effortsOf(m).length ? `усилия: ${effortsOf(m).join(', ')}` : '',
  ].filter(Boolean);

  return `<div class="model-row${m.id ? '' : ' model-row--new'}${on ? '' : ' is-off'}${
    open ? ' is-open' : ''
  }" data-model-row="${i}">
    <div class="model-row__head" data-model-toggle="${i}">
      <label class="switch model-row__switch" title="${on ? 'Выключить модель' : 'Включить модель'}">
        <input type="checkbox" data-model-enabled="${i}" ${on ? 'checked' : ''}>
        <span class="track"></span>
      </label>
      <span class="model-row__title">
        <strong>${escapeAttr(m.name || m.id || 'Новая модель')}</strong>
        ${specs.length && !open ? `<span class="model-row__specs">${escapeAttr(specs.join(' · '))}</span>` : ''}
        ${!m.id ? '<span class="model-row__specs">укажите ID</span>' : ''}
      </span>
      <button type="button" class="model-row__chevron" aria-label="${open ? 'Свернуть' : 'Показать характеристики'}" tabindex="-1">${icon(
        open ? 'chevronDown' : 'chevronRight',
        15,
      )}</button>
      <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-del-model="${escapeAttr(
        m.id,
      )}" title="Удалить модель">${icon('trash', 14)}</button>
    </div>
    ${
      open
        ? `<div class="model-row__body">
    <div class="form-row">
      <div class="field">
        <label>Провайдер</label>
        ${
          // Модели, полученные по ссылке, нельзя переносить к другому
          // подключению: ключ принадлежит отправителю.
          provider && provider.restricted
            ? `<input class="input" value="${escapeAttr(provider.name || 'Провайдер')}" readonly>`
            : `<select class="input select" data-model-field="providerId" data-model-row="${i}">
          ${providers
            .map(
              (p) =>
                `<option value="${escapeAttr(p.id)}" ${
                  (m.providerId || (providers[0] && providers[0].id)) === p.id ? 'selected' : ''
                }>${escapeAttr(p.name || 'Провайдер')}</option>`,
            )
            .join('')}
        </select>`
        }
      </div>
      <div class="field">
        <label>Показываемое имя</label>
        <input class="input" data-model-field="name" data-model-row="${i}" value="${escapeAttr(m.name)}">
      </div>
    </div>
    ${
      // ID модели показываем только для собственных подключений: в ссылке
      // передаются одни названия, и получатель не должен видеть внутренние ID.
      provider && provider.restricted
        ? ''
        : `<div class="form-row">
      <div class="field">
        <label>ID модели</label>
        <input class="input mono" data-model-field="id" data-model-row="${i}" list="modelsDatalist" spellcheck="false" value="${escapeAttr(
          m.id,
        )}" placeholder="provider/model-name">
      </div>
    </div>`
    }
    <div class="form-row model-row__nums">
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
        </div>`
        : ''
    }
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
