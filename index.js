import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
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
let currentPromptName = '';
let messageCounter = 0;
let lastProcessedMessageIndex = -1;

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    const settingMappings = [
        { id: '#dpm_llm_prompt', key: 'llm_prompt', defaultValue: '[system]You are an expert at creating concise writing instructions.[/system]\n[user]Based on this conversation: {all_messages}\nCreate a brief instruction that captures the writing style and tone.[/user]' },
        { id: '#dpm_prompt_name', key: 'prompt_name', defaultValue: 'Main Prompt' },
        { id: '#dpm_custom_model', key: 'custom_model', defaultValue: '' },
        { id: '#dpm_custom_parameters', key: 'custom_parameters', defaultValue: '' },
        { id: '#dpm_message_count', key: 'message_count', defaultValue: 5 },
        { id: '#dpm_trigger_mode', key: 'trigger_mode', defaultValue: 'manual' },
        { id: '#dpm_message_interval', key: 'message_interval', defaultValue: 3 }
    ];

    settingMappings.forEach(mapping => {
        const value = settings[mapping.key] || mapping.defaultValue;
        $(mapping.id).val(value).trigger('input');
    });

    $('#dpm_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#dpm_use_custom_generate_raw').prop('checked', !!settings.use_custom_generate_raw).trigger('input');
    $('#dpm_show_monitor').prop('checked', settings.show_monitor !== false).trigger('input');

    currentPromptName = settings.prompt_name || 'Main Prompt';

    if (settings.show_monitor !== false) {
        showPromptMonitor();
    }

    setTimeout(() => {
        const promptCollection = power_user?.instruct;
        if (promptCollection && Array.isArray(promptCollection)) {
            console.log(`[${MODULE_NAME}] Available prompts:`,
                promptCollection.map(p => ({ name: p?.name, identifier: p?.identifier })));
        } else {
            console.warn(`[${MODULE_NAME}] Could not access prompt collection. Structure:`, {
                power_user_exists: !!power_user,
                prompt_manager_exists: !!power_user?.instruct,
            });
        }
    }, 1000);
}

function onInput(event) {
    const id = event.target.id.replace('dpm_', '');

    if (id === 'use_raw' || id === 'use_custom_generate_raw' || id === 'show_monitor') {
        settings[id] = $(event.target).prop('checked');

        if (id === 'show_monitor') {
            if (settings[id]) {
                showPromptMonitor();
            } else {
                hidePromptMonitor();
            }
        }
    } else if (id === 'message_count' || id === 'message_interval') {
        const value = parseInt($(event.target).val());
        settings[id] = (!isNaN(value) && value >= 0) ? value : (id === 'message_count' ? 5 : 3);
    } else {
        settings[id] = $(event.target).val();

        if (id === 'prompt_name') {
            currentPromptName = settings[id];
            updatePromptMonitor();
        }
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

function getPromptByName(promptName) {
    try {
        // Access prompt collection from power_user
        const promptCollection = power_user?.instruct;

        if (!promptCollection || !Array.isArray(promptCollection)) {
            console.warn(`[${MODULE_NAME}] Prompt collection not accessible. power_user.instruct:`, power_user?.instruct);
            return null;
        }

        console.log(`[${MODULE_NAME}] Searching for prompt "${promptName}" in ${promptCollection.length} prompts`);

        // Search through prompts array to find matching name
        const prompt = promptCollection.find(p => p && p.name === promptName);

        if (prompt) {
            console.log(`[${MODULE_NAME}] Found prompt:`, prompt);
            return {
                identifier: prompt.identifier,
                content: prompt.content || '',
                promptData: prompt
            };
        }

        console.warn(`[${MODULE_NAME}] Prompt "${promptName}" not found. Available prompts:`,
            promptCollection.map(p => p?.name).filter(Boolean));
        return null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error accessing prompts:`, error);
        return null;
    }
}

function updatePromptContent(promptName, newContent) {
    try {
        const promptCollection = power_user?.instruct;

        if (!promptCollection || !Array.isArray(promptCollection)) {
            throw new Error('Prompt collection not accessible');
        }

        // Find the prompt in the array
        const prompt = promptCollection.find(p => p && p.name === promptName);

        if (!prompt) {
            throw new Error(`Prompt "${promptName}" not found`);
        }

        // Update the content
        prompt.content = newContent;

        // Trigger save through prompt manager if available
        if (power_user.prompt_manager && typeof power_user.prompt_manager.savePrompts === 'function') {
            power_user.prompt_manager.savePrompts();
        } else {
            // Fallback: emit settings update event
            eventSource.emit(event_types.SETTINGS_UPDATED);
        }

        console.log(`[${MODULE_NAME}] Updated prompt "${promptName}" with ${newContent.length} characters`);
        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error updating prompt:`, error);
        throw error;
    }
}


function showPromptMonitor() {
    if (promptMonitorWindow) {
        return; // Already shown
    }

    const monitorHtml = `
        <div id="dpm_monitor_window">
            <div class="dpm-monitor-header" id="dpm_monitor_header">
                <div class="dpm-monitor-title">
                    <i class="fa-solid fa-eye"></i>
                    <span>Prompt Monitor</span>
                </div>
                <button class="dpm-monitor-close" id="dpm_monitor_close" title="Close">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="dpm-monitor-body">
                <div class="dpm-prompt-name">
                    <strong>Prompt:</strong> <span id="dpm_current_prompt_name">${currentPromptName}</span>
                </div>
                <div class="dpm-prompt-content" id="dpm_prompt_content">
                    <span class="dpm-loading">Loading prompt...</span>
                </div>
                <div class="dpm-char-count">
                    <span id="dpm_prompt_char_count">0</span> characters
                </div>
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

    const promptInfo = getPromptByName(currentPromptName);

    $('#dpm_current_prompt_name').text(currentPromptName);

    if (promptInfo) {
        const content = promptInfo.content || '(empty)';
        $('#dpm_prompt_content').html(`<pre>${escapeHtml(content)}</pre>`);
        $('#dpm_prompt_char_count').text(content.length);
    } else {
        $('#dpm_prompt_content').html('<span class="dpm-error">Prompt not found. Please check the name in settings.</span>');
        $('#dpm_prompt_char_count').text('0');
    }
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

function replaceMessageTags(template, messages) {
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

    // Add support for {prompt} tag - insert current prompt content
    const promptInfo = getPromptByName(currentPromptName);
    const promptContent = promptInfo ? promptInfo.content : '';
    result = result.replace(/{prompt}/g, promptContent);

    return result;
}

function parsePromptTemplate(template, messages) {
    const processedTemplate = replaceMessageTags(template, messages);

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

async function generateAndUpdatePrompt() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error(`[${MODULE_NAME}] No chat messages available.`);
    }

    const promptName = settings.prompt_name || 'Main Prompt';
    const promptInfo = getPromptByName(promptName);

    if (!promptInfo) {
        throw new Error(`[${MODULE_NAME}] Prompt "${promptName}" not found. Please check the prompt name in settings.`);
    }

    let newPromptContent;

    if (settings.use_raw) {
        const messageCount = settings.message_count ?? 5;
        const visibleMessages = getVisibleMessages(chat, messageCount);

        if (visibleMessages.length === 0) {
            throw new Error(`[${MODULE_NAME}] No visible messages found.`);
        }

        const instructionTemplate = settings.llm_prompt || '[system]Create a brief instruction.[/system]\n[user]{all_messages}[/user]';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

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
            if (settings.use_custom_generate_raw === true) {
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
                newPromptContent = result;
            } else {
                const result = await generateRaw({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: ''
                });
                console.log(`[${MODULE_NAME}] generateRaw result:`, result);
                newPromptContent = result;
            }
        } catch (error) {
            const methodName = settings.use_custom_generate_raw ? "generateRawWithStops" : "generateRaw";
            console.error(`[${MODULE_NAME}] ${methodName} failed:`, error);
            throw error;
        }
    } else {
        const messageCount = settings.message_count ?? 5;
        const visibleMessages = getVisibleMessages(chat, messageCount);

        let llmPrompt = settings.llm_prompt || 'Create a brief instruction based on: {all_messages}';

        if (/{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|prompt)}/.test(llmPrompt)) {
            llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        } else {
            llmPrompt = substituteParams(llmPrompt);
        }

        const { generateQuietPrompt } = await import('../../../../script.js');
        newPromptContent = await generateQuietPrompt(llmPrompt);
    }

    // Clean up the generated content
    newPromptContent = newPromptContent
        .replace(/\*/g, "")
        .replace(/\"/g, "")
        .replace(/`/g, "")
        .trim();

    // Update the prompt
    updatePromptContent(promptName, newPromptContent);

    // Update monitor display
    updatePromptMonitor();

    // Play notification sound
    playNotificationSound();

    console.log(`[${MODULE_NAME}] Successfully updated prompt "${promptName}"`);

    return newPromptContent;
}

