import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, substituteParams } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { generateRaw } from '../../../../script.js';
import { debounce_timeout } from '../../../constants.js';
import { generateRawWithStops } from './src/custom.js';
import { power_user } from '../../../power-user.js';

export function getCustomModel() {
    return settings.custom_model ? String(settings.custom_model) : '';
}

export function getCustomParameters() {
    return settings.custom_parameters ? String(settings.custom_parameters) : '';
}

const MODULE_NAME = 'sillytavern-editprompt';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let promptMonitorWindow = null;
let messageCounter = 0;
let lastProcessedMessageIndex = -1;
let lastProcessedMessage = '';
let isProcessing = false;
let memoCache = {};

// ---------------------------------------------------------------------------
// Memo cache helpers
// ---------------------------------------------------------------------------

function getCurrentChatId() {
    const context = getContext();
    return context.chatId || context.characterId || 'default';
}

function initializeMemoCache() {
    if (!settings.memo_cache) settings.memo_cache = {};
    memoCache = settings.memo_cache;
}

function getMemoFromCache(chatId, messageIndex, swipeId) {
    return memoCache[chatId]?.[messageIndex]?.swipes?.[swipeId] ?? null;
}

function setMemoInCache(chatId, messageIndex, swipeId, memoContent) {
    if (!memoCache[chatId]) memoCache[chatId] = {};
    if (!memoCache[chatId][messageIndex]) {
        memoCache[chatId][messageIndex] = { swipes: {}, activeSwipe: swipeId };
    }

    memoCache[chatId][messageIndex].swipes[swipeId] = memoContent;
    memoCache[chatId][messageIndex].activeSwipe = swipeId;

    settings.memo_cache = memoCache;
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();

    console.log(`[${MODULE_NAME}] Cached memo for chat:${chatId} msg:${messageIndex} swipe:${swipeId}`);
}

/**
 * Search backwards from `upToIndex` (inclusive) and return the first memo found.
 * Scans all swipe keys as a fallback in case activeSwipe points to a missing key
 * (which can happen after JSON round-trip or if a swipe was deleted mid-session).
 */
function findLatestMemo(chatId, upToIndex) {
    if (upToIndex < 0 || !memoCache[chatId]) return null;

    for (let i = upToIndex; i >= 0; i--) {
        const entry = memoCache[chatId][i];
        if (!entry?.swipes) continue;

        // Prefer the tracked activeSwipe first.
        const preferredSwipe = entry.activeSwipe ?? 0;
        const preferredMemo = entry.swipes[preferredSwipe];
        if (preferredMemo != null && preferredMemo !== '') return preferredMemo;

        // Fallback: scan all swipe keys in descending order.
        const swipeKeys = Object.keys(entry.swipes).map(Number).sort((a, b) => b - a);
        for (const key of swipeKeys) {
            const memo = entry.swipes[key];
            if (memo != null && memo !== '') return memo;
        }
    }
    return null;
}

/**
 * Convenience wrapper: find the latest memo that came BEFORE the given index
 * (i.e. the context that was active when the message at `messageIndex` was generated).
 */
function findLatestMemoBeforeIndex(chatId, messageIndex) {
    return findLatestMemo(chatId, messageIndex - 1);
}

