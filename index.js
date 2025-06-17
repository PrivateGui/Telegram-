const axios = require('axios');
const base64 = require('base64-js');
const fs = require('fs').promises;

const TELEGRAM_TOKEN = '7151280338:AAFOCooejwLWK8FHxadytsKBespil1OhXh8'; // Replace with your Telegram bot token
const TELEGRAM_API = `https://tapi.bale.ai/bot${TELEGRAM_TOKEN}`;
const API_URL = 'https://api.llm7.io/v1/chat/completions';
const API_HEADERS = {
    'Authorization': 'Bearer unused', // Replace with your API key from https://token.llm7.io/
    'Content-Type': 'application/json'
};

// Store chat history per user (user_id -> array of messages)
const chatHistory = {};
let lastUpdateId = 0;

async function getUpdates() {
    try {
        const response = await axios.get(`${TELEGRAM_API}/getUpdates`, {
            params: { offset: lastUpdateId + 1, timeout: 60 }
        });
        return response.data.result;
    } catch (error) {
        console.error(`Failed to get updates: ${error.message}`);
        return [];
    }
}

async function sendMessage(chatId, text) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text
        });
    } catch (error) {
        console.error(`Failed to send message to ${chatId}: ${error.message}`);
    }
}

async function getFile(fileId) {
    try {
        const response = await axios.get(`${TELEGRAM_API}/getFile`, {
            params: { file_id: fileId }
        });
        return response.data.result.file_path;
    } catch (error) {
        console.error(`Failed to get file path for ${fileId}: ${error.message}`);
        return null;
    }
}

async function downloadImage(filePath) {
    try {
        const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`Failed to download image from ${filePath}: ${error.message}`);
        return null;
    }
}

async function processUpdate(update) {
    const userId = update.message.from.id;
    const chatId = update.message.chat.id;

    chatHistory[userId] = chatHistory[userId] || [];

    if (update.message.text) {
        const userText = update.message.text;
        console.log(`User ${userId} sent text: ${userText}`);

        if (userText === '/start') {
            chatHistory[userId] = [];
            await sendMessage(chatId, 'Hello! I\'m a chatbot that remembers our conversation. Send a text or an image (with or without caption), and I\'ll respond with context!');
            chatHistory[userId].push({ role: 'assistant', content: 'Welcome message sent.' });
        } else if (userText === '/help') {
            const helpText = 'Send a text message, and I\'ll respond with context. Send an image with an optional caption (e.g., "is this cool"), and I\'ll caption it or respond to your caption. Use /start to reset or /help for this info.';
            await sendMessage(chatId, helpText);
            chatHistory[userId].push({ role: 'assistant', content: helpText });
        } else {
            chatHistory[userId].push({ role: 'user', content: userText });

            const data = {
                model: 'gpt-4.1-nano',
                messages: chatHistory[userId]
            };

            try {
                const response = await axios.post(API_URL, data, { headers: API_HEADERS });
                const responseContent = response.data.choices[0].message.content;
                await sendMessage(chatId, responseContent);
                chatHistory[userId].push({ role: 'assistant', content: responseContent });
            } catch (error) {
                console.error(`API request failed for user ${userId}: ${error.message}`);
                await sendMessage(chatId, 'Sorry, I couldn\'t process your request. Try again later.');
                chatHistory[userId].push({ role: 'assistant', content: 'Sorry, I couldn\'t process your request. Try again later.' });
            }
        }
    } else if (update.message.photo) {
        console.log(`User ${userId} sent image`);
        const userCaption = update.message.caption || '';
        console.log(`User ${userId} image caption: ${userCaption}`);

        const photo = update.message.photo[update.message.photo.length - 1];
        const filePath = await getFile(photo.file_id);
        if (!filePath) return;

        const imageBuffer = await downloadImage(filePath);
        if (!imageBuffer) return;

        const imageData = base64.fromByteArray(imageBuffer);
        const prompt = userCaption ? `Caption this image: ${userCaption}` : 'Caption this image';
        console.log(`Image prompt for user ${userId}: ${prompt}`);

        const imageMessage = {
            role: 'user',
            content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageData}` } }
            ]
        };

        chatHistory[userId].push(imageMessage);

        const data = {
            model: 'gpt-4.1-nano',
            messages: chatHistory[userId]
        };

        try {
            const apiResponse = await axios.post(API_URL, data, { headers: API_HEADERS });
            const captionResponse = apiResponse.data.choices[0].message.content;
            await sendMessage(chatId, captionResponse);
            chatHistory[userId].push({ role: 'assistant', content: captionResponse });
        } catch (error) {
            console.error(`Image API request failed for user ${userId}: ${error.message}`);
            const fallbackMessage = `Sorry, I couldn\'t process the image. The API may not support image inputs. Please describe the image in text, and I\'ll respond to '${userCaption}' or your description.`;
            await sendMessage(chatId, fallbackMessage);
            chatHistory[userId].push({ role: 'assistant', content: fallbackMessage });
        }
    }

    lastUpdateId = Math.max(lastUpdateId, update.update_id);
}

async function startPolling() {
    console.log('Bot is running...');
    while (true) {
        try {
            const updates = await getUpdates();
            for (const update of updates) {
                await processUpdate(update);
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Avoid rate limiting
        } catch (error) {
            console.error(`Polling error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Retry after 5 seconds on error
        }
    }
}

process.on('SIGINT', () => {
    console.log('Bot stopped by user');
    process.exit();
});

process.on('SIGTERM', () => {
    console.log('Bot stopped by system');
    process.exit();
});

startPolling();
