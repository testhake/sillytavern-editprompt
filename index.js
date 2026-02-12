import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { generateRawWithStops } from './src/custom.js';
import { power_user } from '../../../power-user.js';

export function getCustomModel() {
    if (!settings.custom_model) {
        return '';
    }
    return String(settings.custom_model);
}

export function getCustomParameters() {
    if (!settings.custom_parameters) {
        return '';
    }
    return String(settings.custom_parameters);
}

const MODULE_NAME = 'sillytavern-editprompt';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let promptMonitorWindow = null;
let messageCounter = 0;
let lastProcessedMessageIndex = -1;
let lastProcessedMessage = '';
let isProcessing = false; // Flag to prevent recursive triggers
let memoCache = {}; // In-memory cache, synced with settings

// Memo cache helper functions
function getCurrentChatId() {
    const context = getContext();
    return context.chatId || context.characterId || 'default';
}

function initializeMemoCache() {
    if (!settings.memo_cache) {
        settings.memo_cache = {};
    }
    memoCache = settings.memo_cache;
}

function getMemoFromCache(chatId, messageIndex, swipeId) {
    if (!memoCache[chatId]) return null;
    if (!memoCache[chatId][messageIndex]) return null;
    if (!memoCache[chatId][messageIndex].swipes) return null;
    return memoCache[chatId][messageIndex].swipes[swipeId] || null;
}

function setMemoInCache(chatId, messageIndex, swipeId, memoContent) {
    if (!memoCache[chatId]) {
        memoCache[chatId] = {};
    }
    if (!memoCache[chatId][messageIndex]) {
        memoCache[chatId][messageIndex] = {
            swipes: {},
            activeSwipe: swipeId
        };
    }
    
    memoCache[chatId][messageIndex].swipes[swipeId] = memoContent;
    memoCache[chatId][messageIndex].activeSwipe = swipeId;
    
    // Persist to settings
    settings.memo_cache = memoCache;
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    
    console.log(`[${MODULE_NAME}] Cached memo for chat:${chatId} msg:${messageIndex} swipe:${swipeId}`);
}

function getPreviousMessageMemo(chatId, messageIndex) {
    // Get memo from previous message (using its active swipe)
    if (messageIndex <= 0) return null;
    
    const prevIndex = messageIndex - 1;
    if (!memoCache[chatId] || !memoCache[chatId][prevIndex]) return null;
    
    const prevMessage = memoCache[chatId][prevIndex];
    const activeSwipeId = prevMessage.activeSwipe || 0;
    
    return prevMessage.swipes[activeSwipeId] || null;
}

function cleanupMemoCache(chatId, validMessageIndices) {
    // Remove memos for messages that no longer exist
    if (!memoCache[chatId]) return;
    
    const cachedIndices = Object.keys(memoCache[chatId]).map(Number);
    let cleaned = 0;
    
    for (const index of cachedIndices) {
        if (!validMessageIndices.includes(index)) {
            delete memoCache[chatId][index];
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        settings.memo_cache = memoCache;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
        console.log(`[${MODULE_NAME}] Cleaned ${cleaned} orphaned memos from cache`);
    }
}

// Default generation config
const DEFAULT_GENERATION = {
    id: Date.now(),
    enabled: true,
    name: 'Main Prompt',
    mode: 'prompt', // 'prompt' or 'message'
    prompt_name: 'Main Prompt',
    llm_prompt: '[system]You are an expert at creating concise writing instructions.[/system]\n[user]Based on this conversation: {all_messages}\nCreate a brief instruction that captures the writing style and tone.[/user]',
    use_raw: false,
    use_custom_generate_raw: false,
    custom_model: '',
    custom_parameters: '',
    message_count: 5
};

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    // Initialize memo cache
    initializeMemoCache();

    // Initialize generations array if it doesn't exist
    if (!settings.generations || !Array.isArray(settings.generations)) {
        settings.generations = [{ ...DEFAULT_GENERATION }];
    }

    // Load global settings
    $('#dpm_trigger_mode').val(settings.trigger_mode || 'manual').trigger('input');
    $('#dpm_message_interval').val(settings.message_interval || 3).trigger('input');
    $('#dpm_generate_on_user_message').prop('checked', settings.generate_on_user_message !== false).trigger('input');
    $('#dpm_show_monitor').prop('checked', settings.show_monitor !== false).trigger('input');
    $('#dpm_enabled').prop('checked', settings.enabled !== false).trigger('input');
    $('#dpm_regeneration_mode').val(settings.regeneration_mode || 'normal').trigger('input');

    // Initialize tracking to current state to prevent processing existing messages on load
    const context = getContext();
    const chat = context.chat;
    if (chat && chat.length > 0) {
        const currentIndex = chat.length - 1;
        const currentMessage = chat[currentIndex];
        lastProcessedMessageIndex = currentIndex;
        lastProcessedMessage = `${currentIndex}-${currentMessage.mes}`;
        console.log(`[${MODULE_NAME}] Initialized tracking at message index ${currentIndex}`);
        
        // Cleanup orphaned memos
        const chatId = getCurrentChatId();
        const validIndices = chat.map((_, idx) => idx);
        cleanupMemoCache(chatId, validIndices);
    }

    // Render generations list
    renderGenerationsList();

    if (settings.show_monitor !== false) {
        showPromptMonitor();
    }

    setTimeout(() => {
        const prompts = oai_settings?.prompts;
        if (prompts && Array.isArray(prompts)) {
            console.log(`[${MODULE_NAME}] Available prompts:`,
                prompts.map(p => ({ name: p?.name, identifier: p?.identifier })));
        } else {
            console.warn(`[${MODULE_NAME}] Could not access prompts. Structure:`, {
                oai_settings_exists: !!oai_settings,
                prompts_type: typeof oai_settings?.prompts,
                prompts_is_array: Array.isArray(oai_settings?.prompts)
            });
        }
    }, 1000);
}

