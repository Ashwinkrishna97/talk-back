const keyInput = document.getElementById('key');
const saveBtn = document.getElementById('save');

function setMode(mode) {
  saveBtn.dataset.mode = mode;
  saveBtn.textContent = mode === 'clear' ? 'Clear' : 'Save';
}

chrome.storage.local.get('anthropicApiKey', (data) => {
  if (data.anthropicApiKey) {
    keyInput.value = data.anthropicApiKey;
    setMode('clear');
  } else {
    setMode('save');
  }
});

saveBtn.addEventListener('click', () => {
  if (saveBtn.dataset.mode === 'clear') {
    chrome.storage.local.remove('anthropicApiKey', () => {
      keyInput.value = '';
      saveBtn.textContent = 'Key cleared';
    });
  } else {
    const key = keyInput.value.trim();
    chrome.storage.local.set({ anthropicApiKey: key }, () => {
      saveBtn.textContent = 'Saved';
    });
  }
});