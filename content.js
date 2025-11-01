// Inject styles
const style = document.createElement('link');
style.rel = 'stylesheet';
style.type = 'text/css';
style.href = chrome.runtime.getURL('styles.css');
document.head.appendChild(style);

// SVG Icons (inline pour éviter les problèmes de chargement)
const Icons = {
    download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
    </svg>`,
    checkCircle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>`,
    xCircle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
    </svg>`,
    spinner: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spinner">
        <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
    </svg>`,
    document: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>
    </svg>`,
    chevronDown: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>
    </svg>`,
    chevronUp: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5"/>
    </svg>`,
    folder: `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/>
    </svg>`
};

let container = null;
let fileCount = 0;

// Function to create container if it doesn't exist
function createContainer() {
    if (container) return;

    container = document.createElement('div');
    container.className = 'download-button-container top-left';
    container.style.display = 'none'; // Hidden par défaut
    document.body.appendChild(container);

    // Create header
    const header = document.createElement('div');
    header.className = 'container-header';

    const title = document.createElement('div');
    title.className = 'container-title';
    title.innerHTML = `1fichier Downloader`;

    const badge = document.createElement('span');
    badge.className = 'container-badge';
    badge.id = 'file-count-badge';
    badge.textContent = '0';
    title.appendChild(badge);

    header.appendChild(title);
    container.appendChild(header);

    // Create file list container
    const fileList = document.createElement('div');
    fileList.className = 'file-list';
    fileList.id = 'file-list';
    container.appendChild(fileList);

    // Create global actions
    const actions = document.createElement('div');
    actions.className = 'global-actions';
    actions.style.display = 'none'; // Hidden par défaut
    actions.id = 'global-actions';

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'action-button primary';
    downloadAllBtn.innerHTML = `${Icons.download} Tout télécharger`;
    downloadAllBtn.onclick = downloadAll;

    actions.appendChild(downloadAllBtn);
    container.appendChild(actions);

    // Create position toggle button
    const positionToggle = document.createElement('button');
    positionToggle.className = 'position-toggle';
    positionToggle.innerHTML = Icons.chevronDown;
    positionToggle.title = 'Changer la position';
    container.appendChild(positionToggle);

    // Handle position toggle
    let isTopLeft = true;
    positionToggle.addEventListener('click', () => {
        isTopLeft = !isTopLeft;
        container.className = `download-button-container ${isTopLeft ? 'top-left' : 'bottom-left'}`;
        positionToggle.innerHTML = isTopLeft ? Icons.chevronDown : Icons.chevronUp;
    });

    // Fade in animation
    setTimeout(() => {
        container.style.display = 'block';
        container.style.animation = 'slideIn 0.3s ease-out';
    }, 100);
}

// Function to remove container
function removeContainer() {
    if (container) {
        container.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            if (container) {
                container.remove();
                container = null;
            }
        }, 300);
    }
}

// Function to extract file ID from URL
function extractFileId(url) {
    const match = url.match(/\?([^&]+)/);
    return match ? match[1] : null;
}

// Function to update file list
function updateFileList(files) {
    if (files.length === 0) {
        removeContainer();
        return;
    }

    createContainer();
    const fileList = document.getElementById('file-list');
    const badge = document.getElementById('file-count-badge');
    const actions = document.getElementById('global-actions');

    fileCount = files.length;
    badge.textContent = fileCount;

    // Show/hide global actions
    actions.style.display = fileCount > 1 ? 'flex' : 'none';

    if (files.length === 0) {
        fileList.innerHTML = `
            <div class="no-files">
                <div class="no-files-icon">${Icons.folder}</div>
                <div class="no-files-text">Aucun lien 1fichier détecté</div>
                <div class="no-files-subtitle">Les liens apparaîtront ici automatiquement</div>
            </div>
        `;
        return;
    }

    fileList.innerHTML = '';

    files.forEach((file, index) => {
        const fileItem = document.createElement('div');
        fileItem.className = 'file-item';
        fileItem.style.animationDelay = `${index * 50}ms`;

        // File icon
        const fileIcon = document.createElement('div');
        fileIcon.className = 'file-icon';
        fileIcon.innerHTML = Icons.document;
        fileItem.appendChild(fileIcon);

        // File info container
        const fileInfo = document.createElement('div');
        fileInfo.className = 'file-info';

        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = file.name || `Fichier ${extractFileId(file.url)}`;
        fileName.setAttribute('data-tooltip', file.name || file.url);

        const fileSize = document.createElement('div');
        fileSize.className = 'file-size';
        fileSize.textContent = file.size || 'Taille inconnue';

        fileInfo.appendChild(fileName);
        fileInfo.appendChild(fileSize);
        fileItem.appendChild(fileInfo);

        // Download button
        const downloadButton = document.createElement('button');
        downloadButton.className = 'download-button';
        downloadButton.innerHTML = `${Icons.download}<span>Télécharger</span>`;
        downloadButton.dataset.url = file.url;

        downloadButton.addEventListener('click', async () => {
            await downloadFile(downloadButton, file.url);
        });

        fileItem.appendChild(downloadButton);
        fileList.appendChild(fileItem);
    });
}

// Function to download a file
async function downloadFile(button, url) {
    const originalContent = button.innerHTML;
    button.innerHTML = `${Icons.spinner}<span>En cours...</span>`;
    button.disabled = true;

    try {
        const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', url: url });
        button.className = 'download-button success';
        button.innerHTML = `${Icons.checkCircle}<span>Ajouté!</span>`;

        setTimeout(() => {
            button.innerHTML = originalContent;
            button.className = 'download-button';
            button.disabled = false;
        }, 2000);
    } catch (error) {
        button.className = 'download-button error';
        button.innerHTML = `${Icons.xCircle}<span>Erreur</span>`;

        setTimeout(() => {
            button.innerHTML = originalContent;
            button.className = 'download-button';
            button.disabled = false;
        }, 2000);
    }
}

// Function to download all files
async function downloadAll() {
    const buttons = document.querySelectorAll('.download-button[data-url]');
    for (const button of buttons) {
        if (!button.disabled) {
            await downloadFile(button, button.dataset.url);
            await new Promise(resolve => setTimeout(resolve, 500)); // Delay between downloads
        }
    }
}

// Check for links periodically with deduplication
let previousLinks = new Set();

function checkForElement() {
    const links = document.querySelectorAll('a[href*="1fichier"]');
    const uniqueUrls = new Set();
    const files = [];

    Array.from(links).forEach(link => {
        if (!uniqueUrls.has(link.href)) {
            uniqueUrls.add(link.href);
            // Extract clean filename from link text or use file ID
            let fileName = link.textContent.trim();
            if (!fileName || fileName.length > 100) {
                const fileId = extractFileId(link.href);
                fileName = fileId ? `Fichier ${fileId}` : 'Fichier';
            }

            files.push({
                name: fileName,
                url: link.href,
                size: link.getAttribute('data-size') || null
            });
        }
    });

    // Check if links have changed
    const currentLinks = new Set(files.map(f => f.url));
    const hasChanges = currentLinks.size !== previousLinks.size ||
        [...currentLinks].some(url => !previousLinks.has(url));

    if (hasChanges) {
        previousLinks = currentLinks;
        updateFileList(files);
    }
}

// Initial check with delay to ensure page is loaded
setTimeout(checkForElement, 500);

// Observe DOM changes with debouncing
let debounceTimer;
const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkForElement, 200);
});

observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href']
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    observer.disconnect();
    removeContainer();
});