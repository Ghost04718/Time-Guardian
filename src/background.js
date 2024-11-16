// Constants
const DEFAULT_SETTINGS = {
  isActive: true,
  soundEnabled: false,
  nextNotificationTime: null, // Actual time
  notificationInterval: 3,
  notificationDuration: 45000, // 45 seconds
  maxSnoozeMinutes: 180,
  defaultSnoozeOptions: [10, 30],
  apiKey: null
};

// State management with TypeScript-like interface
/**
 * @typedef {typeof DEFAULT_SETTINGS} Settings
 * @type {Settings}
 */
let state = { ...DEFAULT_SETTINGS };

// Import and initialize Gemini
import { GoogleGenerativeAI } from '@google/generative-ai';

// Storage Manager Class
class StorageManager {
  static async initialize() {
    try {
      // Retrieve stored settings
      const stored = await chrome.storage.local.get(null);
      console.log('Retrieved stored settings:', stored);
  
      // Validate the retrieved data (ensure it's not undefined or null)
      const validStored = stored || {};
  
      // Merge defaults with valid stored settings
      state = {
        ...DEFAULT_SETTINGS,
        ...validStored,
      };

      if (!state.nextNotificationTime) {
        state.nextNotificationTime = Date.now() + state.notificationInterval * 60000;
      }

      console.log('Initialized state:', state);

      // Initialize Gemini if API key exists
      if (state.apiKey) {
        geminiManager.init(state.apiKey);
      }

      // Setup alarm if notifications are active
      if (state.isActive) {
        await AlarmManager.setup();
      }

      return true;
    } catch (error) {
      console.error('Error initializing storage:', error);
      return false;
    }
  }

  static async updateSettings(updates) {
    try {
      // Update local state
      state = {
        ...state,
        ...updates
      };

      // Persist to storage
      await chrome.storage.local.set(updates);
      console.log('Settings updated:', updates);

      return true;
    } catch (error) {
      console.error('Error updating settings:', error);
      return false;
    }
  }

  static async getSetting(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return result[key];
    } catch (error) {
      console.error(`Error getting setting ${key}:`, error);
      return null;
    }
  }
}

// Gemini Manager Class
class GeminiManager {
  constructor() {
    this.model = null;
  }

  init(apiKey) {
    if (!apiKey) {
      console.error('No API key available');
      this.model = null;
      return false;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
      
      if (this.model) {
        console.log('Gemini model initialized successfully');
        chrome.storage.local.set({ geminiInitialized: true });
        return true;
      }
      throw new Error('Model initialization returned null');
    } catch (error) {
      console.error('Failed to initialize Gemini:', error);
      this.model = null;
      chrome.storage.local.set({ geminiInitialized: false });
      return false;
    }
  }

  async generateMessage(url, title, timeString) {
    if (!this.model) {
      console.error('Gemini model not initialized');
      return null;
    }

    try {
      const prompt = `Based on the webpage title "${title}", URL "${url}" and current time "${timeString}", 
        generate a short, friendly reminder about time management. If it seems to be a work-related page, 
        encourage productivity. If it's entertainment, suggest them going back to work. 
        Keep it under 100 characters. Use some emojis.`;

      const result = await this.model.generateContent(prompt);
      
      if (!result?.response) {
        throw new Error('Invalid response structure from Gemini');
      }

      return result.response.text();
    } catch (error) {
      console.error('Gemini API error:', error);
      const notificationId = `error-${Date.now()}`;
      await chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: 'images/guard-128.png',
        title: 'Time Guardian',
        message: `Failed to generate message. Error: ${error.message}`,
        requireInteraction: false,
        silent: !state.soundEnabled,
        priority: 2
      });
      setTimeout(() => chrome.notifications.clear(notificationId), state.notificationDuration);
      return null;
    }
  }
}

const geminiManager = new GeminiManager();

// Alarm Manager Class
class AlarmManager {
  static ALARM_NAME = 'timeNotification';

