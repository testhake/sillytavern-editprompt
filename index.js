import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { saveBase64AsFile, getBase64Async } from '../../../utils.js';
import { generateRawWithStops } from './src/custom.js';

const MODULE_NAME = 'prompt-regenerator';
const extensionFolderPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let settings = {};
let regenerationQueue = [];
let isProcessingQueue = false;
let previewModal = null;
let messageCounter = 0;

class RegenerationQueueItem {
    constructor(promptIdentifier, customPrompt = false) {
        this.id = Date.now() + Math.random();
        this.promptIdentifier = promptIdentifier;
        this.customPrompt = customPrompt;
        this.status = 'pending';
        this.error = null;
        this.createdAt = Date.now();
        this.result = null;
    }
}

async function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    settings = extension_settings[MODULE_NAME];

    const settingMappings = [
        { id: '#prompt_regen_identifier', key: 'prompt_identifier', defaultValue: 'Infoblock_generated' },
        { id: '#prompt_regen_template', key: 'llm_prompt_template', defaultValue: 'Generate an updated version based on the conversation: {all_messages}' },
        { id: '#prompt_regen_custom_model', key: 'custom_model', defaultValue: '' },
        { id: '#prompt_regen_custom_parameters', key: 'custom_parameters', defaultValue: '' },
        { id: '#prompt_regen_message_count', key: 'message_count', defaultValue: 5 },
        { id: '#prompt_regen_trigger_interval', key: 'trigger_interval', defaultValue: 0 }
    ];

    settingMappings.forEach(mapping => {
        $(mapping.id).val(settings[mapping.key] || mapping.defaultValue).trigger('input');
    });

    $('#prompt_regen_show_preview').prop('checked', !!settings.show_preview).trigger('input');
    $('#prompt_regen_use_raw').prop('checked', !!settings.use_raw).trigger('input');
    $('#prompt_regen_use_custom_generate_raw').prop('checked', !!settings.use_custom_generate_raw).trigger('input');
    $('#prompt_regen_auto_trigger').prop('checked', !!settings.auto_trigger).trigger('input');

    messageCounter = 0;
}

function onInput(event) {
    const id = event.target.id.replace('prompt_regen_', '');

    if (['show_preview', 'use_raw', 'use_custom_generate_raw', 'auto_trigger'].includes(id)) {
        settings[id] = $(event.target).prop('checked');
    } else if (id === 'message_count' || id === 'trigger_interval') {
        const value = parseInt($(event.target).val());
        settings[id] = (!isNaN(value) && value >= 0) ? value : (id === 'message_count' ? 5 : 0);
    } else {
        settings[id] = $(event.target).val();
    }

    extension_settings[MODULE_NAME] = settings;
    saveSettingsDebounced();
}

async function findPromptByIdentifier(promptIdentifier) {
    const context = getContext();

    // Access power_user settings which contain prompt manager data
    const power_user = context.power_user || window.power_user;

    if (!power_user || !power_user.prompts) {
        throw new Error('Prompt manager data not accessible');
    }

    // Search through all prompts
    for (const [promptId, promptData] of Object.entries(power_user.prompts)) {
        if (promptData.identifier === promptIdentifier || promptData.name === promptIdentifier) {
            return {
                id: promptId,
                data: promptData,
                content: promptData.content || ''
            };
        }
    }

    return null;
}

async function updatePromptContent(promptInfo, newContent) {
    const context = getContext();
    const power_user = context.power_user || window.power_user;

    if (!power_user || !power_user.prompts) {
        throw new Error('Cannot update prompt: prompt manager not accessible');
    }

    // Update the prompt content
    power_user.prompts[promptInfo.id].content = newContent;

    // Save settings
    saveSettingsDebounced();

    // Emit event to notify of change
    await eventSource.emit(event_types.CHAT_CHANGED, -1);

    console.log(`[${MODULE_NAME}] Updated prompt: ${promptInfo.data.identifier}`);
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
        message.extra?.invisible ||
        message.mes?.includes('Generating') ||
        message.mes?.includes('Regenerating');
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
    }

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
        parsedMessages.push({ role, content });
    }

    if (!hasStructuredMessages) {
        parsedMessages.push({
            role: 'system',
            content: 'Generate an updated prompt based on the conversation.'
        });
        parsedMessages.push({
            role: 'user',
            content: processedTemplate || formatMessages(messages)
        });
    }

    return parsedMessages;
}