function onGlobalInput(event) {
    const id = event.target.id.replace('dpm_', '');

    if (id === 'show_monitor' || id === 'generate_on_user_message' || id === 'enabled') {
        settings[id] = $(event.target).prop('checked');

        if (id === 'show_monitor') {
            if (settings[id]) {
                showPromptMonitor();
            } else {
                hidePromptMonitor();
            }
        }
    } else if (id === 'message_interval') {
        const value = parseInt($(event.target).val());
        settings[id] = (!isNaN(value) && value >= 0) ? value : 3;
    } else {
        settings[id] = $(event.target).val();
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

function renderGenerationsList() {
    const $container = $('#dpm_generations_list');
    $container.empty();

    if (!settings.generations || settings.generations.length === 0) {
        settings.generations = [{ ...DEFAULT_GENERATION }];
    }

    settings.generations.forEach((gen, index) => {
        const $item = createGenerationItem(gen, index);
        $container.append($item);
    });

    // Update monitor if visible
    updatePromptMonitor();
}

function createGenerationItem(gen, index) {
    const modeLabel = gen.mode === 'prompt' ? 'Edit Prompt' : 'Edit Message';
    const modeIcon = gen.mode === 'prompt' ? 'fa-file-text' : 'fa-comment';
    
    const $item = $(`
        <div class="dpm-generation-item" data-index="${index}">
            <div class="dpm-gen-header">
                <div class="dpm-gen-controls">
                    <input type="checkbox" class="dpm-gen-enabled" ${gen.enabled ? 'checked' : ''} />
                    <button class="dpm-gen-move" data-direction="up" title="Move Up">
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button class="dpm-gen-move" data-direction="down" title="Move Down">
                        <i class="fa-solid fa-arrow-down"></i>
                    </button>
                </div>
                <div class="dpm-gen-title">
                    <i class="fa-solid ${modeIcon}"></i>
                    <input type="text" class="dpm-gen-name" value="${gen.name}" placeholder="Generation Name" />
                    <span class="dpm-gen-mode-label">${modeLabel}</span>
                </div>
                <div class="dpm-gen-actions">
                    <button class="dpm-gen-toggle" title="Expand/Collapse">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                    <button class="dpm-gen-delete" title="Delete">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            <div class="dpm-gen-body" style="display: none;">
                <div class="dpm-gen-field">
                    <label>Mode</label>
                    <select class="dpm-gen-mode">
                        <option value="prompt" ${gen.mode === 'prompt' ? 'selected' : ''}>Edit Prompt</option>
                        <option value="message" ${gen.mode === 'message' ? 'selected' : ''}>Edit Message</option>
                    </select>
                    <small>Choose whether to edit a completion preset prompt or append to the last message</small>
                </div>
                
                <div class="dpm-gen-field dpm-gen-prompt-field" style="${gen.mode === 'message' ? 'display: none;' : ''}">
                    <label>Target Prompt Name</label>
                    <input type="text" class="dpm-gen-prompt-name" value="${gen.prompt_name || 'Main Prompt'}" placeholder="Main Prompt" />
                    <small>Name of the prompt from Chat Completion Presets to modify</small>
                </div>
                
                <div class="dpm-gen-field">
                    <label>LLM Prompt Template</label>
                    <textarea class="dpm-gen-llm-prompt" rows="6">${gen.llm_prompt || DEFAULT_GENERATION.llm_prompt}</textarea>
                    <small>Template for generating content. Use tags like {all_messages}, {prompt}, etc.</small>
                </div>
                
                <div class="dpm-gen-field">
                    <label>
                        <input type="checkbox" class="dpm-gen-use-raw" ${gen.use_raw ? 'checked' : ''} />
                        Use Raw Generation
                    </label>
                    <small>Bypass system instructions and character card</small>
                </div>
                
                <div class="dpm-gen-field">
                    <label>
                        <input type="checkbox" class="dpm-gen-use-custom" ${gen.use_custom_generate_raw ? 'checked' : ''} />
                        Use Custom Raw Generation Method
                    </label>
                    <small>Custom method with stopping strings</small>
                </div>
                
                <div class="dpm-gen-field">
                    <label>Custom Model (Optional)</label>
                    <input type="text" class="dpm-gen-custom-model" value="${gen.custom_model || ''}" placeholder="Leave blank to use current model" />
                </div>
                
                <div class="dpm-gen-field">
                    <label>Custom Parameters (Optional)</label>
                    <input type="text" class="dpm-gen-custom-params" value="${gen.custom_parameters || ''}" placeholder="Leave blank to use current parameters" />
                </div>
                
                <div class="dpm-gen-field">
                    <label>Messages to Include</label>
                    <input type="number" class="dpm-gen-message-count" min="0" max="50" value="${gen.message_count || 5}" />
                    <small>Number of recent visible messages to include (0 = all messages)</small>
                </div>
            </div>
        </div>
    `);

    // Bind events
    $item.find('.dpm-gen-enabled').on('change', function() {
        gen.enabled = $(this).prop('checked');
        saveGenerations();
    });

    $item.find('.dpm-gen-name').on('input', function() {
        gen.name = $(this).val();
        saveGenerations();
    });

    $item.find('.dpm-gen-mode').on('change', function() {
        gen.mode = $(this).val();
        const $promptField = $item.find('.dpm-gen-prompt-field');
        const modeLabel = gen.mode === 'prompt' ? 'Edit Prompt' : 'Edit Message';
        const modeIcon = gen.mode === 'prompt' ? 'fa-file-text' : 'fa-comment';
        
        if (gen.mode === 'message') {
            $promptField.hide();
        } else {
            $promptField.show();
        }
        
        $item.find('.dpm-gen-mode-label').text(modeLabel);
        $item.find('.dpm-gen-title i').attr('class', `fa-solid ${modeIcon}`);
        saveGenerations();
    });

    $item.find('.dpm-gen-prompt-name').on('input', function() {
        gen.prompt_name = $(this).val();
        saveGenerations();
    });

    $item.find('.dpm-gen-llm-prompt').on('input', function() {
        gen.llm_prompt = $(this).val();
        saveGenerations();
    });

    $item.find('.dpm-gen-use-raw').on('change', function() {
        gen.use_raw = $(this).prop('checked');
        saveGenerations();
    });

    $item.find('.dpm-gen-use-custom').on('change', function() {
        gen.use_custom_generate_raw = $(this).prop('checked');
        saveGenerations();
    });

    $item.find('.dpm-gen-custom-model').on('input', function() {
        gen.custom_model = $(this).val();
        saveGenerations();
    });

    $item.find('.dpm-gen-custom-params').on('input', function() {
        gen.custom_parameters = $(this).val();
        saveGenerations();
    });

    $item.find('.dpm-gen-message-count').on('input', function() {
        const value = parseInt($(this).val());
        gen.message_count = (!isNaN(value) && value >= 0) ? value : 5;
        saveGenerations();
    });

    $item.find('.dpm-gen-toggle').on('click', function() {
        const $body = $item.find('.dpm-gen-body');
        const $icon = $(this).find('i');
        $body.slideToggle(200);
        $icon.toggleClass('fa-chevron-down fa-chevron-up');
    });

    $item.find('.dpm-gen-delete').on('click', function() {
        if (settings.generations.length <= 1) {
            toastr.warning('Cannot delete the last generation');
            return;
        }
        if (confirm('Are you sure you want to delete this generation?')) {
            settings.generations.splice(index, 1);
            saveGenerations();
            renderGenerationsList();
        }
    });

    $item.find('.dpm-gen-move').on('click', function() {
        const direction = $(this).data('direction');
        moveGeneration(index, direction);
    });

    return $item;
}

function moveGeneration(index, direction) {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (newIndex < 0 || newIndex >= settings.generations.length) {
        return;
    }

    const temp = settings.generations[index];
    settings.generations[index] = settings.generations[newIndex];
    settings.generations[newIndex] = temp;

    saveGenerations();
    renderGenerationsList();
}

function saveGenerations() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    updatePromptMonitor();
}

function getPromptByName(promptName) {
    try {
        const prompts = oai_settings?.prompts;

        if (!prompts || !Array.isArray(prompts)) {
            console.warn(`[${MODULE_NAME}] Prompts array not accessible. oai_settings.prompts:`, oai_settings?.prompts);
            return null;
        }

        console.log(`[${MODULE_NAME}] Searching for prompt "${promptName}" in ${prompts.length} prompts`);

        const prompt = prompts.find(p => p && p.name === promptName);

        if (prompt) {
            console.log(`[${MODULE_NAME}] Found prompt:`, prompt);
            return {
                identifier: prompt.identifier,
                content: prompt.content || '',
                promptData: prompt
            };
        }

        console.warn(`[${MODULE_NAME}] Prompt "${promptName}" not found. Available prompts:`,
            prompts.map(p => p?.name).filter(Boolean));
        return null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error accessing prompts:`, error);
        return null;
    }
}

function updatePromptContent(promptName, newContent) {
    try {
        const prompts = oai_settings?.prompts;

        if (!prompts || !Array.isArray(prompts)) {
            throw new Error('Prompts array not accessible');
        }

        const prompt = prompts.find(p => p && p.name === promptName);

        if (!prompt) {
            throw new Error(`Prompt "${promptName}" not found`);
        }

        prompt.content = newContent;

        const presetName = oai_settings.preset_settings_openai;

        return savePresetWithPrompts(presetName, oai_settings);

    } catch (error) {
        console.error(`[${MODULE_NAME}] Error updating prompt:`, error);
        throw error;
    }
}

async function savePresetWithPrompts(presetName, settings) {
    try {
        const response = await fetch('/api/presets/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                apiId: 'openai',
                name: presetName,
                preset: {
                    prompts: settings.prompts,
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to save preset: ${response.status}`);
        }

        const data = await response.json();
        console.log(`[${MODULE_NAME}] Successfully saved preset "${presetName}"`);

        eventSource.emit(event_types.SETTINGS_UPDATED);

        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error saving preset:`, error);
        throw error;
    }
}

function showPromptMonitor() {
    if (promptMonitorWindow) {
        return;
    }

    const monitorHtml = `
        <div id="dpm_monitor_window">
            <div class="dpm-monitor-header" id="dpm_monitor_header">
                <div class="dpm-monitor-title">
                    <i class="fa-solid fa-eye"></i>
                    <span>Generations Monitor</span>
                </div>
                <div class="dpm-monitor-controls">
                    <button class="dpm-monitor-close" id="dpm_monitor_close" title="Close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
            </div>
            <div class="dpm-monitor-body" id="dpm_monitor_body">
                <div class="dpm-loading">Loading generations...</div>
            </div>
        </div>
    `;

    $('body').append(monitorHtml);
    promptMonitorWindow = $('#dpm_monitor_window');

    makeMonitorDraggable();
    bindMonitorEvents();
    updatePromptMonitor();
}

function hidePromptMonitor() {
    if (promptMonitorWindow) {
        promptMonitorWindow.remove();
        promptMonitorWindow = null;
    }
}

function makeMonitorDraggable() {
    const $window = $('#dpm_monitor_window');
    const $header = $('#dpm_monitor_header');

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    $header.css('cursor', 'move');

    $header.on('mousedown', (e) => {
        if ($(e.target).closest('.dpm-monitor-close').length > 0) {
            return;
        }

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = $window[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        $window.addClass('dragging');
        e.preventDefault();
    });

    $(document).on('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const newLeft = Math.max(0, Math.min(window.innerWidth - $window.outerWidth(), initialLeft + deltaX));
        const newTop = Math.max(0, Math.min(window.innerHeight - $window.outerHeight(), initialTop + deltaY));

        $window.css({
            left: newLeft + 'px',
            top: newTop + 'px'
        });
    });

    $(document).on('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            $window.removeClass('dragging');
        }
    });
}

function bindMonitorEvents() {
    $('#dpm_monitor_close').on('click', () => {
        hidePromptMonitor();
        $('#dpm_show_monitor').prop('checked', false);
        settings.show_monitor = false;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
    });
}

function updatePromptMonitor() {
    if (!promptMonitorWindow) return;

    const $body = $('#dpm_monitor_body');
    $body.empty();

    if (!settings.generations || settings.generations.length === 0) {
        $body.html('<div class="dpm-loading">No generations configured</div>');
        return;
    }

    settings.generations.forEach((gen, index) => {
        const $genDisplay = $(`
            <div class="dpm-monitor-gen ${gen.enabled ? '' : 'dpm-monitor-gen-disabled'}">
                <div class="dpm-monitor-gen-header">
                    <i class="fa-solid ${gen.mode === 'prompt' ? 'fa-file-text' : 'fa-comment'}"></i>
                    <strong>${escapeHtml(gen.name)}</strong>
                    <span class="dpm-monitor-gen-mode">${gen.mode === 'prompt' ? 'Prompt' : 'Message'}</span>
                    ${!gen.enabled ? '<span class="dpm-monitor-gen-status">(Disabled)</span>' : ''}
                </div>
                <div class="dpm-monitor-gen-content" id="dpm_monitor_gen_${index}">
                    <div class="dpm-loading">Loading...</div>
                </div>
            </div>
        `);

        $body.append($genDisplay);

        if (gen.mode === 'prompt') {
            const promptInfo = getPromptByName(gen.prompt_name);
            const $content = $genDisplay.find(`#dpm_monitor_gen_${index}`);
            
            if (promptInfo) {
                const content = promptInfo.content || '(empty)';
                $content.html(`
                    <div class="dpm-monitor-prompt-name">Target: ${escapeHtml(gen.prompt_name)}</div>
                    <pre>${escapeHtml(content)}</pre>
                    <div class="dpm-monitor-char-count">${content.length} characters</div>
                `);
            } else {
                $content.html('<span class="dpm-error">Prompt not found</span>');
            }
        } else {
            // For message mode, show a placeholder
            const $content = $genDisplay.find(`#dpm_monitor_gen_${index}`);
            $content.html(`
                <div class="dpm-monitor-message-info">
                    <i class="fa-solid fa-info-circle"></i>
                    Will append generated content to last message
                </div>
            `);
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function playNotificationSound() {
    try {
        const audio = new Audio();
        audio.src = `${extensionFolderPath}/notification.mp3`;
        audio.volume = 0.5;
        audio.play().catch(error => {
            console.log(`[${MODULE_NAME}] Could not play notification sound:`, error);
        });
    } catch (error) {
        console.log(`[${MODULE_NAME}] Audio notification failed:`, error);
    }
}

function getVisibleMessages(chat, count) {
    const visibleMessages = [];
    const maxMessages = count === 0 ? Infinity : count;

    for (let i = chat.length - 1; i >= 0 && visibleMessages.length < maxMessages; i--) {
        const message = chat[i];

        if (isMessageInvisible(message)) {
            continue;
        }

        visibleMessages.unshift({
            name: message.name,
            mes: message.mes
        });
    }

    return visibleMessages;
}

function isMessageInvisible(message) {
    return message.is_system ||
        message.extra?.isTemporary ||
        message.extra?.invisible;
}

function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

function replaceMessageTags(template, messages, promptContent = '') {
    let result = template;

    result = result.replace(/{all_messages}/g, formatMessages(messages));
    result = result.replace(/{description}/g, formatMessages(messages));

    if (messages.length > 1) {
        result = result.replace(/{previous_messages}/g, formatMessages(messages.slice(0, -1)));
    } else {
        result = result.replace(/{previous_messages}/g, '');
    }

    if (messages.length > 2) {
        result = result.replace(/{previous_messages2}/g, formatMessages(messages.slice(0, -2)));
    } else {
        result = result.replace(/{previous_messages2}/g, '');
    }

    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        result = result.replace(/{message_last}/g, `${lastMessage.name}: ${lastMessage.mes}`);
    } else {
        result = result.replace(/{message_last}/g, '');
    }

    if (messages.length > 1) {
        const beforeLastMessage = messages[messages.length - 2];
        result = result.replace(/{message_beforelast}/g, `${beforeLastMessage.name}: ${beforeLastMessage.mes}`);
    } else {
        result = result.replace(/{message_beforelast}/g, '');
    }

    result = result.replace(/{prompt}/g, promptContent);

    return result;
}

