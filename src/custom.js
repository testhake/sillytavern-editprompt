// Core OpenAI handling
import { getCustomModel, getCustomParameters } from '../index.js';
import { sendOpenAIRequest, oai_settings, getChatCompletionModel, chat_completion_sources } from '../../../../openai.js';

// Data extraction / cleanup helpers (same ones generateRaw uses)
import { main_api, amount_gen, max_context } from '../../../../../script.js';
import { cleanUpMessage, extractMessageFromData, extractJsonFromData, getGenerateUrl, getRequestHeaders, createRawPrompt } from '../../../../../script.js';

// Kobold/Novel/Textgen wrappers
import { kai_settings, koboldai_settings, koboldai_setting_names, getKoboldGenerationData } from '../../../../kai-settings.js';
import { novelai_settings, novelai_setting_names, nai_settings, getNovelGenerationData } from '../../../../nai-settings.js';
import { generateHorde } from '../../../../horde.js';
import { getTextGenGenerationData } from '../../../../textgen-settings.js';

// Add at the beginning of custom.js, after imports
export function getCustomModel() {
    const { extension_settings } = require('../../../extensions.js');
    const settings = extension_settings['dynamic-prompt-modifier'] || {};
    return settings.custom_model || '';
}

export function getCustomParameters() {
    const { extension_settings } = require('../../../extensions.js');
    const settings = extension_settings['dynamic-prompt-modifier'] || {};
    return settings.custom_parameters || '';
}

/**
 * Custom OpenAI request function that properly handles stop strings
 * @param {object[]} messages - Array of chat messages
 * @param {string[]} stopStrings - Array of stop strings
 * @param {object} jsonSchema - Optional JSON schema
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<object>} Response data
 */
