document.addEventListener('DOMContentLoaded', () => {
  const state = {
    isLoading: false,
    error: null,
    apiKey: null,
    notificationInterval: 3,
    soundEnabled: false,
    notificationsActive: true,
    customPrompt: '',
    nextNotificationTime: null,
    lastAlarmCheck: null,
    lastSyncTime: Date.now()
  };

  let countdownInterval = null;
  let verificationInterval = null;

  function updateNextNotificationDisplay() {
    const nextNotificationSpan = document.getElementById('nextNotification');
    
    if (!state.notificationsActive) {
      nextNotificationSpan.textContent = 'Notifications paused';
      return;
    }

    if (!state.nextNotificationTime) {
      nextNotificationSpan.textContent = 'Not scheduled';
      return;
    }

    const now = Date.now();
    const timeLeft = Math.max(0, state.nextNotificationTime - now);

    // Only verify if significant time has passed since last sync
    if (now - state.lastSyncTime > 5000) {
      verifyAlarmSync();
      state.lastSyncTime = now;
    }

    if (timeLeft <= 0) {
      nextNotificationSpan.textContent = 'Due now';
      requestAlarmStatus();
      return;
    }

    const minutesLeft = Math.floor(timeLeft / 60000);
    const secondsLeft = Math.floor((timeLeft % 60000) / 1000);
    
    if (minutesLeft > 0) {
      nextNotificationSpan.textContent = `${minutesLeft}m ${secondsLeft}s`;
    } else {
      nextNotificationSpan.textContent = `${secondsLeft}s`;
    }
  }

  async function verifyAlarmSync() {
    try {
      const response = await sendMessageWithRetry({ 
        action: 'verifyAlarm',
        currentTime: state.nextNotificationTime 
      });
      
      if (response?.success && response.needsUpdate) {
        state.nextNotificationTime = response.correctTime;
        state.lastSyncTime = Date.now();
        updateUIElements();
      }
    } catch (error) {
      console.error('Failed to verify alarm sync:', error);
    }
  }

  async function requestAlarmStatus() {
    try {
      const response = await sendMessageWithRetry({ action: 'getAlarmStatus' });
      if (response?.success) {
        state.nextNotificationTime = response.nextNotificationTime;
        state.notificationsActive = response.isActive;
        state.lastSyncTime = Date.now();
        updateUIElements();
      }
    } catch (error) {
      console.error('Failed to get alarm status:', error);
    }
  }

  // Reliable message sending with retry
  async function sendMessageWithRetry(message, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(response);
            }
          });
        });
      } catch (error) {
        console.warn(`Message attempt ${attempt + 1} failed:`, error);
        if (attempt === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  function startCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
    
    // Initial update
    updateUIElements();
    
    // Start the interval with requestAnimationFrame for smoother updates
    countdownInterval = setInterval(() => {
      requestAnimationFrame(updateNextNotificationDisplay);
    }, 1000);
  }

  function startVerification() {
    if (verificationInterval) {
      clearInterval(verificationInterval);
    }
    
    // Verify alarm every 30 seconds
    verificationInterval = setInterval(() => {
      verifyAlarmSync().catch(console.error);
    }, 30000);
  }

  // Handle window focus events
  window.addEventListener('focus', async () => {
    try {
      await requestAlarmStatus();
      state.lastSyncTime = Date.now();
    } catch (error) {
      console.error('Focus sync failed:', error);
    }
  });

  // Load initial settings
  async function loadInitialSettings() {
    state.isLoading = true;
    document.getElementById('loadingIndicator').style.display = 'flex';
    
    try {
      const response = await sendMessageWithRetry({ action: 'getSettings' });
      
      state.isLoading = false;
      document.getElementById('loadingIndicator').style.display = 'none';
      
      if (response?.success) {
        Object.assign(state, response.settings);
        state.lastSyncTime = Date.now();
        
        // Verify initial alarm state
        await verifyAlarmSync();
        
        // Start countdown and verification
        startCountdown();
        startVerification();
      } else {
        handleError(response?.error || 'Could not load settings');
      }
    } catch (error) {
      state.isLoading = false;
      document.getElementById('loadingIndicator').style.display = 'none';
      handleError('Failed to connect to extension. Please try reopening the popup.');
    }
  }

  // Handle interval changes
  saveIntervalBtn.addEventListener('click', async () => {
    const interval = parseInt(intervalInput.value);
    if (isNaN(interval) || interval <= 0 || interval > 180) {
      handleError('Please enter a valid number between 1 and 180');
      return;
    }
    
    try {
      const response = await sendMessageWithRetry({ 
        action: 'notification', 
        minutes: interval 
      });
      
      if (response?.success) {
        state.notificationInterval = interval;
        if (response.nextNotificationTime) {
          state.nextNotificationTime = response.nextNotificationTime;
          state.lastSyncTime = Date.now();
        }
        updateUIElements();
        hideModal('intervalModal');
      } else {
        handleError(response?.error || 'Failed to update interval');
      }
    } catch (error) {
      handleError('Connection error. Please try again.');
    }
  });

  // Clean up on window unload
  window.addEventListener('unload', () => {
    if (countdownInterval) {
      clearInterval(countdownInterval);
    }
    if (verificationInterval) {
      clearInterval(verificationInterval);
    }
  });

  // Initialize
  loadInitialSettings().catch(error => {
    console.error('Initialization failed:', error);
    handleError('Failed to initialize. Please try reopening the popup.');
  });
});