function parsePromptTemplate(template, messages, promptContent = '') {
    const processedTemplate = replaceMessageTags(template, messages, promptContent);

    const messageRegex = /\[(system|user|assistant)\](.*?)\[\/\1\]/gs;

    const parsedMessages = [];
    let hasStructuredMessages = false;
    let match;

    while ((match = messageRegex.exec(processedTemplate)) !== null) {
        hasStructuredMessages = true;
        const role = match[1];
        const content = match[2].trim();

        parsedMessages.push({
            role: role,
            content: content
        });
    }

    if (!hasStructuredMessages) {
        const hasMessageTags = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|description|prompt)}/.test(processedTemplate);

        if (hasMessageTags) {
            const lines = processedTemplate.split('\n').filter(line => line.trim());
            if (lines.length > 1) {
                parsedMessages.push({
                    role: 'system',
                    content: lines[0]
                });
                parsedMessages.push({
                    role: 'user',
                    content: lines.slice(1).join('\n')
                });
            } else {
                parsedMessages.push({
                    role: 'user',
                    content: processedTemplate
                });
            }
        } else {
            parsedMessages.push({
                role: 'system',
                content: processedTemplate || 'Generate a concise instruction based on the conversation.'
            });
            parsedMessages.push({
                role: 'user',
                content: formatMessages(messages)
            });
        }
    }

    return parsedMessages;
}

