/**
 * Точка входа Qubit AI: связывает состояние, UI и агентский цикл.
 */

import { state, bus, applyTheme, applyScale, watchSystemTheme, currentModel, currentEffort, hasModel, ensureChat, openChat, refreshChats, scheduleSave, saveNow, addUsage, autoTitle, reloadFiles, setBusy, getModel, persistSettings } from './state.js';
import * as store from './storage.js';
import { runTurn } from './agent.js';
import { compactHistory } from './agent.js';
import { effectiveContext } from './pricing.js';
import { initShell } from './shell.js';
import { initChat, renderChat, patchLive, clearComposer, focusComposer, scrollToBottom, refreshSendState } from './chat.js';
import { openSettings } from './settings.js';
import { openFilesModal, renderFileCard, renderToolChip } from './files.js';
import { toast, confirmDialog, closeTopModal, hasModal } from './modals.js';
import { closePreview, previewOpen } from './preview.js';

/* ------------------------------ Старт ---------------------------------- */

async function boot() {
  applyTheme(state.settings.theme);
  applyScale(state.settings.fontScale);

  initShell();
  initChat({ onSend: send, onStop: stop });

  await refreshChats();

  const params = new URLSearchParams(location.search);
  const chatId = params.get('chat');
  if (chatId) {
    await openChat(chatId);
  } else {
    const last = state.chats.find((c) => !c.pinned) || state.chats[0];
    if (last) await openChat(last.id);
    else renderChat();
  }

  bindGlobal();
  state.ready = true;
  window.__qb = { state, bus, store, runTurn };
  watchSystemTheme();

  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.style.transition = 'opacity 220ms ease';
    bootEl.style.opacity = '0';
    setTimeout(() => bootEl.remove(), 240);
  }

  // Первый запуск: подсказываем подключить API (один раз за сессию)
  let onboarded = false;
  try {
    onboarded = sessionStorage.getItem('qubit.onboarded') === '1';
  } catch {}
  if (!hasModel() && !onboarded) {
    try {
      sessionStorage.setItem('qubit.onboarded', '1');
    } catch {}
    setTimeout(() => {
      toast('Подключите API и добавьте модель — иначе отправлять некуда.', 'info');
      openSettings('provider');
    }, 500);
  }

  const canSw = 'serviceWorker' in navigator && location.protocol.startsWith('http');
  const isDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (canSw && !isDev) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ---------------------------- Глобальные биндинги ---------------------- */

function bindGlobal() {
  bus.on('open-files', () => openFilesModal());
  bus.on('open-settings', (tab) => openSettings(tab));
  bus.on('focus-composer', () => focusComposer());
  bus.on('compact-request', () => compactNow());
  bus.on('regenerate', (id) => regenerate(id));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (previewOpen()) {
        closePreview();
        return;
      }
      if (hasModal()) {
        closeTopModal();
        return;
      }
      if (document.getElementById('app').classList.contains('drawer-open')) {
        document.getElementById('app').classList.remove('drawer-open');
        document.body.style.overflow = '';
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openSettings();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newChatAndFocus();
    }
  });

  // Сохраняем при уходе со страницы
  window.addEventListener('beforeunload', () => {
    if (state.chat) saveNow();
  });
}

function newChatAndFocus() {
  import('./state.js').then(({ newChat }) => {
    newChat();
    focusComposer();
  });
}

/* ----------------------------- Отправка -------------------------------- */

async function send() {
  if (state.busy) return;
  const { promptEl } = await import('./chat.js');
  const text = promptEl.value.trim();
  if (!text && !state.attachments.length) return;

  const model = currentModel();
  if (!model || !model.id) {
    toast('Сначала добавьте модель в настройках', 'error');
    openSettings('models');
    return;
  }

  if (!state.settings.provider.baseUrl) {
    toast('Укажите URL API в настройках', 'error');
    openSettings('provider');
    return;
  }

  let chat;
  try {
    chat = await ensureChat();
  } catch (err) {
    toast('Не удалось создать чат: ' + err.message, 'error');
    return;
  }

  chat.modelId = chat.modelId || model.id;
  const userMsg = {
    id: 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    role: 'user',
    content: text,
    images: state.attachments.map((a) => ({ data: a.data, name: a.name })),
    at: Date.now(),
  };
  chat.messages.push(userMsg);
  autoTitle(text);
  clearComposer();
  state.live = { text: '', reasoning: '', status: '', tools: [] };
  bus.emit('messages:updated');
  scrollToBottom();

  const controller = new AbortController();
  setBusy(true, controller);

  try {
    await runAgentTurn(chat, model, controller.signal);
  } finally {
    state.live = null;
    setBusy(false);
    await saveNow();
    bus.emit('messages:updated');
    await reloadFiles();
  }
}

