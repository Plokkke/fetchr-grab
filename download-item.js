// One DOM node per download, created once and patched in place on every event.
// Nothing is ever detached, so an open metadata editor (and its focus) survives updates.

const ACTIVE_STATUSES = ['downloading', 'extracting', 'resolving', 'queued', 'suspended'];
const CANCELLABLE_STATUSES = ['downloading', 'queued', 'resolving', 'suspended'];
const TERMINAL_STATUSES = ['completed', 'failed'];

function el(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, text, title, onClick) {
  const btn = el('button', className, text);
  btn.title = title;
  btn.onclick = onClick;
  return btn;
}

function createDownloadItem(dl, { onEdit, onCancel, onRemove }) {
  const item = el('div', 'download-item');
  item.dataset.id = dl.id;

  const header = el('div', 'download-header');
  header.append(
    el('span', 'download-name'),
    el('span', 'download-status'),
    button('btn btn-sm btn-edit', '✎', 'Edit metadata', () => onEdit(dl.id)),
    button('btn btn-sm btn-danger', 'Cancel', 'Cancel download', () => onCancel(dl.id)),
    button('btn btn-sm btn-remove', '✕', 'Remove', () => onRemove(dl.id)),
  );

  const bar = el('div', 'progress-bar');
  bar.appendChild(el('div', 'progress-fill'));

  const details = el('div', 'download-details');
  details.append(el('span', 'download-pct'), el('span', 'download-speed'), el('span', 'download-eta'));

  item.append(header, bar, details, el('div', 'download-metadata'));
  updateDownloadItem(item, dl);
  return item;
}

function updateDownloadItem(item, dl) {
  const q = (selector) => item.querySelector(selector);

  const name = q('.download-name');
  name.textContent = dl.fileName || 'Resolving...';
  name.title = dl.fileName || '';

  const status = q('.download-status');
  status.className = `download-status status-${dl.status}`;
  status.textContent = dl.status;

  q('.btn-edit').hidden = dl.status === 'completed';
  q('.btn-danger').hidden = !CANCELLABLE_STATUSES.includes(dl.status);
  q('.btn-remove').hidden = !TERMINAL_STATUSES.includes(dl.status);

  updateProgress(q('.progress-bar'), dl);
  updateDetails(q('.download-details'), dl);
  updateMetadataTags(q('.download-metadata'), dl.metadata);
}

function progressFillClass(dl) {
  if (dl.status === 'completed') return 'completed';
  if (dl.status === 'suspended') return 'suspended';
  if (dl.status === 'extracting') return dl.progress == null ? 'indeterminate extracting' : 'extracting';
  if (dl.status === 'downloading') return 'downloading';
  return 'indeterminate downloading';
}

function updateProgress(bar, dl) {
  bar.hidden = !ACTIVE_STATUSES.includes(dl.status) && dl.status !== 'completed';
  if (bar.hidden) return;
  const fill = bar.firstElementChild;
  fill.className = `progress-fill ${progressFillClass(dl)}`;
  const sized = ['downloading', 'extracting'].includes(dl.status) && dl.progress != null;
  fill.style.width = sized ? `${(dl.progress ?? 0) * 100}%` : '';
}

function updateDetails(details, dl) {
  const [pct, speed, eta] = details.children;
  const downloading = dl.status === 'downloading';

  pct.className = 'download-pct';
  pct.textContent = detailLabel(dl);
  speed.textContent = downloading && dl.speed ? formatSpeed(dl.speed) : '';
  eta.textContent = downloading && dl.eta ? `ETA ${formatEta(dl.eta)}` : '';
  if (dl.status === 'failed') pct.classList.add('download-error');

  details.hidden = !pct.textContent && !speed.textContent && !eta.textContent;
}

function detailLabel(dl) {
  switch (dl.status) {
    case 'downloading':
      return dl.progress != null ? `${Math.round(dl.progress * 100)}%` : '';
    case 'extracting':
      return dl.progress != null ? `Extracting ${Math.round(dl.progress * 100)}%` : 'Extracting...';
    case 'suspended':
      return `Waiting for download slot${dl.size ? ` — ${formatSize(dl.size)}` : ''}`;
    case 'failed':
      return dl.error ?? '';
    default:
      return '';
  }
}

function updateMetadataTags(wrap, metadata) {
  const serialized = JSON.stringify(metadata ?? {});
  if (wrap.dataset.metadata === serialized) return;
  wrap.dataset.metadata = serialized;
  wrap.innerHTML = '';
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) {
    wrap.appendChild(el('span', 'metadata-none', 'no metadata'));
    return;
  }
  for (const [key, value] of entries) {
    const tag = el('span', 'metadata-tag readonly', `${key}: ${value}`);
    tag.title = tag.textContent;
    wrap.appendChild(tag);
  }
}