async function generateNewPromptContent() {
    const context = getContext();
    const chat = context.chat;

    if (!Array.isArray(chat) || chat.length === 0) {
        throw new Error('No chat messages available.');
    }

    const messageCount = settings.message_count ?? 5;
    const visibleMessages = getVisibleMessages(chat, messageCount);

    if (visibleMessages.length === 0) {
        throw new Error('No visible messages found.');
    }

    let newPromptContent;

    if (settings.use_raw) {
        const instructionTemplate = settings.llm_prompt_template ||
            'Generate an updated version based on: {all_messages}';
        const parsedMessages = parsePromptTemplate(instructionTemplate, visibleMessages);

        let systemPrompt = '';
        let prompt;

        if (parsedMessages.length > 0) {
            const firstSystemMessage = parsedMessages.find(msg => msg.role === 'system');
            if (firstSystemMessage) {
                systemPrompt = firstSystemMessage.content;
                const chatMessages = parsedMessages.filter(msg =>
                    msg !== firstSystemMessage || msg.role !== 'system'
                );
                prompt = chatMessages;
            } else {
                prompt = parsedMessages;
            }
        }

        try {
            if (settings.use_custom_generate_raw === true) {
                newPromptContent = await generateRawWithStops({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: '',
                    stopStrings: ['<|im_end|>', '</s>', '[/INST]', '<|endoftext|>', '<END>']
                });
            } else {
                newPromptContent = await generateRaw({
                    systemPrompt: systemPrompt,
                    prompt: prompt,
                    prefill: ''
                });
            }
        } catch (error) {
            console.error(`[${MODULE_NAME}] Generation failed:`, error);
            throw error;
        }
    } else {
        let llmPrompt = settings.llm_prompt_template ||
            'Generate an updated version based on: {all_messages}';
        llmPrompt = replaceMessageTags(llmPrompt, visibleMessages);
        newPromptContent = await generateQuietPrompt(llmPrompt);
    }

    newPromptContent = newPromptContent.trim();
    return newPromptContent;
}

async function regeneratePrompt() {
    const promptIdentifier = settings.prompt_identifier;

    if (!promptIdentifier || !promptIdentifier.trim()) {
        toastr.error('No prompt identifier specified');
        return;
    }

    await addToQueue(promptIdentifier, false);
    toastr.info('Prompt regeneration added to queue');
}

async function addToQueue(promptIdentifier, customPrompt = false) {
    const queueItem = new RegenerationQueueItem(promptIdentifier, customPrompt);
    regenerationQueue.push(queueItem);
    updateQueueDisplay();
    processQueue();
    return queueItem.id;
}

function removeFromQueue(itemId) {
    const index = regenerationQueue.findIndex(item => item.id === itemId);
    if (index !== -1) {
        regenerationQueue.splice(index, 1);
        updateQueueDisplay();
    }
}

function updateQueueStatus(itemId, status, error = null, result = null) {
    const item = regenerationQueue.find(item => item.id === itemId);
    if (item) {
        item.status = status;
        item.error = error;
        item.result = result;
        updateQueueDisplay();
    }
}

