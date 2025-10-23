import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

const MODULE_NAME = 'prompt-regenerator';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let floatingWindow = null;
let isGenerating = false;

// Default settings
const DEFAULT_SETTINGS = {
    target_prompt_name: 'Infoblock_generated',
    llm_prompt_template: 'Based on the following conversation, generate a new information block that summarizes the key details:\n\n{all_messages}\n\nProvide a concise, structured summary:',
    custom_model: '',
    custom_parameters: '',
    message_count: 5,
    use_raw: false,
    auto_generate: false,
    auto_generate_frequency: 1,
    show_floating_window: true,
    window_position: { x: 100, y: 100 }
};

let messagesSinceLastGeneration = 0;

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    settings = extension_settings[MODULE_NAME];

    // Ensure all default settings exist
    Object.keys(DEFAULT_SETTINGS).forEach(key => {
        if (settings[key] === undefined) {
            settings[key] = DEFAULT_SETTINGS[key];
        }
    });

    // Load UI values
    $('#prompt_regen_target_name').val(settings.target_prompt_name).trigger('input');
    $('#prompt_regen_llm_template').val(settings.llm_prompt_template).trigger('input');
    $('#prompt_regen_custom_model').val(settings.custom_model || '').trigger('input');
    $('#prompt_regen_custom_params').val(settings.custom_parameters || '').trigger('input');
    $('#prompt_regen_message_count').val(settings.message_count).trigger('input');
    $('#prompt_regen_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#prompt_regen_auto_generate').prop('checked', !!settings.auto_generate).trigger('input');
    $('#prompt_regen_auto_freq').val(settings.auto_generate_frequency).trigger('input');
    $('#prompt_regen_show_window').prop('checked', settings.show_floating_window !== false).trigger('input');

    console.log(`[${MODULE_NAME}] Settings loaded`, settings);
}