function cleanupMemoCache(chatId, validMessageIndices) {
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

// ---------------------------------------------------------------------------
// Generation config helpers
// ---------------------------------------------------------------------------

const DEFAULT_GENERATION = {
    id: Date.now(),
    enabled: true,
    name: 'Main Prompt',
    mode: 'prompt',
    prompt_name: 'Main Prompt',
    llm_prompt: '[system]You are an expert at creating concise writing instructions.[/system]\n[user]Based on this conversation: {all_messages}\nCreate a brief instruction that captures the writing style and tone.[/user]',
    use_raw: false,
    use_custom_generate_raw: false,
    custom_model: '',
    custom_parameters: '',
    message_count: 5
};

/** Returns all enabled generations whose mode is 'prompt'. */
function getEnabledPromptGenerations() {
    return (settings.generations ?? []).filter(gen => gen.enabled && gen.mode === 'prompt');
}

// ---------------------------------------------------------------------------
// Prompt management
// ---------------------------------------------------------------------------

function getPromptByName(promptName) {
    try {
        const prompts = oai_settings?.prompts;
        if (!Array.isArray(prompts)) {
            console.warn(`[${MODULE_NAME}] Prompts array not accessible`);
            return null;
        }

        const prompt = prompts.find(p => p?.name === promptName);
        if (prompt) return { identifier: prompt.identifier, content: prompt.content || '', promptData: prompt };

        console.warn(`[${MODULE_NAME}] Prompt "${promptName}" not found. Available:`,
            prompts.map(p => p?.name).filter(Boolean));
        return null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error accessing prompts:`, error);
        return null;
    }
}

function updatePromptContent(promptName, newContent) {
    const prompts = oai_settings?.prompts;
    if (!Array.isArray(prompts)) throw new Error('Prompts array not accessible');

    const prompt = prompts.find(p => p?.name === promptName);
    if (!prompt) throw new Error(`Prompt "${promptName}" not found`);

    prompt.content = newContent;
    return savePresetWithPrompts(oai_settings.preset_settings_openai, oai_settings);
}

async function savePresetWithPrompts(presetName, oaiSettings) {
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            apiId: 'openai',
            name: presetName,
            preset: { prompts: oaiSettings.prompts },
        }),
    });

    if (!response.ok) throw new Error(`Failed to save preset: ${response.status}`);

    await response.json();
    console.log(`[${MODULE_NAME}] Successfully saved preset "${presetName}"`);
    eventSource.emit(event_types.SETTINGS_UPDATED);
    return true;
}

// ---------------------------------------------------------------------------
// Prompt restoration helper
// ---------------------------------------------------------------------------

/**
 * Restore (or clear) every enabled prompt generation's content based on what is
 * cached for the current end of `chat`.  Called on chat load, chat change, and
 * after message deletion so the logic lives in one place.
 */
async function restorePromptsForChat(chatId, chat) {
    const promptGens = getEnabledPromptGenerations();
    if (promptGens.length === 0) return;

    if (!chat || chat.length === 0) {
        for (const gen of promptGens) {
            try {
                await updatePromptContent(gen.prompt_name, '');
                console.log(`[${MODULE_NAME}] Cleared prompt "${gen.prompt_name}" (empty chat)`);
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to clear prompt:`, error);
            }
        }
        return;
    }

    // Walk backwards to find the most recent memo in this chat.
    const lastIndex = chat.length - 1;
    const latestMemo = findLatestMemo(chatId, lastIndex);

    for (const gen of promptGens) {
        try {
            await updatePromptContent(gen.prompt_name, latestMemo ?? '');
            console.log(`[${MODULE_NAME}] ${latestMemo ? 'Restored' : 'Cleared'} prompt "${gen.prompt_name}"`);
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to restore/clear prompt "${gen.prompt_name}":`, error);
        }
    }

    updatePromptMonitor();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    settings = extension_settings[MODULE_NAME];

    initializeMemoCache();

    if (!settings.generations || !Array.isArray(settings.generations)) {
        settings.generations = [{ ...DEFAULT_GENERATION }];
    }

    $('#dpm_trigger_mode').val(settings.trigger_mode || 'manual').trigger('input');
    $('#dpm_message_interval').val(settings.message_interval || 3).trigger('input');
    $('#dpm_generate_on_user_message').prop('checked', settings.generate_on_user_message !== false).trigger('input');
    $('#dpm_show_monitor').prop('checked', settings.show_monitor !== false).trigger('input');
    $('#dpm_enabled').prop('checked', settings.enabled !== false).trigger('input');
    $('#dpm_regeneration_mode').val(settings.regeneration_mode || 'normal').trigger('input');

    const context = getContext();
    const chat = context.chat;
    const chatId = getCurrentChatId();

    if (chat && chat.length > 0) {
        const currentIndex = chat.length - 1;
        const currentMessage = chat[currentIndex];
        lastProcessedMessageIndex = currentIndex;
        lastProcessedMessage = `${currentIndex}-${currentMessage.mes}`;
        console.log(`[${MODULE_NAME}] Initialized tracking at message index ${currentIndex}`);

        const validIndices = chat.map((_, idx) => idx);
        cleanupMemoCache(chatId, validIndices);
    }

    await restorePromptsForChat(chatId, chat);
    renderGenerationsList();

    if (settings.show_monitor !== false) showPromptMonitor();

    setTimeout(() => {
        const prompts = oai_settings?.prompts;
        if (Array.isArray(prompts)) {
            console.log(`[${MODULE_NAME}] Available prompts:`,
                prompts.map(p => ({ name: p?.name, identifier: p?.identifier })));
        } else {
            console.warn(`[${MODULE_NAME}] Could not access prompts`);
        }
    }, 1000);
}

function onGlobalInput(event) {
    const id = event.target.id.replace('dpm_', '');

    if (id === 'show_monitor' || id === 'generate_on_user_message' || id === 'enabled') {
        settings[id] = $(event.target).prop('checked');
        if (id === 'show_monitor') {
            settings[id] ? showPromptMonitor() : hidePromptMonitor();
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

// ---------------------------------------------------------------------------
// Generations list UI
// ---------------------------------------------------------------------------

function renderGenerationsList() {
    const $container = $('#dpm_generations_list');
    $container.empty();

    if (!settings.generations || settings.generations.length === 0) {
        settings.generations = [{ ...DEFAULT_GENERATION }];
    }

    settings.generations.forEach((gen, index) => $container.append(createGenerationItem(gen, index)));
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
                    <button class="dpm-gen-move" data-direction="up" title="Move Up"><i class="fa-solid fa-arrow-up"></i></button>
                    <button class="dpm-gen-move" data-direction="down" title="Move Down"><i class="fa-solid fa-arrow-down"></i></button>
                </div>
                <div class="dpm-gen-title">
                    <i class="fa-solid ${modeIcon}"></i>
                    <input type="text" class="dpm-gen-name" value="${gen.name}" placeholder="Generation Name" />
                    <span class="dpm-gen-mode-label">${modeLabel}</span>
                </div>
                <div class="dpm-gen-actions">
                    <button class="dpm-gen-toggle" title="Expand/Collapse"><i class="fa-solid fa-chevron-down"></i></button>
                    <button class="dpm-gen-delete" title="Delete"><i class="fa-solid fa-trash"></i></button>
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
                    <label><input type="checkbox" class="dpm-gen-use-raw" ${gen.use_raw ? 'checked' : ''} /> Use Raw Generation</label>
                    <small>Bypass system instructions and character card</small>
                </div>
                <div class="dpm-gen-field">
                    <label><input type="checkbox" class="dpm-gen-use-custom" ${gen.use_custom_generate_raw ? 'checked' : ''} /> Use Custom Raw Generation Method</label>
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

    $item.find('.dpm-gen-enabled').on('change', function () {
        gen.enabled = $(this).prop('checked');
        saveGenerations();
    });
    $item.find('.dpm-gen-name').on('input', function () {
        gen.name = $(this).val();
        saveGenerations();
    });
    $item.find('.dpm-gen-mode').on('change', function () {
        gen.mode = $(this).val();
        $item.find('.dpm-gen-prompt-field').toggle(gen.mode === 'prompt');
        $item.find('.dpm-gen-mode-label').text(gen.mode === 'prompt' ? 'Edit Prompt' : 'Edit Message');
        $item.find('.dpm-gen-title i').attr('class', `fa-solid ${gen.mode === 'prompt' ? 'fa-file-text' : 'fa-comment'}`);
        saveGenerations();
    });
    $item.find('.dpm-gen-prompt-name').on('input', function () {
        gen.prompt_name = $(this).val();
        saveGenerations();
    });
    $item.find('.dpm-gen-llm-prompt').on('input', function () {
        gen.llm_prompt = $(this).val();
        saveGenerations();
    });
    $item.find('.dpm-gen-use-raw').on('change', function () {
        gen.use_raw = $(this).prop('checked');
        saveGenerations();
    });
    $item.find('.dpm-gen-use-custom').on('change', function () {
        gen.use_custom_generate_raw = $(this).prop('checked');
        saveGenerations();
    });
    $item.find('.dpm-gen-custom-model').on('input', function () {
        gen.custom_model = $(this).val();
        saveGenerations();
    });
    $item.find('.dpm-gen-custom-params').on('input', function () {
        gen.custom_parameters = $(this).val();
        saveGenerations();
    });
    $item.find('.dpm-gen-message-count').on('input', function () {
        const value = parseInt($(this).val());
        gen.message_count = (!isNaN(value) && value >= 0) ? value : 5;
        saveGenerations();
    });
    $item.find('.dpm-gen-toggle').on('click', function () {
        $item.find('.dpm-gen-body').slideToggle(200);
        $(this).find('i').toggleClass('fa-chevron-down fa-chevron-up');
    });
    $item.find('.dpm-gen-delete').on('click', function () {
        if (settings.generations.length <= 1) { toastr.warning('Cannot delete the last generation'); return; }
        if (confirm('Are you sure you want to delete this generation?')) {
            settings.generations.splice(index, 1);
            saveGenerations();
            renderGenerationsList();
        }
    });
    $item.find('.dpm-gen-move').on('click', function () {
        moveGeneration(index, $(this).data('direction'));
    });

    return $item;
}

function moveGeneration(index, direction) {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= settings.generations.length) return;

    [settings.generations[index], settings.generations[newIndex]] =
        [settings.generations[newIndex], settings.generations[index]];

    saveGenerations();
    renderGenerationsList();
}

function saveGenerations() {
    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
    updatePromptMonitor();
}

// ---------------------------------------------------------------------------
// Prompt monitor UI
// ---------------------------------------------------------------------------

function showPromptMonitor() {
    if (promptMonitorWindow) return;

    $('body').append(`
        <div id="dpm_monitor_window">
            <div class="dpm-monitor-header" id="dpm_monitor_header">
                <div class="dpm-monitor-title"><i class="fa-solid fa-eye"></i><span>Generations Monitor</span></div>
                <div class="dpm-monitor-controls">
                    <button class="dpm-monitor-close" id="dpm_monitor_close" title="Close"><i class="fa-solid fa-times"></i></button>
                </div>
            </div>
            <div class="dpm-monitor-body" id="dpm_monitor_body"><div class="dpm-loading">Loading generations...</div></div>
        </div>
    `);

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
    let isDragging = false, startX, startY, initialLeft, initialTop;

    $header.css('cursor', 'move').on('mousedown', (e) => {
        if ($(e.target).closest('.dpm-monitor-close').length > 0) return;
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
        $window.css({
            left: Math.max(0, Math.min(window.innerWidth - $window.outerWidth(), initialLeft + (e.clientX - startX))) + 'px',
            top: Math.max(0, Math.min(window.innerHeight - $window.outerHeight(), initialTop + (e.clientY - startY))) + 'px',
        });
    }).on('mouseup', () => {
        if (isDragging) { isDragging = false; $window.removeClass('dragging'); }
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
        const $content = $genDisplay.find(`#dpm_monitor_gen_${index}`);

        if (gen.mode === 'prompt') {
            const promptInfo = getPromptByName(gen.prompt_name);
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
            $content.html(`
                <div class="dpm-monitor-message-info">
                    <i class="fa-solid fa-info-circle"></i> Will append generated content to last message
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

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function playNotificationSound() {
    try {
        const audio = new Audio(`${extensionFolderPath}/notification.mp3`);
        audio.volume = 0.5;
        audio.play().catch(e => console.log(`[${MODULE_NAME}] Could not play notification sound:`, e));
    } catch (e) {
        console.log(`[${MODULE_NAME}] Audio notification failed:`, e);
    }
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function getVisibleMessages(chat, count) {
    const visible = [];
    const max = count === 0 ? Infinity : count;

    for (let i = chat.length - 1; i >= 0 && visible.length < max; i--) {
        if (!isMessageInvisible(chat[i])) {
            visible.unshift({ name: chat[i].name, mes: chat[i].mes });
        }
    }
    return visible;
}

function isMessageInvisible(message) {
    return message.is_system || message.extra?.isTemporary || message.extra?.invisible;
}

function formatMessages(messages) {
    return messages.map(m => `${m.name}: ${m.mes}`).join('\n\n');
}

function replaceMessageTags(template, messages, promptContent = '') {
    let result = template
        .replace(/{all_messages}/g, formatMessages(messages))
        .replace(/{description}/g, formatMessages(messages))
        .replace(/{previous_messages}/g, messages.length > 1 ? formatMessages(messages.slice(0, -1)) : '')
        .replace(/{previous_messages2}/g, messages.length > 2 ? formatMessages(messages.slice(0, -2)) : '')
        .replace(/{message_last}/g, messages.length > 0 ? `${messages.at(-1).name}: ${messages.at(-1).mes}` : '')
        .replace(/{message_beforelast}/g, messages.length > 1 ? `${messages.at(-2).name}: ${messages.at(-2).mes}` : '')
        .replace(/{prompt}/g, promptContent);
    return result;
}

function parsePromptTemplate(template, messages, promptContent = '') {
    const processed = replaceMessageTags(template, messages, promptContent);
    const messageRegex = /\[(system|user|assistant)\](.*?)\[\/\1\]/gs;
    const parsed = [];
    let match;

    while ((match = messageRegex.exec(processed)) !== null) {
        parsed.push({ role: match[1], content: match[2].trim() });
    }

    if (parsed.length > 0) return parsed;

    const hasMessageTags = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|description|prompt)}/.test(processed);
    if (hasMessageTags) {
        const lines = processed.split('\n').filter(l => l.trim());
        return lines.length > 1
            ? [{ role: 'system', content: lines[0] }, { role: 'user', content: lines.slice(1).join('\n') }]
            : [{ role: 'user', content: processed }];
    }

    return [
        { role: 'system', content: processed || 'Generate a concise instruction based on the conversation.' },
        { role: 'user', content: formatMessages(messages) },
    ];
}

// ---------------------------------------------------------------------------
// Generation execution
// ---------------------------------------------------------------------------

async function executeGeneration(gen) {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) throw new Error('No chat messages available.');

    const visibleMessages = getVisibleMessages(chat, gen.message_count ?? 5);
    if (visibleMessages.length === 0) throw new Error('No visible messages found.');

    let promptContent = '';

    if (gen.mode === 'prompt') {
        if (!getPromptByName(gen.prompt_name)) throw new Error(`Prompt "${gen.prompt_name}" not found.`);

        const chatId = getCurrentChatId();
        const currentIndex = chat.length - 1;
        const currentMessage = chat[currentIndex];
        const currentSwipeId = currentMessage.swipe_id || 0;
        const regenerationMode = settings.regeneration_mode || 'normal';

        if (regenerationMode === 'safe') {
            // Safe mode: always use the memo from before this message's position.
            promptContent = findLatestMemoBeforeIndex(chatId, currentIndex) ?? '';
            console.log(`[${MODULE_NAME}] Safe mode: Using previous-message memo`);
        } else {
            const existingMemo = getMemoFromCache(chatId, currentIndex, currentSwipeId);
            if (existingMemo) {
                // Navigating back to an already-processed swipe — reuse its memo.
                promptContent = existingMemo;
                console.log(`[${MODULE_NAME}] Using cached memo for swipe ${currentSwipeId}`);
            } else {
                // Brand-new swipe/regeneration — seed with the most recent prior memo.
                promptContent = findLatestMemoBeforeIndex(chatId, currentIndex) ?? '';
                console.log(`[${MODULE_NAME}] New swipe ${currentSwipeId}: seeding from previous memo`);
            }
        }
    }

    let newContent;

    if (gen.use_raw) {
        const parsedMessages = parsePromptTemplate(gen.llm_prompt || DEFAULT_GENERATION.llm_prompt, visibleMessages, promptContent);
        const firstSystem = parsedMessages.find(m => m.role === 'system');
        const systemPrompt = firstSystem?.content ?? '';
        const chatMessages = firstSystem
            ? parsedMessages.filter(m => m !== firstSystem).map(m => ({ role: m.role, content: m.content }))
            : parsedMessages.map(m => ({ role: m.role, content: m.content }));
        const prompt = chatMessages.length > 0 ? chatMessages : formatMessages(visibleMessages);

        try {
            if (gen.use_custom_generate_raw) {
                newContent = await generateRawWithStops({
                    systemPrompt,
                    prompt,
                    prefill: '',
                    stopStrings: ['<|im_end|>', '</s>', '[/INST]', '<|endoftext|>', '<END>'],
                });
            } else {
                newContent = await generateRaw({ systemPrompt, prompt, prefill: '' });
            }
        } catch (error) {
            const method = gen.use_custom_generate_raw ? 'generateRawWithStops' : 'generateRaw';
            console.error(`[${MODULE_NAME}] ${method} failed:`, error);
            throw error;
        }
    } else {
        let llmPrompt = gen.llm_prompt || DEFAULT_GENERATION.llm_prompt;
        llmPrompt = /{(all_messages|previous_messages|previous_messages2|message_last|message_beforelast|prompt)}/.test(llmPrompt)
            ? replaceMessageTags(llmPrompt, visibleMessages, promptContent)
            : substituteParams(llmPrompt);

        const { generateQuietPrompt } = await import('../../../../script.js');
        newContent = await generateQuietPrompt(llmPrompt);
    }

    return newContent.replace(/\*/g, '').replace(/"/g, '').replace(/`/g, '').trim();
}

async function applyGeneration(gen, content) {
    if (gen.mode === 'prompt') {
        // Store memo FIRST — before awaiting the preset save.
        // If savePresetWithPrompts throws later (e.g. network error), the memo is
        // already in the cache so restores still work on the next regeneration/deletion.
        const context = getContext();
        const chat = context.chat;
        const chatId = getCurrentChatId();
        const messageIndex = chat.length - 1;
        const swipeId = chat[messageIndex].swipe_id || 0;
        setMemoInCache(chatId, messageIndex, swipeId, content);

        await updatePromptContent(gen.prompt_name, content);
        console.log(`[${MODULE_NAME}] Updated prompt "${gen.prompt_name}" and cached memo`);
    } else {
        const context = getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) throw new Error('No messages to append to');

        const lastIndex = chat.length - 1;
        const lastMessage = chat[lastIndex];
        lastMessage.mes += '\n\n' + content;
        lastProcessedMessage = `${lastIndex}-${lastMessage.mes}`;

        const $mesText = $(`#chat .mes[mesid="${lastIndex}"]`).find('.mes_text');
        if ($mesText.length > 0) {
            const { messageFormatting } = await import('../../../../script.js');
            $mesText.html(messageFormatting(lastMessage.mes, lastMessage.name, lastMessage.is_system, lastMessage.is_user));
        }

        const { saveChatConditional } = await import('../../../../script.js');
        await saveChatConditional();
        console.log(`[${MODULE_NAME}] Appended content to last message`);
    }
}

/** Execute all enabled generations and return result summary. */
async function generateAndUpdatePrompt() {
    const enabledGenerations = (settings.generations ?? []).filter(gen => gen.enabled);
    if (enabledGenerations.length === 0) throw new Error('No enabled generations');

    const results = await Promise.allSettled(
        enabledGenerations.map(async gen => {
            const content = await executeGeneration(gen);
            await applyGeneration(gen, content);
            return gen.name;
        })
    );

    updatePromptMonitor();
    playNotificationSound();

    return results.map((r, i) =>
        r.status === 'fulfilled'
            ? { name: enabledGenerations[i].name, success: true }
            : { name: enabledGenerations[i].name, success: false, error: r.reason?.message }
    );
}

/**
 * Shared runner used by both every_message and interval trigger paths.
 * Sets / clears isProcessing and surfaces toastr feedback.
 */
async function runGenerations() {
    isProcessing = true;
    try {
        const results = await generateAndUpdatePrompt();
        const successCount = results.filter(r => r.success).length;
        toastr.success(`${successCount}/${results.length} generations completed`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Auto-update failed:`, error);
        toastr.error(`Failed to update: ${error.message}`);
    } finally {
        setTimeout(() => {
            isProcessing = false;
            console.log(`[${MODULE_NAME}] Processing flag cleared`);
        }, 500);
    }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onMessageDeleted(messageIndex) {
    console.log(`[${MODULE_NAME}] Message deleted at index: ${messageIndex}`);
    if (settings.enabled === false) return;

    const context = getContext();
    const chat = context.chat;
    const chatId = getCurrentChatId();

    // Remove memos for deleted index and anything beyond it.
    if (memoCache[chatId]) {
        Object.keys(memoCache[chatId]).map(Number)
            .filter(idx => idx >= messageIndex)
            .forEach(idx => delete memoCache[chatId][idx]);

        settings.memo_cache = memoCache;
        extension_settings[MODULE_NAME] = settings;
        saveSettingsDebounced();
        console.log(`[${MODULE_NAME}] Deleted memos for indices >= ${messageIndex}`);
    }

    // Restore prompts by scanning backwards from the new end of the chat.
    // restorePromptsForChat handles the empty-chat case too.
    await restorePromptsForChat(chatId, chat);
}

async function onGenerationStarted() {
    console.log(`[${MODULE_NAME}] Generation started — updating prompts proactively`);
    if (settings.enabled === false) return;

    const context = getContext();
    const chat = context.chat;
    const chatId = getCurrentChatId();
    const promptGens = getEnabledPromptGenerations();
    if (promptGens.length === 0) return;

    if (!chat || chat.length === 0) {
        await restorePromptsForChat(chatId, chat);
        return;
    }

    const lastIndex = chat.length - 1;
    const lastMessage = chat[lastIndex];
    const regenerationMode = settings.regeneration_mode || 'normal';

    for (const gen of promptGens) {
        try {
            let targetMemo;

            if (lastMessage.is_user) {
                // User just submitted — find memo from the last character message
                // (could be anywhere in the history, not necessarily index - 1).
                let lastCharIndex = -1;
                for (let i = lastIndex - 1; i >= 0; i--) {
                    if (!chat[i].is_user && !chat[i].is_system) { lastCharIndex = i; break; }
                }
                targetMemo = lastCharIndex >= 0
                    ? findLatestMemo(chatId, lastCharIndex)
                    : null;
                console.log(`[${MODULE_NAME}] User message: seeding prompt from char-message memo at index ${lastCharIndex}`);
            } else {
                // Regeneration of a character message.
                if (regenerationMode === 'safe') {
                    targetMemo = findLatestMemoBeforeIndex(chatId, lastIndex);
                    console.log(`[${MODULE_NAME}] Safe regen: seeding from previous memo`);
                } else {
                    const currentSwipeId = lastMessage.swipe_id || 0;
                    const existingMemo = getMemoFromCache(chatId, lastIndex, currentSwipeId);
                    if (existingMemo) {
                        // Navigating to an already-generated swipe.
                        targetMemo = existingMemo;
                        console.log(`[${MODULE_NAME}] Regen (existing swipe): restoring swipe memo`);
                    } else {
                        // Brand-new swipe — seed with whatever came before.
                        targetMemo = findLatestMemoBeforeIndex(chatId, lastIndex);
                        console.log(`[${MODULE_NAME}] Regen (new swipe): seeding from previous memo`);
                    }
                }
            }

            await updatePromptContent(gen.prompt_name, targetMemo ?? '');
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to update prompt before generation:`, error);
        }
    }
}