async function sendCustomOpenAIRequest(messages, stopStrings, jsonSchema, signal) {
    let model = getChatCompletionModel();
    const customModel = getCustomModel();
    if (customModel !== "") {
        model = customModel;
    }

    const generateData = {
        model: model,
        messages: messages,
        temperature: Number(oai_settings.temp_openai),
        top_p: Number(oai_settings.top_p_openai),
        frequency_penalty: Number(oai_settings.freq_pen_openai),
        presence_penalty: Number(oai_settings.pres_pen_openai),
        max_tokens: oai_settings.openai_max_tokens,
        stream: false,
        stop: stopStrings,
        chat_completion_source: oai_settings.chat_completion_source,
    };

    // Add additional settings based on the completion source
    if (oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI) {
        generateData.safe_prompt = false;
    }
    if (oai_settings.chat_completion_source == chat_completion_sources.CUSTOM) {
        generateData.custom_url = oai_settings.custom_url;
        //generateData.custom_include_body = oai_settings.custom_include_body;
        const customParams = getCustomParameters();
        generateData.custom_include_body = customParams !== "" ? customParams : oai_settings.custom_include_body;
        generateData.custom_exclude_body = oai_settings.custom_exclude_body;
        generateData.custom_include_headers = oai_settings.custom_include_headers;
    }
    if (jsonSchema) {
        generateData.json_schema = jsonSchema;
    }

    // Add proxy settings if configured
    if (oai_settings.reverse_proxy && [chat_completion_sources.CLAUDE, chat_completion_sources.OPENAI, chat_completion_sources.MISTRALAI, chat_completion_sources.MAKERSUITE, chat_completion_sources.VERTEXAI, chat_completion_sources.DEEPSEEK, chat_completion_sources.XAI].includes(oai_settings.chat_completion_source)) {
        generateData.reverse_proxy = oai_settings.reverse_proxy;
        generateData.proxy_password = oai_settings.proxy_password;
    }

    console.log('[swarmUI-integration-custom] Custom OpenAI request data:', generateData);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        body: JSON.stringify(generateData),
        headers: getRequestHeaders(),
        signal: signal,
    });

    if (!response.ok) {
        throw new Error(`Got response status ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
        const message = data.error.message || response.statusText || 'Unknown error';
        throw new Error(message);
    }

    return data;
}

/**
 * Generates a message using the provided prompt with support for stopping strings.
 * This is a modified version of generateRaw that includes stopping string functionality.
 * @typedef {object} GenerateRawWithStopsParams
 * @prop {string | object[]} [prompt] Prompt to generate a message from. Can be a string or an array of chat-style messages, i.e. [{role: '', content: ''}, ...]
 * @prop {string} [api] API to use. Main API is used if not specified.
 * @prop {boolean} [instructOverride] true to override instruct mode, false to use the default value
 * @prop {boolean} [quietToLoud] true to generate a message in system mode, false to generate a message in character mode
 * @prop {string} [systemPrompt] System prompt to use.
 * @prop {number} [responseLength] Maximum response length. If unset, the global default value is used.
 * @prop {boolean} [trimNames] Whether to allow trimming "{{user}}:" and "{{char}}:" from the response.
 * @prop {string} [prefill] An optional prefill for the prompt.
 * @prop {object} [jsonSchema] JSON schema to use for the structured generation. Usually requires a special instruction.
 * @prop {string[]} [stopStrings] Array of strings that should stop generation when encountered.
 * @param {GenerateRawWithStopsParams} params Parameters for generating a message
 * @returns {Promise<string>} Generated message
 */
export async function generateRawWithStops({
    prompt = '',
    api = null,
    instructOverride = false,
    quietToLoud = false,
    systemPrompt = '',
    responseLength = null,
    trimNames = true,
    prefill = '',
    jsonSchema = null,
    stopStrings = []
} = {}) {
    if (arguments.length > 0 && typeof arguments[0] !== 'object') {
        console.trace('[swarmUI-integration-custom] generateRawWithStops called with positional arguments. Please use an object instead.');
        [prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength, trimNames, prefill, jsonSchema, stopStrings] = arguments;
    }

    if (!api) {
        api = main_api;
    }

    const abortController = new AbortController();
    const responseLengthCustomized = typeof responseLength === 'number' && responseLength > 0;

    // Simplified response length handling without TempResponseLength dependency
    let originalResponseLength = null;
    let originalOpenAIMaxTokens = null;

    // construct final prompt from the input. Can either be a string or an array of chat-style messages.
    prompt = createRawPrompt(prompt, api, instructOverride, quietToLoud, systemPrompt, prefill);

    try {
        // Handle custom response length without TempResponseLength class
        if (responseLengthCustomized) {
            if (api === 'openai') {
                originalOpenAIMaxTokens = oai_settings.openai_max_tokens;
                oai_settings.openai_max_tokens = responseLength;
            } else {
                originalResponseLength = amount_gen;
                amount_gen = responseLength;
            }
        }

        /** @type {object|any[]} */
        let generateData = {};

        switch (api) {
            case 'kobold':
            case 'koboldhorde':
                if (kai_settings.preset_settings === 'gui') {
                    generateData = {
                        prompt: prompt,
                        gui_settings: true,
                        max_length: amount_gen,
                        max_context_length: max_context,
                        api_server: kai_settings.api_server
                    };
                    // Add stop strings for Kobold
                    if (stopStrings.length > 0) {
                        generateData.stop_sequence = stopStrings;
                    }
                } else {
                    const isHorde = api === 'koboldhorde';
                    const koboldSettings = koboldai_settings[koboldai_setting_names[kai_settings.preset_settings]];
                    generateData = getKoboldGenerationData(prompt.toString(), koboldSettings, amount_gen, max_context, isHorde, 'quiet');
                    // Add stop strings for Kobold
                    if (stopStrings.length > 0) {
                        generateData.stop_sequence = stopStrings;
                    }
                }
                break;
            case 'novel': {
                const novelSettings = novelai_settings[novelai_setting_names[nai_settings.preset_settings_novel]];
                generateData = getNovelGenerationData(prompt, novelSettings, amount_gen, false, false, null, 'quiet');
                // Add stop strings for Novel AI (they use 'stop' parameter)
                if (stopStrings.length > 0) {
                    generateData.parameters = generateData.parameters || {};
                    generateData.parameters.stop = stopStrings;
                }
                break;
            }
            case 'textgenerationwebui':
                generateData = await getTextGenGenerationData(prompt, amount_gen, false, false, null, 'quiet');
                // Add stop strings for TextGenWebUI
                if (stopStrings.length > 0) {
                    generateData.stopping_strings = stopStrings;
                }
                break;
            case 'openai': {
                generateData = prompt;  // generateData is just the chat message object
                // Stop strings for OpenAI will be handled in sendOpenAIRequest
                break;
            }
        }

        let data = {};

        if (api === 'koboldhorde') {
            data = await generateHorde(prompt.toString(), generateData, abortController.signal, false);
        } else if (api === 'openai') {
            // For OpenAI/Mistral, we'll make a direct request to handle stop strings properly
            if (stopStrings.length > 0) {
                console.log('[swarmUI-integration-custom] Using custom OpenAI request with stop strings:', stopStrings);
                data = await sendCustomOpenAIRequest(generateData, stopStrings, jsonSchema, abortController.signal);
            } else {
                const requestOptions = { jsonSchema };
                data = await sendOpenAIRequest('quiet', generateData, abortController.signal, requestOptions);
            }
            console.log('[swarmUI-integration-custom] OpenAI/Mistral response:', JSON.stringify(data, null, 2));
        } else {
            const generateUrl = getGenerateUrl(api);
            const response = await fetch(generateUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                cache: 'no-cache',
                body: JSON.stringify(generateData),
                signal: abortController.signal,
            });

            if (!response.ok) {
                throw await response.json();
            }

            data = await response.json();
        }

        // Check if generation stopped due to length limit and warn
        if (api === 'openai' && data && data.choices && data.choices[0] && data.choices[0].finish_reason === 'length') {
            console.warn('[swarmUI-integration-custom] Generation stopped due to length limit. Consider using shorter responseLength or more specific stop strings.');
        }

        // should only happen for text completions
        // other frontend paths do not return data if calling the backend fails,
        // they throw things instead
        if (data.error) {
            throw new Error(data.response);
        }

        if (jsonSchema) {
            return extractJsonFromData(data, { mainApi: api });
        }

        // Handle Mistral's specific response format
        let extractedMessage;
        try {
            extractedMessage = extractMessageFromData(data);
        } catch (error) {
            console.warn('[swarmUI-integration-custom] Standard message extraction failed, trying Mistral format:', error);
            // Handle Mistral's response format specifically
            if (data && data.choices && data.choices[0] && data.choices[0].message) {
                const messageContent = data.choices[0].message.content;
                if (Array.isArray(messageContent) && messageContent.length > 0) {
                    // Mistral returns content as array of objects
                    if (typeof messageContent[0] === 'object' && messageContent[0].text) {
                        extractedMessage = messageContent[0].text;
                    } else if (typeof messageContent[0] === 'string') {
                        extractedMessage = messageContent[0];
                    } else {
                        extractedMessage = JSON.stringify(messageContent[0]);
                    }
                } else if (typeof messageContent === 'string') {
                    extractedMessage = messageContent;
                }
            }
        }

        // format result, exclude user prompt bias
        let message = cleanUpMessage({
            getMessage: extractedMessage,
            isImpersonate: false,
            isContinue: false,
            displayIncompleteSentences: true,
            includeUserPromptBias: false,
            trimNames: trimNames,
            trimWrongNames: trimNames,
        });

        if (!message) {
            console.error('[swarmUI-integration-custom] Failed to extract message. Raw data:', JSON.stringify(data, null, 2));
            throw new Error('No message generated');
        }

        // Additional client-side stop string processing as fallback
        if (stopStrings.length > 0) {
            for (const stopString of stopStrings) {
                const stopIndex = message.indexOf(stopString);
                if (stopIndex !== -1) {
                    message = message.substring(0, stopIndex);
                    break;
                }
            }
        }

        return message;
    } finally {
        // Restore original response length settings
        if (responseLengthCustomized) {
            if (api === 'openai' && originalOpenAIMaxTokens !== null) {
                oai_settings.openai_max_tokens = originalOpenAIMaxTokens;
            } else if (originalResponseLength !== null) {
                amount_gen = originalResponseLength;
            }
        }
    }
}

// Alternative function with a more specific name for image prompt generation
export async function generateImagePromptWithStops(params = {}) {
    // Default stop strings commonly used for danbooru tag generation
    const defaultStops = ['\n\n', '###', 'USER:', 'ASSISTANT:', '<|im_end|>', '<|endoftext|>'];

    return generateRawWithStops({
        ...params,
        stopStrings: params.stopStrings || defaultStops
    });
}