function onInput(event) {
    const id = event.target.id.replace('prompt_regen_', '');

    if (id === 'use_raw' || id === 'auto_generate' || id === 'show_window') {
        const key = id === 'show_window' ? 'show_floating_window' : id;
        settings[key] = $(event.target).prop('checked');
    } else if (id === 'message_count' || id === 'auto_freq') {
        const value = parseInt($(event.target).val());
        const key = id === 'auto_freq' ? 'auto_generate_frequency' : id;
        settings[key] = (!isNaN(value) && value >= 0) ? value : DEFAULT_SETTINGS[key];
    } else {
        const keyMap = {
            'target_name': 'target_prompt_name',
            'llm_template': 'llm_prompt_template',
            'custom_model': 'custom_model',
            'custom_params': 'custom_parameters'
        };
        const key = keyMap[id] || id;
        settings[key] = $(event.target).val();
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

// Get visible messages from chat
function getVisibleMessages(chat, count) {
    const visibleMessages = [];
    const maxMessages = count === 0 ? Infinity : count;

    for (let i = chat.length - 1; i >= 0 && visibleMessages.length < maxMessages; i--) {
        const message = chat[i];
        if (message.is_system || message.extra?.isTemporary || message.extra?.invisible) {
            continue;
        }
        visibleMessages.unshift({
            name: message.name,
            mes: message.mes
        });
    }

    return visibleMessages;
}

function formatMessages(messages) {
    return messages.map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
}

function replaceMessageTags(template, messages) {
    let result = template;
    result = result.replace(/{all_messages}/g, formatMessages(messages));

    if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        result = result.replace(/{message_last}/g, `${lastMessage.name}: ${lastMessage.mes}`);
    } else {
        result = result.replace(/{message_last}/g, '');
    }

    return result;
}

// Find prompt in Chat Completion preset
function findPromptInPreset(promptName) {
    try {
        // Check if we're using Chat Completion
        if (!power_user?.chat_completion_source) {
            throw new Error('Not using Chat Completion API. This extension requires Chat Completion mode.');
        }

        // Access the prompts array
        const prompts = power_user.prompts;
        if (!prompts || !Array.isArray(prompts)) {
            throw new Error('No prompts found in current preset');
        }

        // Find by identifier or name
        const prompt = prompts.find(p =>
            p.identifier === promptName ||
            p.name === promptName
        );

        if (!prompt) {
            const availableNames = prompts.map(p => p.identifier || p.name).join(', ');
            throw new Error(`Prompt "${promptName}" not found. Available prompts: ${availableNames}`);
        }

        return prompt;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error finding prompt:`, error);
        throw error;
    }
}

// Update prompt content
async function updatePromptContent(promptName, newContent) {
    try {
        const prompt = findPromptInPreset(promptName);

        // Store old content for logging
        const oldContent = prompt.content;

        // Update the prompt content
        prompt.content = newContent;

        // Save the settings (power_user is saved as part of settings)
        const response = await fetch('/api/settings/set', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                key: 'power_user',
                value: power_user
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to save settings: ${response.status}`);
        }

        console.log(`[${MODULE_NAME}] Updated prompt "${promptName}"`);
        console.log(`[${MODULE_NAME}] Old content length: ${oldContent?.length || 0} chars`);
        console.log(`[${MODULE_NAME}] New content length: ${newContent.length} chars`);

        return true;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error updating prompt:`, error);
        throw error;
    }
}

// Generate new prompt content using LLM
async function generateNewPromptContent() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error('No chat messages available');
    }

    const messageCount = settings.message_count || DEFAULT_SETTINGS.message_count;
    const visibleMessages = getVisibleMessages(chat, messageCount);

    if (visibleMessages.length === 0) {
        throw new Error('No visible messages found to base generation on');
    }

    const template = settings.llm_prompt_template || DEFAULT_SETTINGS.llm_prompt_template;
    const promptText = replaceMessageTags(template, visibleMessages);

    console.log(`[${MODULE_NAME}] Generating with ${visibleMessages.length} messages`);
    console.log(`[${MODULE_NAME}] Template length: ${template.length} chars`);

    let generatedContent;

    try {
        if (settings.use_raw) {
            // Use raw generation
            const params = {
                prompt: promptText,
                systemPrompt: '',
                responseLength: null
            };

            console.log(`[${MODULE_NAME}] Using generateRaw`);
            generatedContent = await generateRaw(params);
        } else {
            // Use quiet prompt
            console.log(`[${MODULE_NAME}] Using generateQuietPrompt`);
            generatedContent = await generateQuietPrompt(promptText);
        }

        if (!generatedContent || typeof generatedContent !== 'string') {
            throw new Error('No content generated or invalid response type');
        }

        console.log(`[${MODULE_NAME}] Generated ${generatedContent.length} chars`);
        return generatedContent.trim();
    } catch (error) {
        console.error(`[${MODULE_NAME}] Generation failed:`, error);
        throw new Error(`LLM generation failed: ${error.message}`);
    }
}

// Main regeneration function
async function regeneratePrompt() {
    if (isGenerating) {
        toastr.warning('Generation already in progress');
        return;
    }

    const targetPromptName = settings.target_prompt_name || DEFAULT_SETTINGS.target_prompt_name;

    isGenerating = true;
    updateFloatingWindow('Generating...', 'generating');

    try {
        console.log(`[${MODULE_NAME}] Starting regeneration for "${targetPromptName}"`);

        // Check if prompt exists first
        const prompt = findPromptInPreset(targetPromptName);
        console.log(`[${MODULE_NAME}] Found target prompt, current length: ${prompt.content?.length || 0} chars`);

        // Generate new content
        const newContent = await generateNewPromptContent();
        console.log(`[${MODULE_NAME}] Content generated successfully`);

        // Update the prompt
        await updatePromptContent(targetPromptName, newContent);
        console.log(`[${MODULE_NAME}] Prompt updated successfully`);

        // Update UI
        updateFloatingWindow(newContent, 'success');
        playNotificationSound();

        toastr.success(`Prompt "${targetPromptName}" regenerated successfully!`);

    } catch (error) {
        console.error(`[${MODULE_NAME}] Regeneration failed:`, error);
        const errorMsg = error.message || 'Unknown error';
        updateFloatingWindow(`Error: ${errorMsg}`, 'error');
        toastr.error(`Failed to regenerate: ${errorMsg}`);
    } finally {
        isGenerating = false;
    }
}

// Floating window management
function createFloatingWindow() {
    if (floatingWindow) return;

    const windowHtml = `
        <div id="prompt_regen_window" class="prompt-regen-floating">
            <div class="prompt-regen-header">
                <div class="prompt-regen-title">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    <span>Prompt Regenerator</span>
                </div>
                <button class="prompt-regen-close" title="Hide Window">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="prompt-regen-content">
                <div class="prompt-regen-status">Ready</div>
                <textarea class="prompt-regen-preview" readonly placeholder="Generated prompt will appear here..."></textarea>
            </div>
        </div>
    `;

    $('body').append(windowHtml);
    floatingWindow = $('#prompt_regen_window');

    // Apply saved position
    if (settings.window_position) {
        floatingWindow.css({
            left: settings.window_position.x + 'px',
            top: settings.window_position.y + 'px'
        });
    }

    // Make draggable
    makeWindowDraggable();

    // Bind close button
    floatingWindow.find('.prompt-regen-close').on('click', () => {
        floatingWindow.hide();
        settings.show_floating_window = false;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
    });

    // Show if enabled
    if (settings.show_floating_window !== false) {
        floatingWindow.show();
    }
}

function makeWindowDraggable() {
    const $window = floatingWindow;
    const $header = $window.find('.prompt-regen-header');

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    $header.css('cursor', 'move');

    $header.on('mousedown', (e) => {
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

            // Save position
            const rect = $window[0].getBoundingClientRect();
            settings.window_position = {
                x: rect.left,
                y: rect.top
            };
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
        }
    });
}

function updateFloatingWindow(text, status) {
    if (!floatingWindow) return;

    const $status = floatingWindow.find('.prompt-regen-status');
    const $preview = floatingWindow.find('.prompt-regen-preview');

    const statusText = {
        'generating': 'Generating...',
        'success': 'Complete!',
        'error': 'Error',
        'ready': 'Ready'
    }[status] || 'Ready';

    $status.text(statusText);
    $status.removeClass('status-generating status-success status-error')
        .addClass(`status-${status}`);

    $preview.val(text);

    // Show window if generation completes and setting is enabled
    if ((status === 'success' || status === 'error') && settings.show_floating_window !== false) {
        floatingWindow.show();
    }
}

function playNotificationSound() {
    try {
        const audio = new Audio();
        audio.src = `${extensionFolderPath}/message.mp3`;
        audio.volume = 0.5;
        audio.play().catch(error => {
            console.log(`[${MODULE_NAME}] Could not play notification:`, error);
        });
    } catch (error) {
        console.log(`[${MODULE_NAME}] Audio notification failed:`, error);
    }
}

// Auto-generation on message events
function onMessageReceived() {
    if (!settings.auto_generate) return;

    messagesSinceLastGeneration++;

    const frequency = settings.auto_generate_frequency || 1;
    if (messagesSinceLastGeneration >= frequency) {
        messagesSinceLastGeneration = 0;

        console.log(`[${MODULE_NAME}] Auto-generation triggered`);

        // Delay to let chat update
        setTimeout(() => {
            regeneratePrompt();
        }, 500);
    }
}

// Initialize extension
jQuery(async () => {
    try {
        console.log(`[${MODULE_NAME}] Initializing extension...`);

        // Load settings HTML
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#prompt_regen_settings input, #prompt_regen_settings textarea").on("input", onInput);

        // Load button HTML
        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        // Bind button click
        $("#prompt_regen_button").on("click", async () => {
            await regeneratePrompt();
        });

        // Create floating window
        createFloatingWindow();

        // Load settings
        await loadSettings();

        // Listen to message events for auto-generation
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageReceived);

        console.log(`[${MODULE_NAME}] Extension initialized successfully`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to initialize:`, error);
        toastr.error(`Prompt Regenerator failed to load: ${error.message}`);
    }
});