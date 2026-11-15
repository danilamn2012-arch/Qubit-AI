/**
 * Карточки виртуальных файлов, просмотр кода, скачивание.
 * Пользователь не видит код в чате — только карточку с именем файла.
 */

import { icon } from './icons.js';
import { escapeHtml, highlight } from './markdown.js';
import { openModal, copyText, download, toast } from './modals.js';
import { state, bus, store } from './state.js';
import { openPreview } from './preview.js';

const LANG = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  json: 'json',
  md: 'markdown',
  txt: 'text',
  svg: 'svg',
  py: 'python',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  jsx: 'jsx',
};

export function extOf(path) {
  const m = String(path || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(path) {
  return String(path || '').split('/').pop();
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} Б`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(v / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** Размер и число строк без хранения самого текста в сообщении. */
export function fileStats(content) {
  const text = String(content || '');
  return { bytes: new Blob([text]).size, lines: text.split('\n').length };
}

function lineCount(text) {
  return String(text || '').split('\n').length;
}

/** Можно ли открыть файл в предпросмотре. */
export function isPreviewable(path) {
  return /\.(html?|md|svg|txt)$/i.test(String(path || ''));
}

const STATUS_LABEL = {
  created: 'создан',
  changed: 'обновлён',
  edited: 'изменён',
  deleted: 'удалён',
  read: 'прочитан',
};

/**
 * Размер и число строк файла.
 *
 * В сообщении они лежат в `file.bytes` / `file.lines`. У старых сообщений этих
 * полей нет — раньше в историю сохраняли только путь и статус, и карточка
 * упорно писала «0 Б · 0 стр.». Тогда берём данные из уже загруженного списка
 * файлов чата, а если и там нет — считаем по содержимому.
 */
function statsOf(file) {
  if (file.bytes != null && file.lines != null) return { bytes: file.bytes, lines: file.lines };
  if (typeof file.content === 'string' && file.content) return fileStats(file.content);

  const path = file.path || '';
  const rec = (state.files || []).find((f) => f.path === path);
  if (rec && typeof rec.content === 'string') return fileStats(rec.content);

  return { bytes: file.bytes != null ? file.bytes : 0, lines: file.lines != null ? file.lines : 0 };
}

/**
 * @param {{path:string, content?:string, ext?:string, status?:string, bytes?:number, lines?:number}} file
 * @param {{compact?:boolean}} opts
 */
export function renderFileCard(file, opts = {}) {
  const path = file.path || '';
  const ext = (file.ext || extOf(path)).toUpperCase() || 'FILE';
  const status = file.status || 'created';
  // В сообщении храним только размер и число строк: полный текст файла уже
  // лежит в хранилище, дублировать его в истории чата незачем — на этом
  // раздувался контекст (сотни тысяч токенов на одну правку).
  const { bytes, lines } = statsOf(file);
  const meta =
    status === 'deleted'
      ? 'Файл удалён'
      : [formatBytes(bytes), `${lines} стр.`, STATUS_LABEL[status] || 'обновлён'].join(' · ');
  const previewBtn =
    status !== 'deleted' && /\.html?$/i.test(path)
      ? `<button type="button" class="icon-btn icon-btn--sm" data-preview-path="${escapeHtml(
          path,
        )}" title="Открыть предпросмотр" aria-label="Предпросмотр ${escapeHtml(path)}">${icon('eye', 16)}</button>`
      : '';
  return `<div class="tool-card${opts.compact ? ' tool-card--inline' : ''}">
    <div class="tool-card__main">
      <span class="tool-card__ext">${escapeHtml(ext)}</span>
      <button type="button" class="tool-card__info" data-file-path="${escapeHtml(path)}">
        <span class="tool-card__name">${escapeHtml(baseName(path))}</span>
        <span class="tool-card__meta">${escapeHtml(meta)}</span>
      </button>
      <div class="tool-card__actions">
        ${previewBtn}
        <button type="button" class="icon-btn icon-btn--sm" data-copy-file="${escapeHtml(path)}" title="Скопировать код" aria-label="Скопировать код">${icon(
          'copy',
          15,
        )}</button>
        <button type="button" class="icon-btn icon-btn--sm" data-download="${escapeHtml(path)}" title="Скачать" aria-label="Скачать">${icon(
          'download',
          15,
        )}</button>
      </div>
    </div>
  </div>`;
}

