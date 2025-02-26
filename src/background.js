import { GoogleGenerativeAI } from '@google/generative-ai';

// Constants
const DEFAULT_SETTINGS = {
  isActive: true,
  soundEnabled: false,
  nextNotificationTime: null,
  notificationInterval: 3,
  notificationDuration: 45000,
  maxSnoozeMinutes: 180,
  defaultSnoozeOptions: [5, 15],
  apiKey: null,
  defaultPrompt: 'Generate a short, friendly time reminder with emojis.',
  customPrompt: null,
  retryAttempts: 3,
  retryDelay: 1000,
};

const REQUIRED_SETTINGS = [
  'isActive',
  'notificationInterval',
  'maxSnoozeMinutes',
];

// State management
let state = { ...DEFAULT_SETTINGS };
let isInitialized = false;

// Utility Functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const validateSettings = (settings) => {
  // Check required fields
  const missingFields = REQUIRED_SETTINGS.filter(field => 
    settings[field] === undefined || settings[field] === null
  );
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required settings: ${missingFields.join(', ')}`);
  }

  // Validate numeric fields
  if (typeof settings.notificationInterval !== 'number' || 
      settings.notificationInterval <= 0 || 
      settings.notificationInterval > settings.maxSnoozeMinutes) {
    throw new Error('Invalid notification interval');
  }

  // Validate time-based fields
  if (settings.nextNotificationTime && 
      (typeof settings.nextNotificationTime !== 'number' || 
       settings.nextNotificationTime < 0)) {
    throw new Error('Invalid next notification time');
  }

  return true;
};

// Retry mechanism for async operations
async function withRetry(operation, retryCount = state.retryAttempts) {
  let lastError;
  
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const result = await operation();
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`Operation failed (attempt ${attempt + 1}/${retryCount}):`, error);
      
      if (attempt < retryCount - 1) {
        await delay(state.retryDelay * Math.pow(2, attempt));
      }
    }
  }
  
  throw lastError;
}

// Storage Manager Class
class StorageManager {
  static async initialize() {
    if (isInitialized) {
      return true;
    }

    try {
      const stored = await withRetry(() => chrome.storage.local.get(null));
      const validStored = JSON.parse(JSON.stringify(stored || {}));
      
      const newState = {
        ...DEFAULT_SETTINGS,
        ...validStored,
      };

      validateSettings(newState);

      if (!newState.nextNotificationTime && newState.isActive) {
        newState.nextNotificationTime = Date.now() + newState.notificationInterval * 60000;
      }

      state = newState;
      isInitialized = true;

      if (state.apiKey) {
        await geminiManager.init(state.apiKey);
      }

      if (state.isActive) {
        await AlarmManager.setup();
      }

      return true;
    } catch (error) {
      console.error('Storage initialization failed:', error);
      state = { ...DEFAULT_SETTINGS };
      isInitialized = false;
      
      try {
        await chrome.storage.local.clear();
        await chrome.storage.local.set(DEFAULT_SETTINGS);
      } catch (storageError) {
        console.error('Failed to reset storage:', storageError);
      }
      
      return false;
    }
  }

  static async updateSettings(updates) {
    try {
      const newState = {
        ...state,
        ...updates
      };

      validateSettings(newState);
      await withRetry(() => chrome.storage.local.set(updates));
      state = newState;
      return true;
    } catch (error) {
      console.error('Settings update failed:', error);
      return false;
    }
  }

  static async getSetting(key) {
    try {
      const result = await withRetry(() => chrome.storage.local.get(key));
      return result[key];
    } catch (error) {
      console.error(`Failed to get setting ${key}:`, error);
      return null;
    }
  }

  static async reset() {
    try {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(DEFAULT_SETTINGS);
      state = { ...DEFAULT_SETTINGS };
      isInitialized = false;
      return true;
    } catch (error) {
      console.error('Failed to reset settings:', error);
      return false;
    }
  }
}

// Gemini Manager Class
class GeminiManager {
  constructor() {
    this.model = null;
    this.initPromise = null;
  }

  async validateApiKey(apiKey) {
    if (!apiKey?.trim()) {
      return false;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
      
      const result = await withRetry(() => model.generateContent("Test message"));
      return Boolean(result?.response);
    } catch (error) {
      console.error('API key validation failed:', error);
      return false;
    }
  }

  async init(apiKey) {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (!apiKey?.trim()) {
        console.error('No API key available');
        this.model = null;
        return false;
      }

      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        this.model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
        
        if (this.model) {
          console.log('Gemini model initialized successfully');
          await chrome.storage.local.set({ geminiInitialized: true });
          return true;
        }
        throw new Error('Model initialization returned null');
      } catch (error) {
        console.error('Failed to initialize Gemini:', error);
        this.model = null;
        await chrome.storage.local.set({ geminiInitialized: false });
        return false;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  async generateMessage(url, title, timeString) {
    if (!this.model) {
      console.error('Gemini model not initialized');
      return null;
    }

    try {
      const promptTemplate = `Based on the webpage title "${title}", URL "${url}" and current time "${timeString}", ${state.customPrompt || state.defaultPrompt}`;
      
      const result = await withRetry(() => this.model.generateContent(promptTemplate));
      
      if (!result?.response) {
        throw new Error('Invalid response structure from Gemini');
      }

      return result.response.text();
    } catch (error) {
      console.error('Gemini API error:', error);
      await this.handleGenerationError(error);
      return null;
    }
  }

  async handleGenerationError(error) {
    const notificationId = `error-${Date.now()}`;
    try {
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
    } catch (notificationError) {
      console.error('Failed to show error notification:', notificationError);
    }
  }
}

const geminiManager = new GeminiManager();

// Alarm Manager Class
class AlarmManager {
  static ALARM_NAME = 'timeNotification';

  static async verifySchedule() {
    try {
      const alarm = await chrome.alarms.get(this.ALARM_NAME);
      if (alarm) {
        const nextAlarmTime = new Date(alarm.scheduledTime);
        const timeUntilAlarm = (alarm.scheduledTime - Date.now()) / 60000;
        
        console.log({
          nextAlarm: nextAlarmTime.toLocaleString(),
          timeUntil: `${timeUntilAlarm.toFixed(2)} minutes`,
          interval: `${state.notificationInterval} minutes`
        });
        return true;
      }
      console.warn('No active alarm found');
      return false;
    } catch (error) {
      console.error('Failed to verify schedule:', error);
      return false;
    }
  }

  static async setup(minutes = state.notificationInterval, immediately = false, nextTime = null) {
    try {
      if (!state.isActive) {
        console.log('Notifications inactive, no new alarm created');
        return false;
      }

      if (minutes <= 0 || minutes > state.maxSnoozeMinutes) {
        console.error('Invalid interval:', minutes);
        return false;
      }

      // Ensure nextTime is valid if provided
      if (nextTime) {
        const now = Date.now();
        if (nextTime <= now) {
          console.error('Next time must be in the future');
          return false;
        }
      }

      // Clean up any existing alarms first
      await this.cleanup();

      const now = Date.now();
      // Calculate the actual next time
      const actualNextTime = nextTime || (immediately ? now : now + minutes * 60000);

      const alarmInfo = {
        when: actualNextTime,
        periodInMinutes: minutes
      };

      await withRetry(() => chrome.alarms.create(this.ALARM_NAME, alarmInfo));
      console.log('Created new alarm:', alarmInfo);

      // Update storage with the new next notification time
      const success = await StorageManager.updateSettings({ 
        nextNotificationTime: actualNextTime 
      });
      
      if (success) {
        state.nextNotificationTime = actualNextTime;
        console.log('Next notification time updated:', new Date(actualNextTime).toLocaleString());
        await this.verifySchedule();
        return true;
      }

      return false;
    } catch (error) {
      console.error('Error in setupAlarm:', error);
      return false;
    }
  }

  static async cleanup() {
    try {
      const alarms = await chrome.alarms.getAll();
      const timeAlarms = alarms.filter(a => a.name === this.ALARM_NAME);
      
      for (const alarm of timeAlarms) {
        await chrome.alarms.clear(alarm.name);
        console.log('Cleared alarm:', alarm.name);
      }
      
      const success = await StorageManager.updateSettings({ nextNotificationTime: null });
      if (success) {
        state.nextNotificationTime = null;
        console.log('Next notification time cleared');
        return true;
      }
      console.error('Failed to clear next notification time');
      return false;
    } catch (error) {
      console.error('Error in cleanup:', error);
      return false;
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

  async getActiveTab() {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      const tabs = await chrome.tabs.query({ 
        active: true,
        windowId: currentWindow.id
      });
      
      return tabs[0];
    } catch (error) {
      console.error('Error getting active tab:', error);
      return null;
    }
  }

  async show() {
    if (!state.isActive) return;

    const notificationId = `time-${Date.now()}`;
    const timeString = this.formatTimeString();
    let message;

    try {
      const activeTab = await this.getActiveTab();

      if (activeTab?.url && activeTab?.title && geminiManager.model) {
        message = await geminiManager.generateMessage(
          activeTab.url,
          activeTab.title,
          timeString
        );
      }
    } catch (error) {
      console.error('Error getting tab info:', error);
    }

    if (!message) {
      message = this.generateFallbackMessage(timeString);
    }

    try {
      await withRetry(() => chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: this.iconUrl,
        title: this.title,
        message,
        buttons: state.defaultSnoozeOptions.map(minutes => ({
          title: `Snooze ${minutes}m`
        })),
        requireInteraction: false,
        silent: !state.soundEnabled,
        priority: 1
      }));

      setTimeout(() => this.clear(notificationId), state.notificationDuration);
    } catch (error) {
      console.error('Error creating notification:', error);
    }
  }

  generateFallbackMessage(timeString) {
    let nextTime = state.notificationInterval;
    if (state.nextNotificationTime) {
      const timeLeft = state.nextNotificationTime - Date.now();
      if (timeLeft > 0) {
        const minutesLeft = Math.floor(timeLeft / 60000);
        const secondsLeft = Math.floor((timeLeft % 60000) / 1000);
        nextTime = minutesLeft > 0 ? 
          `${minutesLeft}m ${secondsLeft}s` : 
          `${secondsLeft}s`;
      }
    }
    return `⏰ Time Check: ${timeString}\n⏱️ Next reminder in ${typeof nextTime === 'string' ? nextTime : nextTime + ' minutes'}\n💡 Click buttons below to snooze`;
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
    if (minutes > state.maxSnoozeMinutes) {
      console.error('Snooze duration exceeds maximum allowed time');
      return false;
    }

    try {
      const nextTime = Date.now() + minutes * 60000;
      
      const newSnoozeOptions = [
        Math.min(minutes, state.defaultSnoozeOptions[1]),
        Math.max(minutes, state.defaultSnoozeOptions[1])
      ];

      const success = await StorageManager.updateSettings({
        defaultSnoozeOptions: newSnoozeOptions,
        nextNotificationTime: nextTime
      });

      if (!success) {
        throw new Error('Failed to update snooze settings');
      }

      state.defaultSnoozeOptions = newSnoozeOptions;
      state.nextNotificationTime = nextTime;

      const alarmSuccess = await withRetry(() => 
        AlarmManager.setup(minutes, false, nextTime)
      );
      
      if (!alarmSuccess) {
        throw new Error('Failed to setup snooze alarm');
      }

      return true;
    } catch (error) {
      console.error('Error in snooze:', error);
      return false;
    }
  }
}

const notificationManager = new NotificationManager();

// Message Handler Class
// Message Handler Class
class MessageHandler {
  static async handle(request, sender, sendResponse) {
    if (!isInitialized) {
      await StorageManager.initialize();
    }

    const handlers = {
      snooze: async ({ minutes }) => {
        if (minutes <= state.maxSnoozeMinutes) {
          try {
            const success = await notificationManager.snooze(minutes);
            if (success) {
              return { success: true };
            }
            return { 
              success: false, 
              error: 'Failed to snooze notification' 
            };
          } catch (error) {
            console.error('Snooze error:', error);
            return {
              success: false,
              error: 'Failed to process snooze request'
            };
          }
        }
        return { 
          success: false, 
          error: 'Snooze duration exceeds maximum allowed time' 
        };
      },

      notification: async ({ minutes }) => {
        if (minutes <= state.maxSnoozeMinutes) {
          try {
            const updates = { 
              notificationInterval: minutes, 
              nextNotificationTime: Date.now() + minutes * 60000 
            };
            
            const success = await StorageManager.updateSettings(updates);
            
            if (success) {
              state.notificationInterval = minutes;
              const alarmSuccess = await withRetry(() => AlarmManager.setup(minutes));
              if (!alarmSuccess) {
                throw new Error('Failed to setup notification alarm');
              }
              return { success: true };
            }
            return { 
              success: false, 
              error: 'Failed to save notification interval' 
            };
          } catch (error) {
            console.error('Notification setup error:', error);
            return {
              success: false,
              error: 'Failed to setup notifications: ' + error.message
            };
          }
        }
        return { 
          success: false, 
          error: 'Interval exceeds maximum allowed time' 
        };
      },

      verifyAlarm: async ({ currentTime }) => {
        try {
          const alarm = await chrome.alarms.get(AlarmManager.ALARM_NAME);
          if (!alarm) {
            // No alarm exists but we think there should be one
            if (state.isActive && state.nextNotificationTime) {
              // Recreate the alarm
              const minutesLeft = Math.max(1, Math.ceil((state.nextNotificationTime - Date.now()) / 60000));
              await AlarmManager.setup(minutesLeft, false, state.nextNotificationTime);
              return {
                success: true,
                needsUpdate: true,
                correctTime: state.nextNotificationTime
              };
            }
            return {
              success: true,
              needsUpdate: true,
              correctTime: null
            };
          }

          // Check if the alarm time matches our state
          const timeDiff = Math.abs(alarm.scheduledTime - state.nextNotificationTime);
          if (timeDiff > 1000) { // If difference is more than 1 second
            state.nextNotificationTime = alarm.scheduledTime;
            await StorageManager.updateSettings({ 
              nextNotificationTime: alarm.scheduledTime 
            });
            return {
              success: true,
              needsUpdate: true,
              correctTime: alarm.scheduledTime
            };
          }

          return {
            success: true,
            needsUpdate: false
          };
        } catch (error) {
          console.error('Alarm verification error:', error);
          return {
            success: false,
            error: 'Failed to verify alarm state'
          };
        }
      },

      getAlarmStatus: async () => {
        try {
          const alarm = await chrome.alarms.get(AlarmManager.ALARM_NAME);
          if (!alarm && state.isActive) {
            // Alarm missing but should be active, recreate it
            const nextTime = Date.now() + state.notificationInterval * 60000;
            await AlarmManager.setup(state.notificationInterval, false, nextTime);
            state.nextNotificationTime = nextTime;
            await StorageManager.updateSettings({ 
              nextNotificationTime: nextTime 
            });
          }
          
          return {
            success: true,
            nextNotificationTime: state.nextNotificationTime,
            isActive: state.isActive
          };
        } catch (error) {
          console.error('Get alarm status error:', error);
          return {
            success: false,
            error: 'Failed to get alarm status'
          };
        }
      },

      saveApiKey: async ({ apiKey }) => {
        try {
          if (!apiKey?.trim()) {
            return {
              success: false,
              error: 'Please enter your Gemini API key'
            };
          }

          if (!navigator.onLine) {
            return {
              success: false,
              error: 'No internet connection. Please check your network and try again'
            };
          }

          const isValid = await geminiManager.validateApiKey(apiKey);
          if (!isValid) {
            return {
              success: false,
              error: 'Invalid API key. Please check if you have copied the correct Gemini API key'
            };
          }

          const success = await StorageManager.updateSettings({ apiKey });
          if (success) {
            const initSuccess = await geminiManager.init(apiKey);
            if (!initSuccess) {
              return {
                success: false,
                error: 'Could not connect to Gemini API. Please check your internet connection'
              };
            }
            state.apiKey = apiKey;
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Could not save API key. Please try again' 
          };
        } catch (error) {
          console.error('API key update error:', error);
          return { 
            success: false, 
            error: 'Connection error: Please check your internet connection and try again' 
          };
        }
      },

      toggle: async ({ isActive }) => {
        try {
          const success = await StorageManager.updateSettings({ isActive });
          if (success) {
            state.isActive = isActive;
            if (isActive) {
              try {
                await withRetry(() => AlarmManager.setup(undefined, true));
                return { success: true };
              } catch (error) {
                console.error('Failed to setup alarm:', error);
                return { 
                  success: false, 
                  error: 'Failed to start notifications' 
                };
              }
            } else {
              try {
                await AlarmManager.cleanup();
                return { success: true };
              } catch (error) {
                console.error('Failed to clear alarm:', error);
                return { 
                  success: false, 
                  error: 'Failed to stop notifications' 
                };
              }
            }
          }
          return { 
            success: false, 
            error: 'Failed to update notification status' 
          };
        } catch (error) {
          console.error('Toggle error:', error);
          return { 
            success: false, 
            error: 'Operation failed: ' + error.message 
          };
        }
      },

      updateSound: async ({ enabled }) => {
        try {
          const success = await StorageManager.updateSettings({ 
            soundEnabled: enabled 
          });
          if (success) {
            state.soundEnabled = enabled;
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to update sound settings' 
          };
        } catch (error) {
          console.error('Sound update error:', error);
          return { 
            success: false, 
            error: 'Failed to update sound settings: ' + error.message 
          };
        }
      },

      getSettings: async () => {
        try {
          if (!isInitialized) {
            await StorageManager.initialize();
          }
          return { 
            success: true, 
            settings: state 
          };
        } catch (error) {
          console.error('Get settings error:', error);
          return { 
            success: false, 
            error: 'Failed to retrieve settings: ' + error.message 
          };
        }
      },

      saveCustomPrompt: async ({ customPrompt }) => {
        try {
          const success = await StorageManager.updateSettings({ customPrompt });
          if (success) {
            state.customPrompt = customPrompt;
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to save custom prompt' 
          };
        } catch (error) {
          console.error('Custom prompt update error:', error);
          return { 
            success: false, 
            error: 'Failed to update custom prompt: ' + error.message 
          };
        }
      },

      setNextAlert: async ({ minutes }) => {
        if (!state.isActive) {
          return {
            success: false,
            error: 'Please enable notifications first'
          };
        }
        
        if (minutes > state.maxSnoozeMinutes) {
          return { 
            success: false, 
            error: `Time cannot exceed ${state.maxSnoozeMinutes} minutes` 
          };
        }
        
        try {
          const nextTime = Date.now() + minutes * 60000;
          if (nextTime <= Date.now()) {
            return {
              success: false,
              error: 'Cannot set notification time in the past'
            };
          }
          
          const newSnoozeOptions = [
            Math.min(minutes, state.defaultSnoozeOptions[1]),
            Math.max(minutes, state.defaultSnoozeOptions[1])
          ];
          
          const success = await StorageManager.updateSettings({ 
            nextNotificationTime: nextTime,
            defaultSnoozeOptions: newSnoozeOptions
          });
          
          if (success) {
            state.nextNotificationTime = nextTime;
            state.defaultSnoozeOptions = newSnoozeOptions;
            const alarmSuccess = await withRetry(() => AlarmManager.setup(minutes, false, nextTime));
            if (!alarmSuccess) {
              throw new Error('Failed to setup next alert');
            }
            return { success: true };
          }
          return { 
            success: false, 
            error: 'Failed to save next alert time' 
          };
        } catch (error) {
          console.error('Next alert setup error:', error);
          return {
            success: false,
            error: 'Failed to set next alert: ' + error.message
          };
        }
      },
    };

    try {
      const handler = handlers[request.action];
      if (handler) {
        const response = await handler(request);
        sendResponse(response);
      } else {
        console.error('Unknown action:', request.action);
        sendResponse({ 
          success: false, 
          error: 'Unknown action requested' 
        });
      }
    } catch (error) {
      console.error('Message handler error:', error);
      sendResponse({ 
        success: false, 
        error: 'Internal error: ' + error.message 
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
      if (newValue !== undefined) {
        state[key] = newValue;
      }
    });
  }
});

// Critical alarm chain with proper error handling and recovery
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AlarmManager.ALARM_NAME) {
    console.log('Alarm triggered:', new Date().toLocaleString());
    
    try {
      // Ensure proper initialization
      if (!isInitialized) {
        const initSuccess = await StorageManager.initialize();
        if (!initSuccess) {
          throw new Error('Failed to initialize storage');
        }
      }

      // Show notification with retry
      await withRetry(() => notificationManager.show());

      // Clean up old alarm
      await AlarmManager.cleanup();

      // Setup next alarm with retry
      const setupSuccess = await withRetry(() => AlarmManager.setup());
      if (!setupSuccess) {
        throw new Error('Failed to setup next alarm');
      }
    } catch (error) {
      console.error('Critical alarm chain error:', error);
      
      // Recovery attempt
      try {
        await StorageManager.reset();
        await StorageManager.initialize();
        await AlarmManager.setup();
      } catch (recoveryError) {
        console.error('Failed to recover from alarm chain error:', recoveryError);
      }
    }
  }
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  try {
    await notificationManager.clear(notificationId);
    const snoozeMinutes = state.defaultSnoozeOptions[buttonIndex];
    if (snoozeMinutes) {
      await withRetry(() => notificationManager.snooze(snoozeMinutes));
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
  try {
    const stored = await chrome.storage.local.get(null);
    const alarms = await chrome.alarms.getAll();
    
    console.log({
      stored,
      memoryState: state,
      isInitialized,
      alarms
    });
    
    return {
      stored,
      memoryState: state,
      isInitialized,
      alarms
    };
  } catch (error) {
    console.error('Debug state error:', error);
    return null;
  }
}