async function onCharacterMessage(data) {
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) return;

    const triggerMode = settings.trigger_mode || 'manual';

    if (triggerMode === 'manual') {
        return; // Don't auto-trigger
    }

    // Get the last message
    const lastMessage = chat[chat.length - 1];

    // Check if it's from the character (not user, not system)
    if (lastMessage.is_user || lastMessage.is_system) {
        return;
    }

    const currentMessageIndex = chat.length - 1;

    // Avoid processing the same message twice
    if (currentMessageIndex <= lastProcessedMessageIndex) {
        return;
    }

    if (triggerMode === 'every_message') {
        console.log(`[${MODULE_NAME}] Triggering on every character message`);
        lastProcessedMessageIndex = currentMessageIndex;

        try {
            await generateAndUpdatePrompt();
            toastr.success('Prompt updated automatically');
        } catch (error) {
            console.error(`[${MODULE_NAME}] Auto-update failed:`, error);
            toastr.error(`Failed to update prompt: ${error.message}`);
        }
    } else if (triggerMode === 'interval') {
        messageCounter++;
        const interval = settings.message_interval || 3;

        console.log(`[${MODULE_NAME}] Message counter: ${messageCounter}/${interval}`);

        if (messageCounter >= interval) {
            console.log(`[${MODULE_NAME}] Triggering on message interval`);
            messageCounter = 0;
            lastProcessedMessageIndex = currentMessageIndex;

            try {
                await generateAndUpdatePrompt();
                toastr.success('Prompt updated automatically');
            } catch (error) {
                console.error(`[${MODULE_NAME}] Auto-update failed:`, error);
                toastr.error(`Failed to update prompt: ${error.message}`);
            }
        }
    }
}

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#dpm_settings input, #dpm_settings textarea, #dpm_settings select").on("input change", onInput);

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        $("#dpm_generate_button").on("click", async () => {
            try {
                toastr.info('Generating prompt update...');
                await generateAndUpdatePrompt();
                toastr.success('Prompt updated successfully!');
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to update prompt:`, error);
                toastr.error(`Failed to update prompt: ${error.message}`);
            }
        });

        // Listen for character messages
        eventSource.on(event_types.MESSAGE_RECEIVED, onCharacterMessage);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessage);

        await loadSettings();

        console.log(`[${MODULE_NAME}] Extension initialized successfully`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to initialize extension:`, error);
    }
});