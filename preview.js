/**
 * Полноэкранный предпросмотр HTML.
 * iframe изолирован: sandbox без allow-same-origin, сборка документа в srcDoc.
 * Для относительных ссылок на другие файлы проекта подставляем blob-URL.
 */

import { icon } from './icons.js';
import { state, store } from './state.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

let overlay = null;
let blobUrls = [];

function revokeBlobs() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}

/**
 * Собирает документ для iframe: встраивает css/js из проекта по относительным путям.
 */
async function buildDocument(path) {
  const rec = await store.getFile(state.chat.id, path);
  if (!rec) throw new Error('Файл не найден');
  let html = rec.content;

  if (/\.md$/i.test(path)) {
    return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.7;color:#26241f;background:#fff}
      pre{background:#f3f0e9;padding:14px;border-radius:10px;overflow:auto}code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #e4dfd3;padding:8px 10px;text-align:left}blockquote{border-left:3px solid #c15f3c;margin:0;padding-left:14px;color:#55514a}</style>
      </head><body>${renderMarkdown(html)}</body></html>`;
  }

  const files = await store.listFiles(state.chat.id);

  // Заменяем ссылки на локальные css/js на инлайн-содержимое
  for (const f of files) {
    if (/\.css$/i.test(f.path)) {
      const re = new RegExp(`<link[^>]+href=["'](?:\\/?\\.?\\/?)*${escapeRe(f.path)}["'][^>]*>`, 'gi');
      html = html.replace(re, `<style>\n${f.content}\n</style>`);
    }
    if (/\.js$/i.test(f.path)) {
      const re = new RegExp(`<script[^>]+src=["'](?:\\/?\\.?\\/?)*${escapeRe(f.path)}["'][^>]*>\\s*</script>`, 'gi');
      html = html.replace(re, `<script>\n${f.content}\n</script>`);
    }
  }

  // Картинки и прочие ассеты из проекта — blob
  for (const f of files) {
    if (!/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(f.path)) continue;
    const mime = f.path.match(/\.svg$/i) ? 'image/svg+xml' : 'image/' + (f.path.match(/\.(\w+)$/)[1].toLowerCase());
    const url = URL.createObjectURL(new Blob([f.content], { type: mime }));
    blobUrls.push(url);
    html = html.replace(new RegExp(`(["'(])(\\.?\\/?)${escapeRe(f.path)}(["')])`, 'g'), `$1${url}$3`);
  }

  return html;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function openPreview(path) {
  if (!state.chat) return;
  closePreview();
  overlay = document.createElement('div');
  overlay.className = 'preview';
  overlay.innerHTML = `
    <div class="preview__bar">
      <button type="button" class="btn btn--ghost" data-back>${icon('arrowLeft', 17)} Назад</button>
      <div class="preview__title">
        <strong></strong>
        <span>Предпросмотр · изолированно</span>
      </div>
      <button type="button" class="icon-btn" data-reload title="Обновить">${icon('refresh', 17)}</button>
      <button type="button" class="icon-btn" data-newtab title="Открыть в новой вкладке">${icon('arrowUpRight', 17)}</button>
      <button type="button" class="icon-btn" data-close title="Закрыть">${icon('close', 18)}</button>
    </div>
    <div class="preview__frame-wrap">
      <div class="preview__loading">Готовлю предпросмотр…</div>
      <iframe class="preview__frame" title="Предпросмотр файла" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"></iframe>
    </div>`;
  overlay.querySelector('.preview__title strong').textContent = path;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const frame = overlay.querySelector('iframe');
  const loading = overlay.querySelector('.preview__loading');

  const load = async () => {
    loading.hidden = false;
    revokeBlobs();
    try {
      const doc = await buildDocument(path);
      frame.srcdoc = doc;
    } catch (err) {
      frame.srcdoc = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:32px;color:#b4432f">
        ${escapeHtml(err.message || 'Не удалось открыть файл')}</body></html>`;
    }
  };
  frame.addEventListener('load', () => {
    loading.hidden = true;
  });
  load();

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-back]') || e.target.closest('[data-close]')) closePreview();
    if (e.target.closest('[data-reload]')) load();
    if (e.target.closest('[data-newtab]')) {
      const w = window.open('', '_blank');
      if (w) {
        buildDocument(path).then((doc) => {
          w.document.open();
          w.document.write(doc);
          w.document.close();
        });
      } else {
        frame.srcdoc && openBlobTab(frame.srcdoc);
      }
    }
  });

  document.addEventListener('keydown', onKey);
}

function openBlobTab(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  blobUrls.push(url);
  window.open(url, '_blank');
}

function onKey(e) {
  if (e.key === 'Escape') closePreview();
}

export function closePreview() {
  if (overlay) {
    overlay.remove();
    overlay = null;
    revokeBlobs();
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
  }
}

export function previewOpen() {
  return !!overlay;
}