  static async verifySchedule() {
    const alarm = await chrome.alarms.get(this.ALARM_NAME);
    if (alarm) {
      const nextAlarmTime = new Date(alarm.scheduledTime);
      const timeUntilAlarm = (alarm.scheduledTime - Date.now()) / 60000; // in minutes
      
      console.log({
        nextAlarm: nextAlarmTime.toLocaleString(),
        timeUntil: `${timeUntilAlarm.toFixed(2)} minutes`,
        interval: `${state.notificationInterval} minutes`
      });
    } else {
      console.warn('No active alarm found');
    }
  }

  static async setup(minutes = state.notificationInterval, immediately = false) {
    try {
      // Clear existing alarms
      await this.cleanup();
      
      if (!state.isActive) {
        console.log('Notifications inactive, no new alarm created');
        return;
      }

      const alarmInfo = {
        periodInMinutes: minutes
      };

      if (immediately) {
        alarmInfo.when = Date.now();
      }

      await chrome.alarms.create(this.ALARM_NAME, alarmInfo);
      console.log('Created new alarm:', alarmInfo);

      const success = await StorageManager.updateSettings({ nextNotificationTime: Date.now() + minutes * 60000 });
      if (success) {
        console.log('Next notification time updated:', new Date(state.nextNotificationTime).toLocaleString());
      }
      
      await this.verifySchedule();
    } catch (error) {
      console.error('Error in setupAlarm:', error);
    }
  }

  static async cleanup() {
    const alarms = await chrome.alarms.getAll();
    const timeAlarms = alarms.filter(a => a.name === this.ALARM_NAME);
    
    for (const alarm of timeAlarms) {
      await chrome.alarms.clear(alarm.name);
      console.log('Cleared alarm:', alarm.name);
    }
    const success = await StorageManager.updateSettings({ nextNotificationTime: null });
    if (success) {
      console.log('Next notification time cleared');
    }
  }
}

// Notification Manager Class
class NotificationManager {
  constructor() {
    this.iconUrl = 'images/guard-128.png';
    this.title = 'Time Guardian';
  }

  formatTimeString(date = new Date()) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  async show() {
    if (!state.isActive) return;

    const notificationId = `time-${Date.now()}`;
    const timeString = this.formatTimeString();
    let message;

    try {
      const tabs = await chrome.tabs.query({ active: true });
      const activeTab = tabs.find(tab => tab.url && tab.title);

      if (activeTab && geminiManager.model) {
        message = await geminiManager.generateMessage(
          activeTab.url,
          activeTab.title,
          timeString
        );
      }
    } catch (error) {
      console.error('Error catching active tabs: ', error);
    }

    if (!message) {
      message = `Current time is ${timeString}.\nNext notification in ${state.notificationInterval} minutes.`;
    }

    try {
      await chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: this.iconUrl,
        title: this.title,
        message,
        buttons: state.defaultSnoozeOptions.map(minutes => ({
          title: `Snooze ${minutes} minutes`
        })),
        requireInteraction: false,
        silent: !state.soundEnabled,
        priority: 1
      });

      // Auto-clear notification
      setTimeout(() => this.clear(notificationId), state.notificationDuration);
    } catch (error) {
      console.error('Error creating notification:', error);
    }
  }

  async clear(notificationId) {
    try {
      await chrome.notifications.clear(notificationId);
      console.log('Notification cleared:', notificationId);
    } catch (error) {
      console.error('Error clearing notification:', error);
    }
  }

  async snooze(minutes) {
    if (minutes > state.maxSnoozeMinutes) return;

    try {
      // Calculate new snooze options
      const newSnoozeOptions = [
        state.defaultSnoozeOptions[1],
        minutes
      ];

      // Update storage with new values
      await StorageManager.updateSettings({
        defaultSnoozeOptions: newSnoozeOptions,
        nextNotificationTime: Date.now() + minutes * 60000
      });

      await AlarmManager.setup(minutes=minutes);
    } catch (error) {
      console.error('Error in snooze:', error);
    }
  }
}