async function onMessageSwiped(messageIndex) {
    console.log(`[${MODULE_NAME}] Message swiped at index: ${messageIndex}`);
    if (settings.enabled === false) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || messageIndex >= chat.length) return;

    const message = chat[messageIndex];
    const swipeId = message.swipe_id || 0;
    const chatId = getCurrentChatId();

    for (const gen of getEnabledPromptGenerations()) {
        const cachedMemo = getMemoFromCache(chatId, messageIndex, swipeId);
        try {
            await updatePromptContent(gen.prompt_name, cachedMemo ?? '');
            console.log(`[${MODULE_NAME}] Swipe ${swipeId}: ${cachedMemo ? 'restored' : 'cleared'} memo for "${gen.prompt_name}"`);
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to update prompt on swipe:`, error);
        }
    }

    updatePromptMonitor();
}

async function onChatChanged() {
    console.log(`[${MODULE_NAME}] Chat changed`);
    if (settings.enabled === false) return;

    const context = getContext();
    const chat = context.chat;
    const chatId = getCurrentChatId();

    console.log(`[${MODULE_NAME}] Switched to chat: ${chatId}`);

    if (chat && chat.length > 0) {
        cleanupMemoCache(chatId, chat.map((_, idx) => idx));
    }

    await restorePromptsForChat(chatId, chat);

    if (chat && chat.length > 0) {
        const currentIndex = chat.length - 1;
        lastProcessedMessageIndex = currentIndex;
        lastProcessedMessage = `${currentIndex}-${chat[currentIndex].mes}`;
    } else {
        lastProcessedMessageIndex = -1;
        lastProcessedMessage = '';
    }
}

async function onCharacterMessage(eventName) {
    console.log(`[${MODULE_NAME}] Event triggered: ${eventName}`);
    if (isProcessing) { console.log(`[${MODULE_NAME}] Already processing, skipping`); return; }
    if (settings.enabled === false) return;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return;

    const triggerMode = settings.trigger_mode || 'manual';
    if (triggerMode === 'manual') return;

    const currentIndex = chat.length - 1;
    const lastMessage = chat[currentIndex];

    if (lastMessage.is_system) return;
    if (lastMessage.is_user && !settings.generate_on_user_message) return;

    const messageId = `${currentIndex}-${lastMessage.mes}`;
    const regenerationMode = settings.regeneration_mode || 'normal';

    if (regenerationMode === 'safe' && currentIndex <= lastProcessedMessageIndex) {
        console.log(`[${MODULE_NAME}] Safe mode: skipping regen at ${currentIndex}`);
        return;
    }

    if (lastProcessedMessage === messageId) {
        console.log(`[${MODULE_NAME}] Skipping already processed message at ${currentIndex}`);
        return;
    }

    console.log(`[${MODULE_NAME}] Processing new message at index ${currentIndex}`);

    if (triggerMode === 'every_message') {
        lastProcessedMessage = messageId;
        lastProcessedMessageIndex = currentIndex;
        await runGenerations();
    } else if (triggerMode === 'interval') {
        if (lastProcessedMessageIndex !== currentIndex) messageCounter++;

        const interval = settings.message_interval || 3;
        console.log(`[${MODULE_NAME}] Counter: ${messageCounter}/${interval}`);

        if (messageCounter >= interval) {
            messageCounter = 0;
            lastProcessedMessage = messageId;
            lastProcessedMessageIndex = currentIndex;
            await runGenerations();
        } else {
            lastProcessedMessage = messageId;
            lastProcessedMessageIndex = currentIndex;
        }
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        $('#dpm_settings input, #dpm_settings textarea, #dpm_settings select').on('input change', onGlobalInput);

        $('#dpm_add_generation').on('click', () => {
            settings.generations.push({
                ...DEFAULT_GENERATION,
                id: Date.now(),
                name: `Generation ${settings.generations.length + 1}`,
            });
            saveGenerations();
            renderGenerationsList();
        });

        $('#dpm_clear_cache').on('click', () => {
            if (!confirm('Clear all cached memos? This cannot be undone.')) return;
            // Assign the SAME object to both so they stay in sync.
            settings.memo_cache = {};
            memoCache = settings.memo_cache;
            extension_settings[MODULE_NAME] = settings;
            saveSettingsDebounced();
            toastr.success('Memo cache cleared');
            console.log(`[${MODULE_NAME}] Memo cache cleared`);
        });

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $('#send_but').before(buttonHtml);

        $('#dpm_generate_button').on('click', async () => {
            if (settings.enabled === false) { toastr.warning('Extension is disabled. Enable it in settings first.'); return; }
            try {
                toastr.info('Executing generations...');
                const results = await generateAndUpdatePrompt();
                const successCount = results.filter(r => r.success).length;
                const failCount = results.length - successCount;
                failCount > 0
                    ? toastr.warning(`Completed: ${successCount} successful, ${failCount} failed`)
                    : toastr.success(`All ${successCount} generations completed!`);
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to execute generations:`, error);
                toastr.error(`Failed: ${error.message}`);
            }
        });

        eventSource.on(event_types.CHAT_GENERATION_STARTED, () => onGenerationStarted());
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => onCharacterMessage('CHARACTER_MESSAGE_RENDERED'));
        eventSource.on(event_types.MESSAGE_SWIPED, (messageIndex) => onMessageSwiped(messageIndex));
        eventSource.on(event_types.MESSAGE_DELETED, (messageIndex) => onMessageDeleted(messageIndex));
        eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged());

        await loadSettings();
        console.log(`[${MODULE_NAME}] Extension initialized`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to initialize:`, error);
    }
});