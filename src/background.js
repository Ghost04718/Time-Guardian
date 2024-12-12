// Constants
const DEFAULT_SETTINGS = {
  isActive: true,
  soundEnabled: false,
  nextNotificationTime: null, // Actual time
  notificationInterval: 3,
  notificationDuration: 45000, // 45 seconds
  maxSnoozeMinutes: 180,
  defaultSnoozeOptions: [5, 15],
  apiKey: null,
  defaultPrompt: 'Generate a short, friendly time reminder with emojis.',
  customPrompt: null
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

  async validateApiKey(apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
      
      // 尝试生成一个简单的测试消息来验证 API key
      const result = await model.generateContent("Hello");
      return result?.response ? true : false;
    } catch (error) {
      console.error('API key validation failed:', error);
      return false;
    }
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
      let promptTemplate = 'Based on the webpage title "{title}", URL "{url}" and current time "{timeString}", ';
      const promptContent = state.customPrompt || state.defaultPrompt;
      promptTemplate += promptContent;
      
      const finalPrompt = promptTemplate
        .replace('{title}', title)
        .replace('{url}', url)
        .replace('{timeString}', timeString);

      const result = await this.model.generateContent(finalPrompt);
      
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

  static async setup(minutes = state.notificationInterval, immediately = false, nextTime = null) {
    try {
      if (minutes <= 0 || minutes > state.maxSnoozeMinutes) {
        console.error('Invalid interval:', minutes);
        return false;
      }

      if (nextTime && nextTime <= Date.now()) {
        console.error('Next time must be in the future');
        return false;
      }

      // 检查是否已存在相同的闹钟
      const existingAlarm = await chrome.alarms.get(this.ALARM_NAME);
      if (existingAlarm) {
        const sameTime = nextTime && Math.abs(existingAlarm.scheduledTime - nextTime) < 1000;
        const sameInterval = !nextTime && existingAlarm.periodInMinutes === minutes;
        if (sameTime || sameInterval) {
          console.log('Identical alarm already exists');
          return true;
        }
      }

      // 使用原子操作来更新状态和创建闹钟
      const updates = {
        nextNotificationTime: null  // 先清除旧的时间
      };
      await StorageManager.updateSettings(updates);
      state.nextNotificationTime = null;

      if (!state.isActive) {
        console.log('Notifications inactive, no new alarm created');
        return false;
      }

      const now = Date.now();
      const actualNextTime = nextTime || (immediately ? now : now + minutes * 60000);

      const alarmInfo = {
        periodInMinutes: minutes
      };

      if (nextTime || immediately) {
        alarmInfo.when = actualNextTime;
      }

      try {
        await chrome.alarms.create(this.ALARM_NAME, alarmInfo);
        console.log('Created new alarm:', alarmInfo);

        const success = await StorageManager.updateSettings({ 
          nextNotificationTime: actualNextTime 
        });
        
        if (success) {
          state.nextNotificationTime = actualNextTime;
          console.log('Next notification time updated:', new Date(state.nextNotificationTime).toLocaleString());
          await this.verifySchedule();
          return true;
        }

        return false;
      } catch (error) {
        console.error('Failed to create alarm:', error);
        throw error;
      }
    } catch (error) {
      console.error('Error in setupAlarm:', error);
      throw error;
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
      } else {
        console.error('Failed to clear next notification time');
        return false;
      }
    } catch (error) {
      console.error('Error in cleanup:', error);
      throw error;
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
      message = `⏰ Time Check: ${timeString}\n⏱️ Next reminder in ${typeof nextTime === 'string' ? nextTime : nextTime + ' minutes'}\n💡 Click buttons below to snooze`;
    }

    try {
      await chrome.notifications.create(notificationId, {
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
    if (minutes > state.maxSnoozeMinutes) {
      console.error('Snooze duration exceeds maximum allowed time');
      return false;
    }

    try {
      // Calculate new snooze options
      const newSnoozeOptions = [
        Math.min(minutes, state.defaultSnoozeOptions[1]),
        Math.max(minutes, state.defaultSnoozeOptions[1])
      ];

      // Update storage with new values
      const success = await StorageManager.updateSettings({
        defaultSnoozeOptions: newSnoozeOptions,
        nextNotificationTime: Date.now() + minutes * 60000
      });

      if (!success) {
        throw new Error('Failed to update snooze settings');
      }

      // 更新内存中的状态
      state.defaultSnoozeOptions = newSnoozeOptions;

      const alarmSuccess = await AlarmManager.setup(minutes);
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
class MessageHandler {
  static async handle(request, sender, sendResponse) {
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
            const updates = { notificationInterval: minutes, nextNotificationTime: Date.now() + minutes * 60000 };
            const success = await StorageManager.updateSettings(updates);
            
            if (success) {
              state.notificationInterval = minutes;
              const alarmSuccess = await AlarmManager.setup(minutes);
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
      saveApiKey: async ({ apiKey }) => {
        try {
          if (!apiKey.trim()) {
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
            const initSuccess = geminiManager.init(apiKey);
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
                await AlarmManager.setup(undefined, true);
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
          
          // 计算新的贪睡选项
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
            const alarmSuccess = await AlarmManager.setup(minutes, false, nextTime);
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