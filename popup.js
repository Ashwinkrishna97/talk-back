const keyInput = document.getElementById('key');
const status = document.getElementById('status');

chrome.storage.local.get('anthropicApiKey', (data) => {
  if (data.anthropicApiKey) keyInput.value = data.anthropicApiKey;
});

document.getElementById('save').addEventListener('click', () => {
  const key = keyInput.value.trim();
  chrome.storage.local.set({ anthropicApiKey: key }, () => {
    status.textContent = key ? 'Saved.' : 'Key cleared.';
    setTimeout(() => (status.textContent = ''), 1500);
  });
});