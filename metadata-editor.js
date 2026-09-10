// Inline key/value editor for a download's metadata. Fetchr replaces the whole
// metadata object on `download::update`, so the editor always submits every row.

function createMetadataEditor(metadata, { pageMetadata = {}, saveLabel = 'Save', onSave, onCancel }) {
  const editor = document.createElement('div');
  editor.className = 'metadata-editor';

  const rows = document.createElement('div');
  rows.className = 'metadata-rows';
  editor.appendChild(rows);

  const addRow = (key = '', value = '') => {
    const row = document.createElement('div');
    row.className = 'metadata-row';

    const keyEl = document.createElement('input');
    keyEl.type = 'text';
    keyEl.placeholder = 'key';
    keyEl.value = key;

    const valueEl = document.createElement('input');
    valueEl.type = 'text';
    valueEl.placeholder = 'value';
    valueEl.value = value;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-sm btn-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.onclick = () => row.remove();

    row.append(keyEl, valueEl, removeBtn);
    rows.appendChild(row);
    return row;
  };

  const setRow = (key, value) => {
    const existing = [...rows.querySelectorAll('.metadata-row')].find((r) => r.children[0].value.trim() === key);
    if (existing) existing.children[1].value = value;
    else addRow(key, value);
  };

  const collect = () => {
    const out = {};
    for (const row of rows.querySelectorAll('.metadata-row')) {
      const key = row.children[0].value.trim();
      const value = row.children[1].value.trim();
      if (key && value) out[key] = value;
    }
    return out;
  };

  for (const [key, value] of Object.entries(metadata)) addRow(key, value);

  const error = document.createElement('p');
  error.className = 'manual-error';
  error.style.display = 'none';

  const actions = document.createElement('div');
  actions.className = 'metadata-actions';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm btn-secondary';
  addBtn.textContent = '+ Add';
  addBtn.onclick = () => addRow().children[0].focus();
  actions.appendChild(addBtn);

  if (Object.keys(pageMetadata).length > 0) {
    const pageBtn = document.createElement('button');
    pageBtn.className = 'btn btn-sm btn-secondary';
    pageBtn.textContent = 'Use page tags';
    pageBtn.title = Object.entries(pageMetadata)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    pageBtn.onclick = () => {
      for (const [key, value] of Object.entries(pageMetadata)) setRow(key, value);
    };
    actions.appendChild(pageBtn);
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  actions.appendChild(spacer);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = onCancel;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-sm btn-download';
  saveBtn.textContent = saveLabel;
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    error.style.display = 'none';
    try {
      await onSave(collect());
    } catch (e) {
      error.textContent = e.message ?? 'Update failed';
      error.style.display = 'block';
      saveBtn.disabled = false;
    }
  };

  actions.append(cancelBtn, saveBtn);
  editor.append(actions, error);

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
    if (e.key === 'Escape') onCancel();
  });

  return editor;
}