async function executeGeneration(gen) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error(`No chat messages available.`);
    }

    const messageCount = gen.message_count ?? 5;
    const visibleMessages = getVisibleMessages(chat, messageCount);

    if (visibleMessages.length === 0) {
        throw new Error(`No visible messages found.`);
    }

    // For prompt mode, get the appropriate memo from cache
    let promptContent = '';
    if (gen.mode === 'prompt') {
        const promptInfo = getPromptByName(gen.prompt_name);
        if (!promptInfo) {
            throw new Error(`Prompt "${gen.prompt_name}" not found.`);
        }
        
        // Get the current memo based on regeneration mode
        const chatId = getCurrentChatId();
        const currentMessageIndex = chat.length - 1;
        const currentMessage = chat[currentMessageIndex];
        const currentSwipeId = currentMessage.swipe_id || 0;
        const regenerationMode = settings.regeneration_mode || 'normal';
        
        if (regenerationMode === 'safe') {
            // Safe mode: Use memo from previous message
            promptContent = getPreviousMessageMemo(chatId, currentMessageIndex) || promptInfo.content;
            console.log(`[${MODULE_NAME}] Safe mode: Using previous message memo`);
        } else {
            // Normal/Aggressive mode: Check if this is a regeneration
            const existingMemo = getMemoFromCache(chatId, currentMessageIndex, currentSwipeId);
            
            if (existingMemo) {
                // This swipe already has a memo (we're navigating back to it)
                promptContent = existingMemo;
                console.log(`[${MODULE_NAME}] Using cached memo for swipe ${currentSwipeId}`);
            } else {
                // New swipe - check if there are other swipes at this index
                const hasOtherSwipes = memoCache[chatId]?.[currentMessageIndex]?.swipes && 
                                      Object.keys(memoCache[chatId][currentMessageIndex].swipes).length > 0;
                
                if (hasOtherSwipes) {
                    // This is a new regeneration - use previous message's memo
                    promptContent = getPreviousMessageMemo(chatId, currentMessageIndex) || promptInfo.content;
                    console.log(`[${MODULE_NAME}] New regeneration detected: Using previous message memo`);
                } else {
                    // First time processing this message index - use current prompt
                    promptContent = promptInfo.content;
                    console.log(`[${MODULE_NAME}] First time at this index: Using current prompt`);
                }
            }
        }
    }

    let newContent;

    if (gen.use_raw) {
        const instructionTemplate = gen.llm_prompt || DEFAULT_GENERATION.llm_prompt;
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages, promptContent);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.length > 0) {
            const hasSystemMessages = parsedMessages.some(msg => msg.role === 'system');

            if (hasSystemMessages) {
                const firstSystemMessage = parsedMessages.find(msg => msg.role === 'system');
                systemPrompt = firstSystemMessage.content;

                const chatMessages = [];
                let firstSystemFound = false;

                for (const msg of parsedMessages) {
                    if (msg.role === 'system' && !firstSystemFound) {
                        firstSystemFound = true;
                        continue;
                    }

                    chatMessages.push({
                        role: msg.role,
                        content: msg.content
                    });
                }

                prompt = chatMessages;
            } else {
                systemPrompt = '';
                prompt = parsedMessages.map(msg => ({
                    role: msg.role,
                    content: msg.content
                }));
            }
        } else {
            systemPrompt = 'Generate a concise instruction based on the conversation.';
            prompt = formatMessages(visibleMessages);
        }

        try {
            if (gen.use_custom_generate_raw === true) {
                const result = await generateRawWithStops({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: '',
                    stopStrings: [
                        '<|im_end|>',
                        '</s>',
                        '[/INST]',
                        '<|endoftext|>',
                        '<END>'
                    ],
                });
                console.log(`[${MODULE_NAME}] generateRawWithStops result:`, result);
                newContent = result;
            } else {
                const result = await generateRaw({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: ''
                });
                console.log(`[${MODULE_NAME}] generateRaw result:`, result);
                newContent = result;
            }
        } catch (error) {
            const methodName = gen.use_custom_generate_raw ? "generateRawWithStops" : "generateRaw";
            console.error(`[${MODULE_NAME}] ${methodName} failed:`, error);
            throw error;
        }
    } else {
        let llmPrompt = gen.llm_prompt || DEFAULT_GENERATION.llm_prompt;

        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|prompt)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages, promptContent);
        } else {
            llmPrompt = substituteParams(llmPrompt);
        }

        const { generateQuietPrompt } = await import('../../../../script.js');
        newContent = await generateQuietPrompt(llmPrompt);
    }

    // Clean up the generated content
    newContent = newContent
        .replace(/\*/g, "")
        .replace(/\"/g, "")
        .replace(/`/g, "")
        .trim();

    return newContent;
}

async function applyGeneration(gen, content) {
    if (gen.mode === 'prompt') {
        // Update prompt
        await updatePromptContent(gen.prompt_name, content);
        
        // Store memo in cache
        const context = getContext();
        const chat = context.chat;
        const chatId = getCurrentChatId();
        const messageIndex = chat.length - 1;
        const currentMessage = chat[messageIndex];
        const swipeId = currentMessage.swipe_id || 0;
        
        setMemoInCache(chatId, messageIndex, swipeId, content);
        
        console.log(`[${MODULE_NAME}] Updated prompt "${gen.prompt_name}" and cached memo`);
    } else {
        // Append to last message
        const context = getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0) {
            throw new Error('No messages to append to');
        }

        const lastMessageIndex = chat.length - 1;
        const lastMessage = chat[lastMessageIndex];
        lastMessage.mes += '\n\n' + content;
        
        // Update the lastProcessedMessage to include the new content
        // This prevents the modified message from being processed again
        lastProcessedMessage = `${lastMessageIndex}-${lastMessage.mes}`;
        
        // Directly update the DOM without triggering events
        const $messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);
        if ($messageElement.length > 0) {
            // Find the message text container and update it
            const $mesText = $messageElement.find('.mes_text');
            if ($mesText.length > 0) {
                // Use SillyTavern's message formatting
                const { messageFormatting } = await import('../../../../script.js');
                const formattedContent = messageFormatting(lastMessage.mes, lastMessage.name, lastMessage.is_system, lastMessage.is_user);
                $mesText.html(formattedContent);
            }
        }
        
        // Save chat without triggering events
        const { saveChatConditional } = await import('../../../../script.js');
        await saveChatConditional();
        
        console.log(`[${MODULE_NAME}] Appended content to last message and refreshed UI`);
    }
}

async function generateAndUpdatePrompt() {
    const enabledGenerations = settings.generations.filter(gen => gen.enabled);

    if (enabledGenerations.length === 0) {
        throw new Error('No enabled generations');
    }

    const results = [];

    for (const gen of enabledGenerations) {
        try {
            console.log(`[${MODULE_NAME}] Executing generation: ${gen.name}`);
            const content = await executeGeneration(gen);
            await applyGeneration(gen, content);
            results.push({ name: gen.name, success: true });
        } catch (error) {
            console.error(`[${MODULE_NAME}] Generation "${gen.name}" failed:`, error);
            results.push({ name: gen.name, success: false, error: error.message });
        }
    }

    // Update monitor display
    updatePromptMonitor();

    // Play notification sound
    playNotificationSound();

    return results;
}

async function onMessageSwiped(messageIndex) {
    console.log(`[${MODULE_NAME}] Message swiped at index: ${messageIndex}`);
    
    if (settings.enabled === false) {
        return;
    }
    
    const context = getContext();
    const chat = context.chat;
    
    if (!chat || messageIndex >= chat.length) return;
    
    const message = chat[messageIndex];
    const swipeId = message.swipe_id || 0;
    const chatId = getCurrentChatId();
    
    console.log(`[${MODULE_NAME}] Swipe navigation: index=${messageIndex}, swipeId=${swipeId}`);
    
    // Check each generation to see if it's in prompt mode
    const promptGenerations = settings.generations.filter(gen => gen.enabled && gen.mode === 'prompt');
    
    for (const gen of promptGenerations) {
        // Check if we have a cached memo for this swipe
        const cachedMemo = getMemoFromCache(chatId, messageIndex, swipeId);
        
        if (cachedMemo) {
            // Update the prompt with the cached memo
            try {
                await updatePromptContent(gen.prompt_name, cachedMemo);
                console.log(`[${MODULE_NAME}] Restored cached memo for "${gen.prompt_name}" from swipe ${swipeId}`);
                updatePromptMonitor();
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to restore cached memo:`, error);
            }
        } else {
            console.log(`[${MODULE_NAME}] No cached memo found for swipe ${swipeId}, will generate on next trigger`);
            // The memo will be generated when the next message arrives or user triggers manually
        }
    }
}

