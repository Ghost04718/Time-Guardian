const DEFAULT_SETTINGS = {
  isActive: true,
  soundEnabled: false,
  nextNotificationTime: null, // Minutes
  notificationInterval: 3,
  maxSnoozeMinutes: 180
};

let state = { ...DEFAULT_SETTINGS };

class UIManager {
  static elements = {
    currentTime: document.getElementById('currentTime'),
    countdown: document.querySelector('.countdown'),
    toggleButton: document.getElementById('toggleNotifications'),
    soundToggle: document.getElementById('soundToggle'),
    customSnoozeBtn: document.getElementById('customSnoozeBtn'),
    customNotificationBtn: document.getElementById('customNotificationBtn'),
    setAPIKeyBtn: document.getElementById('setAPIKeyBtn'),
    modals: {
      snooze: document.getElementById('customSnoozeContainer'),
      notification: document.getElementById('customNotificationContainer'),
      apiKey: document.getElementById('setAPIKeyContainer')
    },
    inputs: {
      snooze: document.getElementById('customSnoozeMinutes'),
      notification: document.getElementById('customNotificationMinutes'),
      apiKey: document.getElementById('APIKey')
    }
  };

  static initialize() {
    this.initializeEventListeners();
    this.startTimers();
    this.loadInitialState();
  }

  static initializeEventListeners() {
    // Toggle buttons
    this.elements.toggleButton.addEventListener('click', () => {
      state.isActive = !state.isActive;
      this.sendMessage('toggle', { isActive: state.isActive });
      this.updateToggleButton();
    });

    this.elements.soundToggle.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
      this.sendMessage('updateSound', { enabled: state.soundEnabled });
    });

    // Modal buttons
    this.elements.customSnoozeBtn.addEventListener('click', () => 
      this.toggleModal('snooze'));
    this.elements.customNotificationBtn.addEventListener('click', () => 
      this.toggleModal('notification'));
    this.elements.setAPIKeyBtn.addEventListener('click', () => 
      this.toggleModal('apiKey'));

    // Set buttons
    document.getElementById('setCustomSnooze').addEventListener('click', () => 
      this.handleCustomValue('snooze'));
    document.getElementById('setCustomNotification').addEventListener('click', () => 
      this.handleCustomValue('notification'));
    document.getElementById('setAPIKey').addEventListener('click', () => 
      this.handleApiKey());
  }

  static startTimers() {
    this.updateCurrentTime();
    setInterval(() => this.updateCurrentTime(), 1000);
    setInterval(() => this.updateSnoozeStatus(), 1000);
  }

  static async loadInitialState() {
    try {
      const result = await this.sendMessage('getSettings');
      if (result.success) {
        state = { ...DEFAULT_SETTINGS, ...result.settings };
        this.updateUI();
      }
    } catch (error) {
      console.error('Failed to load initial state:', error);
    }
  }

  static updateUI() {
    this.updateToggleButton();
    this.updateSnoozeStatus();
    this.elements.soundToggle.checked = state.soundEnabled;
  }

  static updateCurrentTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    this.elements.currentTime.textContent = `Current time: ${timeString}`;
  }

  static async updateSnoozeStatus() {
    if (!state.isActive) {
      this.elements.countdown.textContent = 'Paused';
      return;
    }

    if (!state.nextNotificationTime) {
      this.elements.countdown.textContent = 'Active';
      return;
    }

    const remaining = Math.max(0, state.nextNotificationTime - Date.now());
    if (remaining <= 0) {
      this.elements.countdown.textContent = 'Active';
    } else {
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      this.elements.countdown.textContent = `${minutes}m ${seconds}s`;
    }
  }

  static updateToggleButton() {
    this.elements.toggleButton.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
      ${state.isActive ? 'Notifications Active' : 'Notifications Paused'}
    `;
    this.elements.toggleButton.classList.toggle('paused', !state.isActive);
  }

  static toggleModal(type) {
    this.elements.modals[type].classList.toggle('visible');
  }

  static validateInput(value, type) {
    const num = parseInt(value);
    return num > 0 && num <= state.maxSnoozeMinutes;
  }

  static validateApiKey(apiKey) {
    const validFormat = /^AIza[0-9A-Za-z-_]{35}$/;
    return validFormat.test(apiKey);
  }

  static async handleCustomValue(type) {
    const value = parseInt(this.elements.inputs[type].value);
    if (this.validateInput(value)) {
      await this.sendMessage(type, { minutes: value });
      this.toggleModal(type);
      window.close();
    }
  }

  static async handleApiKey() {
    const apiKey = this.elements.inputs.apiKey.value.trim();
    if (this.validateApiKey(apiKey)) {
      await this.sendMessage('saveApiKey', { apiKey });
      this.toggleModal('apiKey');
      window.close();
    }
  }

  static sendMessage(action, data = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, ...data }, resolve);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => UIManager.initialize());