function updateQueueDisplay() {
    const $queueWidget = $('#prompt_regen_queue_widget');
    const $queueCount = $('.prompt-regen-queue-count');
    const $queueList = $('#prompt_regen_queue_list');

    $queueCount.text(regenerationQueue.length);

    if (regenerationQueue.length === 0) {
        $queueWidget.hide();
        return;
    }

    $queueWidget.show();
    $queueList.empty();

    regenerationQueue.forEach((item) => {
        const statusIcon = {
            'pending': 'fa-clock text-warning',
            'processing': 'fa-hourglass-half text-info',
            'completed': 'fa-check text-success',
            'error': 'fa-times text-danger'
        }[item.status];

        const queueItemHtml = `
            <div class="prompt-regen-queue-item" data-item-id="${item.id}">
                <div class="prompt-regen-queue-item-header">
                    <div class="prompt-regen-queue-icons">
                        <i class="fa-solid ${statusIcon}"></i>
                        <i class="fa-solid fa-pen-fancy"></i>
                    </div>
                    ${item.status === 'pending' ?
                `<button class="prompt-regen-queue-remove" data-item-id="${item.id}" title="Remove">
                    <i class="fa-solid fa-times"></i>
                </button>` : ''}
                </div>
                <div class="prompt-regen-queue-message" title="${item.promptIdentifier}">
                    ${item.promptIdentifier}
                </div>
                ${item.error ? `<div class="prompt-regen-queue-error">${item.error}</div>` : ''}
            </div>
        `;

        $queueList.append(queueItemHtml);
    });
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (regenerationQueue.length > 0) {
        const item = regenerationQueue.find(item => item.status === 'pending');
        if (!item) break;

        updateQueueStatus(item.id, 'processing');

        try {
            await processQueueItem(item);
            updateQueueStatus(item.id, 'completed', null, item.result);
            playNotificationSound();

            setTimeout(() => {
                removeFromQueue(item.id);
            }, 2000);

        } catch (error) {
            console.error(`[${MODULE_NAME}] Queue item ${item.id} failed:`, error);
            updateQueueStatus(item.id, 'error', error.message);

            setTimeout(() => {
                removeFromQueue(item.id);
            }, 5000);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
    }

    isProcessingQueue = false;
}

async function processQueueItem(item) {
    // Find the prompt
    const promptInfo = await findPromptByIdentifier(item.promptIdentifier);

    if (!promptInfo) {
        throw new Error(`Prompt not found: ${item.promptIdentifier}`);
    }

    // Generate new content
    const newContent = await generateNewPromptContent();

    if (settings.show_preview) {
        // Show preview modal
        await showPreviewModal(promptInfo, newContent);
    } else {
        // Update directly
        await updatePromptContent(promptInfo, newContent);
        toastr.success(`Prompt "${promptInfo.data.identifier}" updated`);
    }

    item.result = newContent;
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

class PreviewModal {
    constructor() {
        this.isVisible = false;
        this.overlay = null;
        this.promptInfo = null;
        this.newContent = '';
    }

    show(promptInfo, newContent) {
        if (this.isVisible) {
            this.hide();
        }

        this.promptInfo = promptInfo;
        this.newContent = newContent;
        this.isVisible = true;

        this.overlay = document.createElement('div');
        this.overlay.className = 'prompt-regen-modal-overlay';

        this.overlay.innerHTML = `
            <div class="prompt-regen-modal">
                <div class="prompt-regen-modal-header">
                    <h3 class="prompt-regen-modal-title">
                        <i class="fa-solid fa-pen-fancy"></i> 
                        Preview: ${promptInfo.data.identifier}
                    </h3>
                    <button class="prompt-regen-modal-close" type="button">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                
                <div class="prompt-regen-modal-body">
                    <div class="prompt-regen-comparison">
                        <div class="prompt-regen-section">
                            <h4>Current Content</h4>
                            <textarea class="prompt-regen-textarea-old" readonly>${promptInfo.content}</textarea>
                        </div>
                        <div class="prompt-regen-section">
                            <h4>New Content</h4>
                            <textarea class="prompt-regen-textarea-new">${newContent}</textarea>
                        </div>
                    </div>

                    <div class="prompt-regen-modal-actions">
                        <button class="prompt-regen-btn prompt-regen-btn-success apply-btn">
                            <i class="fa-solid fa-check"></i>
                            Apply Changes
                        </button>
                        
                        <button class="prompt-regen-btn prompt-regen-btn-secondary cancel-btn">
                            <i class="fa-solid fa-times"></i>
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(this.overlay);
        this.bindEvents();
    }

    hide() {
        if (this.overlay) {
            document.body.removeChild(this.overlay);
            this.overlay = null;
        }
        this.isVisible = false;
    }

    bindEvents() {
        const newTextarea = this.overlay.querySelector('.prompt-regen-textarea-new');
        const applyBtn = this.overlay.querySelector('.apply-btn');
        const cancelBtn = this.overlay.querySelector('.cancel-btn');
        const closeBtn = this.overlay.querySelector('.prompt-regen-modal-close');

        const closeModal = () => this.hide();

        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);

        applyBtn.addEventListener('click', async () => {
            const finalContent = newTextarea.value.trim();
            if (!finalContent) {
                toastr.error('Content cannot be empty');
                return;
            }

            applyBtn.disabled = true;
            applyBtn.innerHTML = '<span class="prompt-regen-loading-spinner"></span> Applying...';

            try {
                await updatePromptContent(this.promptInfo, finalContent);
                toastr.success(`Prompt "${this.promptInfo.data.identifier}" updated`);
                this.hide();
            } catch (error) {
                toastr.error(`Failed to update: ${error.message}`);
                applyBtn.disabled = false;
                applyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Apply Changes';
            }
        });
    }
}

async function showPreviewModal(promptInfo, newContent) {
    if (!previewModal) {
        previewModal = new PreviewModal();
    }
    previewModal.show(promptInfo, newContent);
}

function makeQueueWidgetDraggable() {
    const $widget = $('#prompt_regen_queue_widget');
    const $header = $('#prompt_regen_queue_header');

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    $header.css('cursor', 'move');

    $header.on('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        const rect = $widget[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        $widget.addClass('dragging');
        e.preventDefault();
    });

    $(document).on('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const newLeft = Math.max(0, Math.min(window.innerWidth - $widget.outerWidth(), initialLeft + deltaX));
        const newTop = Math.max(0, Math.min(window.innerHeight - $widget.outerHeight(), initialTop + deltaY));

        $widget.css({
            left: newLeft + 'px',
            top: newTop + 'px'
        });
    });

    $(document).on('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            $widget.removeClass('dragging');
        }
    });
}

// Auto-trigger on message
eventSource.on(event_types.MESSAGE_SENT, () => {
    if (!settings.auto_trigger) return;

    const triggerInterval = settings.trigger_interval || 0;

    if (triggerInterval === 0) {
        // Regenerate after every message
        regeneratePrompt();
    } else {
        messageCounter++;
        if (messageCounter >= triggerInterval) {
            messageCounter = 0;
            regeneratePrompt();
        }
    }
});

jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $("#prompt_regen_settings input, #prompt_regen_settings textarea").on("input", onInput);

        const buttonHtml = await $.get(`${extensionFolderPath}/button.html`);
        $("#send_but").before(buttonHtml);

        const queueHtml = `
            <div id="prompt_regen_queue_widget" style="display: none;">
                <div class="prompt-regen-queue-header" id="prompt_regen_queue_header">
                    <div class="prompt-regen-queue-title">
                        <i class="fa-solid fa-list"></i>
                        <span class="prompt-regen-queue-count">0</span>
                    </div>
                    <button id="prompt_regen_clear_queue" class="prompt-regen-queue-btn" title="Clear Queue">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
                <div id="prompt_regen_queue_list" class="prompt-regen-queue-body"></div>
            </div>
        `;
        $("body").append(queueHtml);

        $("#prompt_regen_button").on("click", async () => {
            await regeneratePrompt();
        });

        $(document).on('click', '.prompt-regen-queue-remove', (e) => {
            const itemId = parseFloat($(e.target).closest('.prompt-regen-queue-remove').data('item-id'));
            removeFromQueue(itemId);
            toastr.info('Item removed from queue');
        });

        $('#prompt_regen_clear_queue').on('click', () => {
            regenerationQueue.length = 0;
            updateQueueDisplay();
            toastr.info('Queue cleared');
        });

        makeQueueWidgetDraggable();

        await loadSettings();

        console.log(`[${MODULE_NAME}] Extension initialized successfully`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to initialize extension:`, error);
    }
});