async function onCharacterMessage(eventName) {
    console.log(`[${MODULE_NAME}] Event triggered: ${eventName}`);
    
    // Prevent recursive calls while processing
    if (isProcessing) {
        console.log(`[${MODULE_NAME}] Already processing, skipping this event`);
        return;
    }
    
    if (settings.enabled === false) {
        return;
    }
    
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) return;

    const triggerMode = settings.trigger_mode || 'manual';

    if (triggerMode === 'manual') {
        return;
    }

    const currentMessageIndex = chat.length - 1;
    const lastMessage = chat[currentMessageIndex];

    // Skip system messages always
    if (lastMessage.is_system) {
        console.log(`[${MODULE_NAME}] Skipping system message`);
        return;
    }
    
    // Skip user messages unless generate_on_user_message is enabled
    if (lastMessage.is_user && !settings.generate_on_user_message) {
        console.log(`[${MODULE_NAME}] Skipping user message (generate_on_user_message is disabled)`);
        return;
    }
    
    // Create a unique identifier for this specific message content
    const messageId = `${currentMessageIndex}-${lastMessage.mes}`;
    
    // Prevent processing the same message twice
    if (lastProcessedMessage === messageId) {
        console.log(`[${MODULE_NAME}] Skipping already processed message at index ${currentMessageIndex} (messageId: ${messageId.substring(0, 50)}...)`);
        return;
    }

    console.log(`[${MODULE_NAME}] Processing new message at index ${currentMessageIndex}`);

    if (triggerMode === 'every_message') {
        console.log(`[${MODULE_NAME}] Triggering on character message at index ${currentMessageIndex}`);
        lastProcessedMessage = messageId;
        lastProcessedMessageIndex = currentMessageIndex;

        // Set processing flag
        isProcessing = true;
        try {
            const results = await generateAndUpdatePrompt();
            const successCount = results.filter(r => r.success).length;
            toastr.success(`${successCount}/${results.length} generations completed`);
        } catch (error) {
            console.error(`[${MODULE_NAME}] Auto-update failed:`, error);
            toastr.error(`Failed to update: ${error.message}`);
        } finally {
            // Clear processing flag after a short delay to allow UI to settle
            setTimeout(() => {
                isProcessing = false;
                console.log(`[${MODULE_NAME}] Processing flag cleared`);
            }, 500);
        }
    } else if (triggerMode === 'interval') {
        // Only increment counter if this is a NEW message index (not a swipe/regeneration)
        if (lastProcessedMessageIndex !== currentMessageIndex) {
            messageCounter++;
        }
        
        const interval = settings.message_interval || 3;
        console.log(`[${MODULE_NAME}] Message counter: ${messageCounter}/${interval}`);

        if (messageCounter >= interval) {
            console.log(`[${MODULE_NAME}] Triggering on message interval`);
            messageCounter = 0;
            lastProcessedMessage = messageId;
            lastProcessedMessageIndex = currentMessageIndex;

            // Set processing flag
            isProcessing = true;
            try {
                const results = await generateAndUpdatePrompt();
                const successCount = results.filter(r => r.success).length;
                toastr.success(`${successCount}/${results.length} generations completed`);
            } catch (error) {
                console.error(`[${MODULE_NAME}] Auto-update failed:`, error);
                toastr.error(`Failed to update: ${error.message}`);
            } finally {
                // Clear processing flag after a short delay to allow UI to settle
                setTimeout(() => {
                    isProcessing = false;
                    console.log(`[${MODULE_NAME}] Processing flag cleared`);
                }, 500);
            }
        } else {
            // Update tracking even if not triggering yet
            lastProcessedMessage = messageId;
            lastProcessedMessageIndex = currentMessageIndex;
        }
    }
}


jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#dpm_settings input, #dpm_settings textarea, #dpm_settings select").on("input change", onGlobalInput);

        // Add generation button
        $('#dpm_add_generation').on('click', () => {
            const newGen = {
                ...DEFAULT_GENERATION,
                id: Date.now(),
                name: `Generation ${settings.generations.length + 1}`
            };
            settings.generations.push(newGen);
            saveGenerations();
            renderGenerationsList();
        });

        // Clear cache button
        $('#dpm_clear_cache').on('click', () => {
            if (confirm('Are you sure you want to clear all cached memos? This cannot be undone.')) {
                memoCache = {};
                settings.memo_cache = {};
                extension_settings[MODULE_NAME] = settings;
                saveSettingsDebounced();
                toastr.success('Memo cache cleared successfully');
                console.log(`[${MODULE_NAME}] Memo cache cleared`);
            }
        });

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        $("#dpm_generate_button").on("click", async () => {
            if (settings.enabled === false) {
                toastr.warning('Extension is disabled. Enable it in settings first.');
                return;
            }
            try {
                toastr.info('Executing generations...');
                const results = await generateAndUpdatePrompt();
                const successCount = results.filter(r => r.success).length;
                const failCount = results.filter(r => !r.success).length;
                
                if (failCount > 0) {
                    toastr.warning(`Completed: ${successCount} successful, ${failCount} failed`);
                } else {
                    toastr.success(`All ${successCount} generations completed!`);
                }
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to execute generations:`, error);
                toastr.error(`Failed: ${error.message}`);
            }
        });

        // Listen only to CHARACTER_MESSAGE_RENDERED which fires once per character message
        // This includes both new messages and swipes/regenerations
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => onCharacterMessage('CHARACTER_MESSAGE_RENDERED'));
        
        // Listen to MESSAGE_SWIPED to update prompts when navigating between swipes
        eventSource.on(event_types.MESSAGE_SWIPED, (messageIndex) => onMessageSwiped(messageIndex));
        
        // Listen to CHAT_CHANGED to cleanup memo cache when switching chats
        eventSource.on(event_types.CHAT_CHANGED, () => {
            const context = getContext();
            const chat = context.chat;
            if (chat && chat.length > 0) {
                const chatId = getCurrentChatId();
                const validIndices = chat.map((_, idx) => idx);
                cleanupMemoCache(chatId, validIndices);
                console.log(`[${MODULE_NAME}] Chat changed, cleaned up memo cache`);
            }
        });

        await loadSettings();

        console.log(`[${MODULE_NAME}] Extension initialized successfully`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to initialize extension:`, error);
    }
});