async function runAgentTurn(chat, model, signal) {
  let textBuffer = '';
  let reasoningBuffer = '';
  let active = true;

  const setLive = (patch) => {
    if (!active) return;
    state.live = { ...(state.live || { text: '', reasoning: '', tools: [], status: '' }), ...patch };
    patchLive();
  };

  try {
    await runTurn({
      chat,
      settings: state.settings,
      model,
      effort: currentEffort(),
      signal,
      events: {
        onText: (full) => {
          textBuffer = full;
          setLive({ text: full, status: '' });
        },
        onReasoning: (full) => {
          reasoningBuffer = full;
          setLive({ reasoning: full });
        },
        onStatus: (s) => setLive({ status: s }),
        onUsage: ({ in: i, out: o, estimated }) => {
          addUsage(i, o, estimated);
        },
        onTool: ({ phase, call, result }) => {
          if (phase === 'start') {
            setLive({
              tools: [
                ...((state.live && state.live.tools) || []),
                { call, card: `<div class="msg__note">${iconSpinner()} <span>${toolLabel(call.name)}: <span class="mono">${escape(
                  call.args?.path || call.args?.query || '',
                )}</span></span></div>` },
              ],
            });
          } else if (phase === 'ok' || phase === 'error') {
            setLive({
              tools: ((state.live && state.live.tools) || []).map((t) => {
                if (t.call !== call) return t;
                // Повтор — не поломка: показываем нейтрально, как в готовой ленте.
                if (result && result.repeated && !result.toolError) {
                  return { call, card: renderToolChip({ name: call.name, args: call.args }, result) };
                }
                // Результат может прийти с полем error (например, лимит поисков
                // или таймаут). Раньше такая плашка выглядела как успешная.
                if (phase === 'error' || (result && result.error)) {
                  return {
                    call,
                    card: `<div class="alert">${iconAlert()} <span>${escape(
                      (result && result.error) || 'Ошибка инструмента',
                    )}</span></div>`,
                  };
                }
                if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'append_file') {
                  const f = result.file || { path: call.args?.path, status: 'changed' };
                  return {
                    call,
                    card: renderFileCard({
                      ...f,
                      status: f.status || 'changed',
                      bytes: result.bytes,
                      lines: result.lines,
                    }),
                  };
                }
                return { call, card: renderToolChip({ name: call.name, args: call.args }, result) };
              }),
            });
          }
        },
        onCompact: () => {
          toast('История сжата, сводку можно открыть в чате');
        },
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (textBuffer && chat.messages.length) {
        chat.messages.push({
          id: 'm-' + Date.now().toString(36),
          role: 'assistant',
          content: textBuffer + '\n\n_Остановлено пользователем._',
          at: Date.now(),
          modelId: model.id,
        });
      } else {
        toast('Запрос остановлен');
      }
    } else {
      chat.messages.push({
        id: 'm-' + Date.now().toString(36),
        role: 'assistant',
        content: `**Не удалось получить ответ.**\n\n${err.message || String(err)}\n\nПроверьте URL и ключ в настройках, а также доступность API.`,
        error: true,
        at: Date.now(),
        modelId: model.id,
      });
      toast(err.message || 'Ошибка запроса', 'error');
    }
  } finally {
    active = false;
  }
}

function toolLabel(name) {
  return (
    {
      write_file: 'Создаю файл',
      edit_file: 'Правлю файл',
      read_file: 'Читаю файл',
      list_files: 'Смотрю файлы',
      delete_file: 'Удаляю файл',
      web_search: 'Ищу в интернете',
    }[name] || name
  );
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function iconSpinner() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="spin" style="flex:none"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>';
}

function iconAlert() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex:none"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>';
}

function stop() {
  if (state.controller) {
    state.controller.abort();
    toast('Остановлено');
  }
}

/* ----------------------------- Отмена/повтор --------------------------- */

async function regenerate(messageId) {
  if (!state.chat || state.busy) return;
  const idx = state.chat.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return;

  // Находим предшествующее сообщение пользователя
  let userIdx = idx;
  while (userIdx >= 0 && state.chat.messages[userIdx].role !== 'user') userIdx--;
  if (userIdx < 0) return;

  const model = currentModel();
  if (!model || !model.id) {
    toast('Сначала добавьте модель в настройках', 'error');
    openSettings('models');
    return;
  }
  const ok = await confirmDialog({
    title: 'Повторить ответ?',
    message: 'Ответ и все шаги после него будут удалены, модель сгенерирует заново.',
    confirmLabel: 'Повторить',
    danger: false,
  });
  if (!ok) return;

  state.chat.messages = state.chat.messages.slice(0, userIdx + 1);
  scheduleSave();
  state.live = { text: '', reasoning: '', tools: [], status: '' };
  bus.emit('messages:updated');

  const controller = new AbortController();
  setBusy(true, controller);
  try {
    await runAgentTurn(state.chat, model, controller.signal);
  } finally {
    state.live = null;
    setBusy(false);
    await saveNow();
    bus.emit('messages:updated');
    await reloadFiles();
  }
}

/* --------------------------- Ручное сжатие ----------------------------- */

async function compactNow() {
  if (!state.chat || state.busy) {
    toast('Сначала завершите текущий ответ');
    return;
  }
  if (!state.chat.messages.length) {
    toast('В чате пока нечего сжимать');
    return;
  }
  const model = currentModel();
  if (!model || !model.id) {
    toast('Сначала добавьте модель в настройках', 'error');
    openSettings('models');
    return;
  }
  const controller = new AbortController();
  setBusy(true, controller);
  try {
    const res = await compactHistory({
      messages: state.chat.messages,
      summary: state.chat.summary,
      model,
      settings: state.settings,
      signal: controller.signal,
      onStatus: (s) => {
        state.live = { text: '', reasoning: '', tools: [], status: s };
        patchLive();
      },
    });
    state.chat.messages = res.messages;
    state.chat.summary = res.summary;
    state.live = null;
    await saveNow();
    bus.emit('messages:updated');
    toast('Контекст сжат', 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message || 'Не удалось сжать контекст', 'error');
  } finally {
    state.live = null;
    setBusy(false);
  }
}

/* ------------------------------- Запуск -------------------------------- */

boot().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.innerHTML = `<div class="boot__inner" style="max-width:420px;text-align:center">
      <strong style="color:var(--danger)">Не удалось запустить Qubit AI</strong>
      <span style="font-size:12px">${escape(err.message || String(err))}</span>
      <button class="btn btn--primary" onclick="location.reload()">Перезагрузить</button>
    </div>`;
  }
});