/** Мелкая плашка для инструментов чтения/поиска. */
export function renderToolChip(tool, result) {
  const name = tool.name || 'tool';
  const labels = {
    read_file: 'Прочитан файл',
    list_files: 'Просмотр файлов',
    web_search: 'Веб-поиск',
    delete_file: 'Удаление файла',
  };
  if (name === 'delete_file') {
    const path = tool.args?.path || '';
    return renderFileCard({ path, content: '', status: 'deleted' }, { compact: true });
  }
  const label = labels[name] || name;
  const detail = tool.args?.path || tool.args?.query || '';

  // Ошибка инструмента должна быть видна в ленте и после завершения хода.
  // Повтор того же вызова — не поломка, а защита от цикла: показываем его
  // нейтральной плашкой, иначе лента заканчивалась пугающим красным блоком.
  if (result && result.repeated && !result.toolError) {
    return `<div class="msg__note" style="padding:8px 11px">
      ${icon('info', 14)}
      <span><b style="font-weight:600">Шаг пропущен</b>${detail ? ` · <span class="mono">${escapeHtml(String(detail)).slice(0, 90)}</span>` : ''} — этот вызов уже выполнялся с теми же аргументами</span>
    </div>`;
  }
  if (result && result.error) {
    return `<div class="alert">${icon('info', 14)} <span>${escapeHtml(String(result.error)).slice(0, 300)}</span></div>`;
  }

  // Для поиска показываем, сколько результатов пришло: иначе плашка выглядит
  // одинаково и при пяти ссылках, и при пустом ответе.
  const found = name === 'web_search' && result ? (result.results || []).length : null;
  const count =
    found == null
      ? ''
      : result.cached
        ? ' · повторно, из кеша'
        : found
          ? ` · найдено ${found}`
          : ' · ничего не найдено';

  return `<div class="msg__note" style="padding:8px 11px">
    ${icon(name === 'web_search' ? 'globe' : 'file', 14)}
    <span><b style="font-weight:600">${escapeHtml(label)}</b>${detail ? ` · <span class="mono">${escapeHtml(String(detail)).slice(0, 90)}</span>` : ''}${count}</span>
  </div>`;
}

/* ---------------------------- Просмотр файла ---------------------------- */

export async function openFileViewer(path) {
  if (!state.chat) return;
  const rec = await store.getFile(state.chat.id, path);
  if (!rec) {
    toast('Файл не найден', 'error');
    return;
  }
  const html = highlight(rec.content, extOf(path));
  const canPreview = isPreviewable(path);
  const modal = openModal({
    title: path,
    subtitle: `${formatBytes(new Blob([rec.content]).size)} · ${lineCount(rec.content)} строк`,
    file: true,
    body: `<pre class="code-view" data-code></pre>`,
    footer: `<button type="button" class="btn" data-copy>${icon('copy', 15)} Скопировать</button>
      <button type="button" class="btn" data-dl>${icon('download', 15)} Скачать</button>
      <span class="spacer"></span>
      ${
        canPreview
          ? `<button type="button" class="btn btn--primary" data-preview>${icon('eye', 15)} Предпросмотр</button>`
          : ''
      }`,
  });
  modal.body.classList.add('modal__body--flush');
  modal.body.querySelector('[data-code]').innerHTML = html;

  modal.root.querySelector('[data-copy]').addEventListener('click', async () => {
    if (await copyText(rec.content)) toast('Код скопирован', 'ok');
  });
  modal.root.querySelector('[data-dl]').addEventListener('click', () => {
    download(baseName(path), rec.content, 'text/plain;charset=utf-8');
  });
  const pv = modal.root.querySelector('[data-preview]');
  if (pv) {
    pv.addEventListener('click', () => {
      modal.close();
      openPreview(path);
    });
  }
}

/* ---------------------------- Список файлов ---------------------------- */

export async function openFilesModal() {
  if (!state.chat) {
    toast('Сначала создайте чат');
    return;
  }
  const files = await store.listFiles(state.chat.id);
  const listHtml = files.length
    ? `<div style="display:flex;flex-direction:column;gap:8px">${files
        .map((f) =>
          renderFileCard({
            path: f.path,
            content: f.content,
            status: 'changed',
          }),
        )
        .join('')}</div>`
    : `<div class="empty" style="min-height:220px;padding:32px 0;text-align:center;align-items:center">
        <h1 style="font-size:19px;margin-bottom:6px">Файлов пока нет</h1>
        <p style="font-size:13px;max-width:36ch">Попросите нейросеть создать страницу или файл — они появятся здесь.</p>
      </div>`;

  openModal({
    title: 'Файлы проекта',
    subtitle: `${files.length} ${plural(files.length, ['файл', 'файла', 'файлов'])} · ${state.chat.title}`,
    wide: true,
    body: listHtml,
    footer: `<span class="tip">${icon('info', 14)} Файлы хранятся в этом браузере и не синхронизируются.</span>`,
  });
}

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export { plural };
