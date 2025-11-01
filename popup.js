document.addEventListener('DOMContentLoaded', initDownloadsUpdater);

const app = document.getElementById('app');
const linksSection = document.getElementById('links');
const downloadsSection = document.getElementById('downloads');

let API_URL;
let API_KEY;
let previousLinks = new Set(); // Add state management for links

async function initDownloadsUpdater() {
    try {
        const { apiUrl, apiKey } = await getConfig();
        if (!apiUrl || !apiKey) {
            displayMessage(app, 'Please setup before use.');
            return;
        }
        API_URL = apiUrl;
        API_KEY = apiKey;

        updateDownloads();
        setInterval(updateDownloads, 3000);

        linksDetection();
        setInterval(linksDetection, 3000);
    } catch (error) {
        displayMessage(app, 'Error while fetching config: ' + error.message);
    }
}


function displayMessage(element, message) {
    element.innerHTML = '';
    element.textContent = message;
}

function humanFileSize(size) {
    const i = size === 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024));
    const value = parseFloat((size / Math.pow(1024, i)).toFixed(2));
    const unit = ['B', 'KB', 'MB', 'GB', 'TB'][i];
    return { value, unit };
}

function extractOneFichierId(url) {
    const match = url.match(/\?([^&]+)/);
    return match ? match[1] : null;
}

function getConfig() {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.get(['apiUrl', 'apiKey'], items => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            resolve(items);
        });
    });
}

async function updateDownloads() {
    try {
        const data = await fetchDownloads();
        renderDownloads(data);
    } catch (error) {
        console.error('Error:', error);
        displayMessage(downloadsSection, 'Error while fetching downloads. ' + JSON.stringify(error));
    }
}

function executeInCurrentTab(func) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs.length) {
                return reject(new Error('No active tab found'));
            }
            const tabId = tabs[0].id;

            chrome.scripting.executeScript(
                {
                    target: { tabId },
                    func
                },
                (results) => {
                    if (chrome.runtime.lastError) {
                        return reject(chrome.runtime.lastError);
                    }
                    if (!results || !results.length) {
                        return reject(new Error('No result from executeScript'));
                    }
                    resolve(results[0].result || []);
                }
            );
        });
    });
}


async function linksDetection() {
    let links = await executeInCurrentTab(() => {
        const anchors = [...document.querySelectorAll('a[href*="1fichier"]')];
        return anchors.map(a => a.href);
    });

    // Convert current links to Set for efficient comparison
    const currentLinks = new Set(links);

    // Check if there are any changes
    const hasChanges = links.length !== previousLinks.size ||
        links.some(link => !previousLinks.has(link));

    if (hasChanges) {
        renderLinks(links);
        previousLinks = currentLinks;
    }
}

async function fetchDownloads() {
    const response = await fetch(`${API_URL}/downloads`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

async function download(url) {
    const response = await fetch(`${API_URL}/downloads`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY
        },
        body: JSON.stringify({ url })
    });
    if (!response.ok) {
        let errorMessage = `HTTP error: ${response.status} - ${response.statusText}`;
        try {
            const errorData = await response.json();
            errorMessage = errorData.message || errorMessage;
        } catch (e) {
            const errorText = await response.text();
            if (errorText) errorMessage += `\n${errorText}`;
        }
        throw new Error(errorMessage);
    }
    return response.json();
}

async function fetchFileInfo(url) {
    await new Promise(resolve => setTimeout(resolve, 3000)); // Ensure async context

    const response = await fetch(`${API_URL}/infos?${new URLSearchParams({
        url
    })}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

async function cancelDownload(id) {
    const response = await fetch(`${API_URL}/downloads/${id}`, {
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function renderList(list, container, createItem) {
    container.innerHTML = '';
    if (!list || list.length === 0) {
        displayMessage(container, 'No data.');
        return;
    }
    list.forEach(item => {
        container.appendChild(createItem(item));
    });
}

function renderLinks(links) {
    renderList(links, linksSection, createLinkItem);
}

function renderDownloads(downloads) {
    renderList(downloads, downloadsSection, createDownloadItem);
}

function createLinkItem(link) {
    const linkId = extractOneFichierId(link);
    if (!linkId) return;

    const item = document.createElement('div');
    item.className = 'link-item';

    // Create a loading state
    const fileNameSpan = document.createElement('span');
    fileNameSpan.textContent = `ID: ${linkId} `;
    fileNameSpan.title = `ID: ${linkId}`; // Tooltip au survol
    item.appendChild(fileNameSpan);

    // Fetch file info
    fetchFileInfo(`https://1fichier.com/?${linkId}`)
        .then(fileInfo => {
            fileNameSpan.textContent = fileInfo.fileName || `ID: ${linkId} `;
            fileNameSpan.title = fileInfo.fileName || `ID: ${linkId}`; // Update tooltip
        }).catch();

    const btn = document.createElement('button');
    btn.textContent = 'Download';
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
            await download(`https://1fichier.com/?${linkId}`);
            btn.textContent = 'Done';
        } catch (error) {
            btn.textContent = `Error`;
            setTimeout(() => {
                btn.textContent = 'Download';
                btn.disabled = false;
            }, 1500);
        }
    });

    item.appendChild(btn);
    return item;
}

function createDownloadItem(download) {
    const downloadItem = document.createElement('div');
    downloadItem.className = 'download-item';

    const contentDiv = document.createElement('div');
    const { value: downloadedValue, unit: downloadedUnit } = humanFileSize(download.downloaded);

    let content = `<strong class="download-name" title="${download.fileName}">${download.fileName}</strong><br>Status: ${download.status}<br>`;

    if (download.size) {
        const { value: sizeValue, unit: sizeUnit } = humanFileSize(download.size);
        const percent = ((download.downloaded / download.size) * 100).toFixed(2);
        content += `Size: ${sizeValue} ${sizeUnit} - Progress: ${percent}%`;

        // Add progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        const progressFill = document.createElement('div');
        progressFill.className = 'progress-fill';
        progressFill.style.width = `${percent}%`;
        progressBar.appendChild(progressFill);
        downloadItem.appendChild(progressBar);
    } else {
        content += `Downloaded: ${downloadedValue} ${downloadedUnit}`;
    }

    contentDiv.innerHTML = content;
    downloadItem.appendChild(contentDiv);

    const deleteButton = document.createElement('button');
    deleteButton.className = 'delete-button';
    deleteButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
    </svg>`;
    deleteButton.title = 'Cancel download';
    deleteButton.addEventListener('click', async () => {
        try {
            deleteButton.disabled = true;
            await cancelDownload(download.id);
            downloadItem.remove();
        } catch (error) {
            console.error('Error deleting download:', error);
            deleteButton.disabled = false;
        }
    });

    downloadItem.appendChild(deleteButton);
    return downloadItem;
}