const notificationManager = new NotificationManager();

// Message Handler Class
class MessageHandler {
  static async handle(request, sender, sendResponse) {
    const handlers = {
      snooze: async ({ minutes }) => {
        if (minutes <= state.maxSnoozeMinutes) {
            const success = await notificationManager.snooze(minutes);
            if (success) {
            return { success: true };
            }
            return { 
            success: false, 
            error: 'Failed to snooze notification' 
            };
        }
        return { 
          success: false, 
          error: 'Snooze duration exceeds maximum allowed time' 
        };
      },

      notification: async ({ minutes }) => {
        if (minutes <= state.maxSnoozeMinutes) {
          const updates = { notificationInterval: minutes, nextNotificationTime: Date.now() + minutes * 60000 };
          const success = await StorageManager.updateSettings(updates);
          
          if (success) {
            await AlarmManager.setup(minutes = minutes);
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to save notification interval' 
          };
        }
        return { 
          success: false, 
          error: 'Interval exceeds maximum allowed time' 
        };
      },

      saveApiKey: async ({ apiKey }) => {
        try {
          const success = await StorageManager.updateSettings({ apiKey });
          if (success) {
            geminiManager.init(apiKey);
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to save API key' 
          };
        } catch (error) {
          return { 
            success: false, 
            error: error.message 
          };
        }
      },

      toggle: async ({ isActive }) => {
        try {
          const success = await StorageManager.updateSettings({ isActive });
          if (success) {
            if (isActive) {
              await AlarmManager.setup(immediately = true);
            } else {
              await chrome.alarms.clear(AlarmManager.ALARM_NAME);
            }
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to update active status' 
          };
        } catch (error) {
          return { 
            success: false, 
            error: error.message 
          };
        }
      },

      updateSound: async ({ enabled }) => {
        try {
          const success = await StorageManager.updateSettings({ 
            soundEnabled: enabled 
          });
          return { success };
        } catch (error) {
          return { 
            success: false, 
            error: error.message 
          };
        }
      },

      getSettings: async () => {
        try {
          return { 
            success: true, 
            settings: state 
          };
        } catch (error) {
          return { 
            success: false, 
            error: error.message 
          };
        }
      }
    };

    try {
      const handler = handlers[request.action];
      if (handler) {
        const response = await handler(request);
        sendResponse(response);
      }
    } catch (error) {
      sendResponse({ 
        success: false, 
        error: error.message 
      });
    }
  }
}

// Event Listeners
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated');
  await StorageManager.initialize();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Extension starting up...');
  await StorageManager.initialize();
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    console.log('Storage changes detected:', changes);
    // Update local state with changes
    Object.entries(changes).forEach(([key, { newValue }]) => {
      state[key] = newValue;
    });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AlarmManager.ALARM_NAME) {
    console.log('Alarm triggered:', new Date().toLocaleString());
    await StorageManager.initialize();
    await notificationManager.show();
    await AlarmManager.cleanup();
    await AlarmManager.setup();
  }
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  try {
    await notificationManager.clear(notificationId);
    const snoozeMinutes = state.defaultSnoozeOptions[buttonIndex];
    if (snoozeMinutes) {
      await notificationManager.snooze(snoozeMinutes);
    }
  } catch (error) {
    console.error('Error handling notification button click:', error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  MessageHandler.handle(request, sender, sendResponse);
  return true; // Keep message channel open for async response
});

// Handle extension updates
chrome.runtime.onUpdateAvailable.addListener(() => {
  chrome.runtime.reload();
});

// Debug function to check current state
async function debugState() {
  const stored = await chrome.storage.local.get(null);
  console.log('Current storage state:', stored);
  console.log('Current memory state:', state);
  console.log('Active alarms:', await chrome.alarms.getAll());
  return {
    stored,
    memoryState: state,
    alarms: await chrome.alarms.getAll()
  };
}