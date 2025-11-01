document.getElementById('save').addEventListener('click', function() {
    var apiUrl = document.getElementById('apiUrl').value;
    var apiKey = document.getElementById('apiKey').value;

    chrome.storage.sync.set({
        apiUrl: apiUrl,
        apiKey: apiKey
    }, function() {
        alert('Configuration enregistrée.');
    });
});

document.addEventListener('DOMContentLoaded', function() {
    chrome.storage.sync.get(['apiUrl', 'apiKey'], function(items) {
        document.getElementById('apiUrl').value = items.apiUrl || '';
        document.getElementById('apiKey').value = items.apiKey || '';
    });
});