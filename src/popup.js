document.addEventListener('DOMContentLoaded', () => {
  const state = {
    isLoading: false,
    error: null,
    apiKey: null,
    notificationInterval: 3,
    soundEnabled: false,
    notificationsActive: true,
    customPrompt: '',
    nextNotificationTime: null
  };

  // Elements
  const notificationIntervalSpan = document.getElementById('notificationInterval');
  const soundStatusSpan = document.getElementById('soundStatus');
  const notificationStatusSpan = document.getElementById('notificationStatus');

  const editIntervalBtn = document.getElementById('editIntervalBtn');
  const toggleSoundBtn = document.getElementById('toggleSoundBtn');
  const toggleNotificationsBtn = document.getElementById('toggleNotificationsBtn');
  const editPromptBtn = document.getElementById('editPromptBtn');
  const editApiKeyBtn = document.getElementById('editApiKeyBtn');

  const intervalModal = document.getElementById('intervalModal');
  const promptModal = document.getElementById('promptModal');
  const apiKeyModal = document.getElementById('apiKeyModal');

  const intervalInput = document.getElementById('intervalInput');
  const promptInput = document.getElementById('promptInput');
  const apiKeyInput = document.getElementById('apiKeyInput');

  const saveIntervalBtn = document.getElementById('saveIntervalBtn');
  const savePromptBtn = document.getElementById('savePromptBtn');
  const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');

  // Close modal buttons
  const closeModalButtons = document.querySelectorAll('.modal-close');
  closeModalButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modalId = e.target.dataset.close;
      hideModal(modalId);
    });
  });

  // Load initial settings
  function loadInitialSettings() {
    state.isLoading = true;
    document.getElementById('loadingIndicator').style.display = 'flex';
    updateUIElements();
    
    chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
      state.isLoading = false;
      document.getElementById('loadingIndicator').style.display = 'none';
      
      if (response.success) {
        state.notificationInterval = response.settings.notificationInterval;
        state.soundEnabled = response.settings.soundEnabled;
        state.notificationsActive = response.settings.isActive;
        state.apiKey = response.settings.apiKey;
        state.customPrompt = response.settings.customPrompt || response.settings.defaultPrompt;
        state.nextNotificationTime = response.settings.nextNotificationTime;
        
        startCountdown();
      } else {
        handleError(response.error || 'Could not load settings. Please try reopening the extension');
      }
      
      updateUIElements();
    });
  }

  function updateUIElements() {
    notificationIntervalSpan.textContent = `${state.notificationInterval} minutes`;
    soundStatusSpan.textContent = state.soundEnabled ? 'Enabled' : 'Disabled';
    notificationStatusSpan.textContent = state.notificationsActive ? 'Running' : 'Stopped';
    toggleNotificationsBtn.textContent = state.notificationsActive ? 'Pause' : 'Resume';
    
    // 更新下一次通知时间和按钮状态
    const nextNotificationSpan = document.getElementById('nextNotification');
    const editNextAlertBtn = document.getElementById('editNextAlertBtn');
    
    editNextAlertBtn.disabled = !state.notificationsActive;
    editNextAlertBtn.style.opacity = state.notificationsActive ? '1' : '0.5';
    
    if (state.nextNotificationTime && state.notificationsActive) {
      const timeLeft = Math.max(0, state.nextNotificationTime - Date.now());
      const minutesLeft = Math.floor(timeLeft / 60000);
      const secondsLeft = Math.floor((timeLeft % 60000) / 1000);
      if (timeLeft <= 0) {
        nextNotificationSpan.textContent = 'Due now';
      } else if (minutesLeft > 0) {
        nextNotificationSpan.textContent = `${minutesLeft}m ${secondsLeft}s`;
      } else {
        nextNotificationSpan.textContent = `${secondsLeft}s`;
      }
    } else {
      nextNotificationSpan.textContent = state.notificationsActive ? 'Not scheduled' : 'Notifications paused';
    }
    
    // 更新 API Key 状态显示
    const apiKeyStatus = document.getElementById('apiKeyStatus');
    const editApiKeyBtn = document.getElementById('editApiKeyBtn');
    
    apiKeyStatus.textContent = state.apiKey ? 'Connected' : 'Not Set';
    editApiKeyBtn.textContent = state.apiKey ? 'Reconnect' : 'Set Key';
  }

  // Event Listeners
  editIntervalBtn.addEventListener('click', () => {
    intervalInput.value = state.notificationInterval;
    showModal('intervalModal');
  });

  saveIntervalBtn.addEventListener('click', () => {
    const interval = parseInt(intervalInput.value);
    if (isNaN(interval) || interval <= 0 || interval > 180) {
      handleError('Please enter a valid number between 1 and 180');
      return;
    }
    
    chrome.runtime.sendMessage({ 
      action: 'notification', 
      minutes: interval 
    }, (response) => {
      if (response.success) {
        state.notificationInterval = interval;
        updateUIElements();
        hideModal('intervalModal');
      } else {
        handleError(response.error || 'Failed to update interval');
      }
    });
  });

  toggleSoundBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ 
      action: 'updateSound', 
      enabled: !state.soundEnabled 
    }, (response) => {
      if (response.success) {
        state.soundEnabled = !state.soundEnabled;
        updateUIElements();
      } else {
        handleError(response.error || 'Failed to toggle sound');
      }
    });
  });

  toggleNotificationsBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ 
      action: 'toggle', 
      isActive: !state.notificationsActive 
    }, (response) => {
      if (response.success) {
        state.notificationsActive = !state.notificationsActive;
        if (state.notificationsActive) {
          startCountdown();
        } else {
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
        }
        updateUIElements();
      } else {
        handleError(response.error || 'Failed to toggle notifications');
      }
    });
  });

  editPromptBtn.addEventListener('click', () => {
    promptInput.value = state.customPrompt;
    showModal('promptModal');
  });

  savePromptBtn.addEventListener('click', () => {
    const customPrompt = promptInput.value.trim();
    chrome.runtime.sendMessage({ 
      action: 'saveCustomPrompt', 
      customPrompt: customPrompt 
    }, (response) => {
      if (response.success) {
        state.customPrompt = customPrompt;
        hideModal('promptModal');
      } else {
        handleError(response.error || 'Failed to save prompt');
      }
    });
  });

  editApiKeyBtn.addEventListener('click', () => {
    apiKeyInput.value = state.apiKey || '';
    showModal('apiKeyModal');
  });

  saveApiKeyBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      handleError('Please enter your Gemini API key');
      return;
    }
    
    chrome.runtime.sendMessage({ 
      action: 'saveApiKey', 
      apiKey: apiKey 
    }, (response) => {
      if (response.success) {
        state.apiKey = apiKey;
        updateUIElements();
        hideModal('apiKeyModal');
      } else {
        handleError(response.error || 'Failed to save API key');
      }
    });
  });

  // Initialize
  loadInitialSettings();

  // 优化错误处理
  function handleError(error) {
    const errorToast = document.getElementById('errorToast');
    errorToast.textContent = error;
    errorToast.style.display = 'block';
    
    setTimeout(() => {
      errorToast.style.display = 'none';
    }, 3000);
  }

  // 打开模态框时添加动画
  function showModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.style.display = 'flex';
    setTimeout(() => {
      modal.classList.add('active');
    }, 10);
  }

  // 关闭模态框时的动画
  function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.remove('active');
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);
  }

  // 添加倒计时更新定时器
  let countdownInterval;

  function startCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
    countdownInterval = setInterval(updateUIElements, 1000);
  }

  // 在 popup 关闭时清理定时器
  window.addEventListener('unload', () => {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
  });

  // 添加新的元素引用
  const editNextAlertBtn = document.getElementById('editNextAlertBtn');
  const nextAlertModal = document.getElementById('nextAlertModal');
  const nextAlertInput = document.getElementById('nextAlertInput');
  const saveNextAlertBtn = document.getElementById('saveNextAlertBtn');

  // 添加事件监听器
  editNextAlertBtn.addEventListener('click', () => {
    if (state.nextNotificationTime) {
      const timeLeft = Math.max(0, state.nextNotificationTime - Date.now());
      const minutesLeft = Math.ceil(timeLeft / 60000);
      nextAlertInput.value = minutesLeft;
    } else {
      nextAlertInput.value = state.notificationInterval;
    }
    showModal('nextAlertModal');
  });

  saveNextAlertBtn.addEventListener('click', () => {
    const minutes = parseInt(nextAlertInput.value);
    if (isNaN(minutes) || minutes <= 0 || minutes > 180) {
      handleError('Please enter a valid number between 1 and 180');
      return;
    }
    
    chrome.runtime.sendMessage({ 
      action: 'setNextAlert', 
      minutes: minutes 
    }, (response) => {
      if (response.success) {
        state.nextNotificationTime = Date.now() + minutes * 60000;
        updateUIElements();
        nextAlertInput.value = '';
        hideModal('nextAlertModal');
      } else {
        handleError(response.error || 'Failed to set next alert time');
      }
    });
  });
});