const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const redis = require('redis');

// Configuration
const BOT_TOKEN = '1183415743:FyWO37jmdjVC9rHBRqqkbDOZpTCvYHd6O81UhRa1';
const REDIS_URL = 'redis://default:IWbworXhfHfTLrSKJUfpLGhAWOeCPVpg@tramway.proxy.rlwy.net:56978';
const BASE_URL = `https://tapi.bale.ai/bot${BOT_TOKEN}`;
const ADMIN_USERNAMES = [
    'admin1',
    'admin2',
    'admin3'
    // Add more admin usernames here
];

let redisClient;
let bot_info;
let offset = 0;

// Initialize Redis connection
async function connectRedis() {
    try {
        redisClient = redis.createClient({
            url: REDIS_URL,
            retry_strategy: (options) => {
                if (options.error && options.error.code === 'ECONNREFUSED') {
                    console.error('Redis server connection refused');
                }
                if (options.total_retry_time > 1000 * 60 * 60) {
                    console.error('Redis retry time exhausted');
                    return new Error('Retry time exhausted');
                }
                if (options.attempt > 10) {
                    return undefined;
                }
                return Math.min(options.attempt * 100, 3000);
            }
        });

        redisClient.on('error', (err) => {
            console.error('Redis Client Error:', err);
        });

        redisClient.on('connect', () => {
            console.log('Connected to Redis');
        });

        redisClient.on('ready', () => {
            console.log('Redis client ready');
        });

        await redisClient.connect();
        
        // Test connection
        await redisClient.ping();
        console.log('✅ Redis connection successful');
        
    } catch (error) {
        console.error('Redis connection error:', error);
        process.exit(1);
    }
}

// Telegram API helper functions
async function sendTypingAction(chatId) {
    try {
        await axios.post(`${BASE_URL}/sendChatAction`, {
            chat_id: chatId,
            action: 'typing'
        });
    } catch (error) {
        console.error('Error sending typing action:', error.message);
    }
}

async function sendMessage(chatId, text, options = {}) {
    await sendTypingAction(chatId);
    
    try {
        const response = await axios.post(`${BASE_URL}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...options
        });
        return response.data;
    } catch (error) {
        console.error('Error sending message:', error.message);
        return null;
    }
}

async function sendPhoto(chatId, photo, caption = '', options = {}) {
    await sendTypingAction(chatId);
    
    try {
        const response = await axios.post(`${BASE_URL}/sendPhoto`, {
            chat_id: chatId,
            photo: photo,
            caption: caption,
            parse_mode: 'HTML',
            ...options
        });
        return response.data;
    } catch (error) {
        console.error('Error sending photo:', error.message);
        return null;
    }
}

async function sendDocument(chatId, document, caption = '', options = {}) {
    await sendTypingAction(chatId);
    
    try {
        const response = await axios.post(`${BASE_URL}/sendDocument`, {
            chat_id: chatId,
            document: document,
            caption: caption,
            parse_mode: 'HTML',
            ...options
        });
        return response.data;
    } catch (error) {
        console.error('Error sending document:', error.message);
        return null;
    }
}

async function getFile(fileId) {
    try {
        const response = await axios.get(`${BASE_URL}/getFile?file_id=${fileId}`);
        return response.data.result;
    } catch (error) {
        console.error('Error getting file:', error.message);
        return null;
    }
}

async function downloadFile(filePath) {
    try {
        const response = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, {
            responseType: 'arraybuffer'
        });
        return response.data;
    } catch (error) {
        console.error('Error downloading file:', error.message);
        return null;
    }
}

// Utility functions
function generateFileId() {
    return crypto.randomBytes(16).toString('hex');
}

function isAdmin(username) {
    return ADMIN_USERNAMES.includes(username);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(date) {
    return new Date(date).toLocaleString();
}

// Redis operations
async function saveUser(user) {
    try {
        const userData = {
            userId: user.id,
            username: user.username || '',
            firstName: user.first_name || '',
            lastName: user.last_name || '',
            lastSeen: new Date().toISOString(),
            isAdmin: isAdmin(user.username)
        };
        
        await redisClient.hSet(`user:${user.id}`, userData);
        await redisClient.sAdd('users:all', user.id.toString());
        
        // Update user count
        await redisClient.sCard('users:all');
        
    } catch (error) {
        console.error('Error saving user:', error);
    }
}

async function saveFile(fileData) {
    try {
        const fileKey = `file:${fileData.fileId}`;
        
        // Convert dates to ISO strings for Redis storage
        const redisData = {
            ...fileData,
            uploadDate: fileData.uploadDate.toISOString()
        };
        
        await redisClient.hSet(fileKey, redisData);
        await redisClient.sAdd('files:all', fileData.fileId);
        
        // Add to recent files (sorted set with timestamp)
        const timestamp = Date.now();
        await redisClient.zAdd('files:recent', {
            score: timestamp,
            value: fileData.fileId
        });
        
        // Set expiration for file (optional - 30 days)
        await redisClient.expire(fileKey, 30 * 24 * 60 * 60);
        
        return fileData.fileId;
    } catch (error) {
        console.error('Error saving file:', error);
        return null;
    }
}

async function getFileById(fileId) {
    try {
        const fileData = await redisClient.hGetAll(`file:${fileId}`);
        
        if (Object.keys(fileData).length === 0) {
            return null;
        }
        
        // Convert back to proper types
        return {
            ...fileData,
            downloads: parseInt(fileData.downloads) || 0,
            fileSize: parseInt(fileData.fileSize) || 0,
            uploadDate: new Date(fileData.uploadDate)
        };
    } catch (error) {
        console.error('Error getting file:', error);
        return null;
    }
}

async function getAllFiles() {
    try {
        // Get files sorted by recent (newest first)
        const fileIds = await redisClient.zRevRange('files:recent', 0, -1);
        const files = [];
        
        for (const fileId of fileIds) {
            const file = await getFileById(fileId);
            if (file) {
                files.push(file);
            }
        }
        
        return files;
    } catch (error) {
        console.error('Error getting all files:', error);
        return [];
    }
}

async function deleteFile(fileId) {
    try {
        await redisClient.del(`file:${fileId}`);
        await redisClient.sRem('files:all', fileId);
        await redisClient.zRem('files:recent', fileId);
        return true;
    } catch (error) {
        console.error('Error deleting file:', error);
        return false;
    }
}

async function incrementDownloads(fileId) {
    try {
        await redisClient.hIncrBy(`file:${fileId}`, 'downloads', 1);
        
        // Update daily stats
        const today = new Date().toISOString().split('T')[0];
        await redisClient.incr(`stats:downloads:${today}`);
        await redisClient.incr('stats:downloads:total');
        
    } catch (error) {
        console.error('Error incrementing downloads:', error);
    }
}

async function getStats() {
    try {
        const totalFiles = await redisClient.sCard('files:all');
        const totalUsers = await redisClient.sCard('users:all');
        
        // Recent files (last 24 hours)
        const yesterday = Date.now() - (24 * 60 * 60 * 1000);
        const recentFiles = await redisClient.zCount('files:recent', yesterday, '+inf');
        
        // Total downloads
        const totalDownloads = await redisClient.get('stats:downloads:total') || 0;
        
        // Today's downloads
        const today = new Date().toISOString().split('T')[0];
        const todayDownloads = await redisClient.get(`stats:downloads:${today}`) || 0;
        
        return { 
            totalFiles, 
            totalUsers, 
            recentFiles, 
            totalDownloads: parseInt(totalDownloads),
            todayDownloads: parseInt(todayDownloads)
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        return { totalFiles: 0, totalUsers: 0, recentFiles: 0, totalDownloads: 0, todayDownloads: 0 };
    }
}

async function getAllUsers() {
    try {
        const userIds = await redisClient.sMembers('users:all');
        const users = [];
        
        for (const userId of userIds) {
            const userData = await redisClient.hGetAll(`user:${userId}`);
            if (Object.keys(userData).length > 0) {
                users.push({
                    ...userData,
                    userId: parseInt(userData.userId),
                    lastSeen: new Date(userData.lastSeen),
                    isAdmin: userData.isAdmin === 'true'
                });
            }
        }
        
        // Sort by last seen (most recent first)
        return users.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    } catch (error) {
        console.error('Error getting users:', error);
        return [];
    }
}

// Message handlers
async function handleStart(chatId, userId, username, messageId) {
    const args = messageId ? messageId.split(' ') : [];
    
    if (args.length > 1) {
        const fileId = args[1];
        const file = await getFileById(fileId);
        
        if (!file) {
            await sendMessage(chatId, '❌ File not found or expired.');
            return;
        }
        
        // Update download count
        await incrementDownloads(fileId);
        
        // Send the file based on type
        if (file.type === 'text') {
            await sendMessage(chatId, `📄 <b>${file.fileName}</b>\n\n${file.content}`);
        } else if (file.type === 'photo') {
            await sendPhoto(chatId, file.telegramFileId, file.caption || '');
        } else if (file.type === 'document') {
            await sendDocument(chatId, file.telegramFileId, file.caption || '');
        }
        
        const updatedFile = await getFileById(fileId);
        await sendMessage(chatId, `✅ File: <b>${file.fileName}</b>\n📊 Downloads: ${updatedFile.downloads}\n📅 Uploaded: ${formatDate(file.uploadDate)}`);
        return;
    }
    
    const welcomeMessage = isAdmin(username) ? 
        `🔧 <b>Admin Panel - Telegram Uploader Bot</b>\n\n` +
        `Welcome back, Admin! Here are your commands:\n\n` +
        `📁 <b>File Management:</b>\n` +
        `/upload - Upload files, photos, or text\n` +
        `/list - View all uploaded files\n` +
        `/delete - Delete files\n` +
        `/stats - View bot statistics\n\n` +
        `📢 <b>Broadcasting:</b>\n` +
        `/broadcast - Send message to all users\n` +
        `/users - View all users\n\n` +
        `ℹ️ <b>Other Commands:</b>\n` +
        `/help - Show this help message\n` +
        `/about - About this bot`
        :
        `👋 <b>Welcome to Telegram Uploader Bot!</b>\n\n` +
        `This bot allows you to access shared files through special links.\n\n` +
        `🔗 To access a file, use a link like:\n` +
        `<code>https://t.me/${bot_info.username}?start=FILE_ID</code>\n\n` +
        `📞 Contact an admin if you need help!`;
    
    await sendMessage(chatId, welcomeMessage);
}

async function handleUpload(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to upload files.');
        return;
    }
    
    await sendMessage(chatId, 
        `📁 <b>Upload Options</b>\n\n` +
        `Choose what you want to upload:\n\n` +
        `📄 Send any document/file\n` +
        `🖼️ Send any photo with optional caption\n` +
        `📝 Use /text followed by your message to upload text\n\n` +
        `💡 <b>Example:</b>\n` +
        `<code>/text Hello, this is a sample text message!</code>`
    );
}

async function handleTextUpload(chatId, username, text) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to upload content.');
        return;
    }
    
    const content = text.replace('/text ', '');
    if (content.length < 1) {
        await sendMessage(chatId, '❌ Please provide text content to upload.');
        return;
    }
    
    const fileId = generateFileId();
    const fileData = {
        fileId: fileId,
        type: 'text',
        fileName: `Text_${fileId.substring(0, 8)}.txt`,
        content: content,
        uploadDate: new Date(),
        uploadedBy: username,
        downloads: 0,
        fileSize: content.length
    };
    
    await saveFile(fileData);
    
    const shareLink = `https://t.me/${bot_info.username}?start=${fileId}`;
    await sendMessage(chatId, 
        `✅ <b>Text uploaded successfully!</b>\n\n` +
        `📄 <b>File:</b> ${fileData.fileName}\n` +
        `📊 <b>Size:</b> ${formatFileSize(fileData.fileSize)}\n` +
        `🔗 <b>Share Link:</b>\n<code>${shareLink}</code>\n\n` +
        `👆 Click to copy the link!`
    );
}

async function handleFileUpload(chatId, username, message) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to upload files.');
        return;
    }
    
    let telegramFileId, fileName, fileSize, fileType;
    
    if (message.document) {
        telegramFileId = message.document.file_id;
        fileName = message.document.file_name || 'Unknown_Document';
        fileSize = message.document.file_size;
        fileType = 'document';
    } else if (message.photo) {
        const photo = message.photo[message.photo.length - 1]; // Get highest resolution
        telegramFileId = photo.file_id;
        fileName = `Photo_${Date.now()}.jpg`;
        fileSize = photo.file_size;
        fileType = 'photo';
    } else {
        await sendMessage(chatId, '❌ Unsupported file type. Please send a document or photo.');
        return;
    }
    
    const fileId = generateFileId();
    const fileData = {
        fileId: fileId,
        type: fileType,
        fileName: fileName,
        telegramFileId: telegramFileId,
        caption: message.caption || '',
        uploadDate: new Date(),
        uploadedBy: username,
        downloads: 0,
        fileSize: fileSize || 0
    };
    
    await saveFile(fileData);
    
    const shareLink = `https://t.me/${bot_info.username}?start=${fileId}`;
    await sendMessage(chatId, 
        `✅ <b>File uploaded successfully!</b>\n\n` +
        `📄 <b>File:</b> ${fileName}\n` +
        `📊 <b>Size:</b> ${formatFileSize(fileSize || 0)}\n` +
        `📁 <b>Type:</b> ${fileType}\n` +
        `🔗 <b>Share Link:</b>\n<code>${shareLink}</code>\n\n` +
        `👆 Click to copy the link!`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: '📋 Copy Link', url: shareLink }
                ]]
            }
        }
    );
}

async function handleList(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to view files.');
        return;
    }
    
    const files = await getAllFiles();
    
    if (files.length === 0) {
        await sendMessage(chatId, '📁 No files uploaded yet.');
        return;
    }
    
    let message = `📁 <b>Uploaded Files (${files.length})</b>\n\n`;
    
    files.slice(0, 20).forEach((file, index) => {
        const shareLink = `https://t.me/${bot_info.username}?start=${file.fileId}`;
        message += `${index + 1}. <b>${file.fileName}</b>\n`;
        message += `   📊 ${formatFileSize(file.fileSize || 0)} | 📥 ${file.downloads} downloads\n`;
        message += `   🔗 <code>${shareLink}</code>\n`;
        message += `   📅 ${formatDate(file.uploadDate)}\n\n`;
    });
    
    if (files.length > 20) {
        message += `... and ${files.length - 20} more files.\n`;
    }
    
    await sendMessage(chatId, message);
}

async function handleStats(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to view statistics.');
        return;
    }
    
    const stats = await getStats();
    
    const message = 
        `📊 <b>Bot Statistics</b>\n\n` +
        `📁 Total Files: ${stats.totalFiles}\n` +
        `👥 Total Users: ${stats.totalUsers}\n` +
        `📈 Files Uploaded Today: ${stats.recentFiles}\n` +
        `📥 Total Downloads: ${stats.totalDownloads}\n` +
        `📊 Today's Downloads: ${stats.todayDownloads}\n` +
        `🤖 Bot Uptime: ${Math.floor(process.uptime())} seconds\n` +
        `📅 Generated: ${formatDate(new Date())}`;
    
    await sendMessage(chatId, message);
}

async function handleBroadcast(chatId, username, text) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to broadcast messages.');
        return;
    }
    
    const message = text.replace('/broadcast ', '');
    if (message.length < 1) {
        await sendMessage(chatId, '❌ Please provide a message to broadcast.\n\nExample: <code>/broadcast Hello everyone!</code>');
        return;
    }
    
    const users = await getAllUsers();
    let successCount = 0;
    let failCount = 0;
    
    await sendMessage(chatId, `📢 Broadcasting to ${users.length} users...`);
    
    for (const user of users) {
        try {
            await sendMessage(user.userId, `📢 <b>Broadcast Message</b>\n\n${message}`);
            successCount++;
        } catch (error) {
            failCount++;
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    await sendMessage(chatId, `✅ Broadcast completed!\n\n📤 Sent: ${successCount}\n❌ Failed: ${failCount}`);
}

async function handleUsers(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to view users.');
        return;
    }
    
    const users = await getAllUsers();
    
    if (users.length === 0) {
        await sendMessage(chatId, '👥 No users found.');
        return;
    }
    
    let message = `👥 <b>Bot Users (${users.length})</b>\n\n`;
    
    users.slice(0, 20).forEach((user, index) => {
        const name = user.firstName + (user.lastName ? ` ${user.lastName}` : '');
        const username_display = user.username ? `@${user.username}` : 'No username';
        const admin_badge = user.isAdmin ? '👑' : '';
        
        message += `${index + 1}. ${admin_badge} <b>${name}</b>\n`;
        message += `   ${username_display} | ID: ${user.userId}\n`;
        message += `   📅 Last seen: ${formatDate(user.lastSeen)}\n\n`;
    });
    
    if (users.length > 20) {
        message += `... and ${users.length - 20} more users.\n`;
    }
    
    await sendMessage(chatId, message);
}

async function handleDelete(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to delete files.');
        return;
    }
    
    await sendMessage(chatId, 
        `🗑️ <b>Delete Files</b>\n\n` +
        `To delete a file, use:\n` +
        `<code>/delete FILE_ID</code>\n\n` +
        `You can find file IDs in the /list command.`
    );
}

async function handleDeleteFile(chatId, username, fileId) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to delete files.');
        return;
    }
    
    const file = await getFileById(fileId);
    if (!file) {
        await sendMessage(chatId, '❌ File not found.');
        return;
    }
    
    await deleteFile(fileId);
    await sendMessage(chatId, `✅ File "${file.fileName}" has been deleted successfully.`);
}

async function handleHelp(chatId, username) {
    const helpMessage = isAdmin(username) ? 
        `🔧 <b>Admin Commands</b>\n\n` +
        `📁 <b>File Management:</b>\n` +
        `/upload - Upload files, photos, or text\n` +
        `/list - View all uploaded files\n` +
        `/delete FILE_ID - Delete a specific file\n` +
        `/stats - View bot statistics\n\n` +
        `📢 <b>Broadcasting:</b>\n` +
        `/broadcast <message> - Send message to all users\n` +
        `/users - View all users\n\n` +
        `📝 <b>Text Upload:</b>\n` +
        `/text <content> - Upload text content\n\n` +
        `ℹ️ <b>Other Commands:</b>\n` +
        `/help - Show this help message\n` +
        `/about - About this bot`
        :
        `ℹ️ <b>Available Commands</b>\n\n` +
        `/start - Start the bot\n` +
        `/help - Show this help\n` +
        `/about - About this bot\n\n` +
        `To access shared files, use links provided by administrators.`;
    
    await sendMessage(chatId, helpMessage);
}

async function handleAbout(chatId) {
    const aboutMessage = 
        `🤖 <b>Telegram Uploader Bot</b>\n\n` +
        `This bot allows authorized users to upload and share files securely.\n\n` +
        `✨ <b>Features:</b>\n` +
        `• File upload and sharing\n` +
        `• Photo sharing with captions\n` +
        `• Text content sharing\n` +
        `• Download statistics\n` +
        `• User management\n` +
        `• Broadcasting system\n\n` +
        `🔧 Built with Node.js and Redis\n` +
        `💡 Powered by Telegram Bot API`;
    
    await sendMessage(chatId, aboutMessage);
}

// Cache management commands (bonus feature for Redis)
async function handleClearCache(chatId, username) {
    if (!isAdmin(username)) {
        await sendMessage(chatId, '❌ You are not authorized to clear cache.');
        return;
    }
    
    try {
        // Clear expired file entries
        const fileIds = await redisClient.sMembers('files:all');
        let expiredCount = 0;
        
        for (const fileId of fileIds) {
            const exists = await redisClient.exists(`file:${fileId}`);
            if (!exists) {
                await redisClient.sRem('files:all', fileId);
                await redisClient.zRem('files:recent', fileId);
                expiredCount++;
            }
        }
        
        await sendMessage(chatId, `🧹 Cache cleaned! Removed ${expiredCount} expired entries.`);
        
    } catch (error) {
        console.error('Error clearing cache:', error);
        await sendMessage(chatId, '❌ Error clearing cache.');
    }
}

// Main message processor
async function processMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from.id;
    const username = message.from.username;
    const text = message.text;
    
    // Save user to Redis
    await saveUser(message.from);
    
    // Handle commands
    if (text) {
        if (text.startsWith('/start')) {
            await handleStart(chatId, userId, username, text);
        } else if (text === '/upload') {
            await handleUpload(chatId, username);
        } else if (text.startsWith('/text ')) {
            await handleTextUpload(chatId, username, text);
        } else if (text === '/list') {
            await handleList(chatId, username);
        } else if (text === '/stats') {
            await handleStats(chatId, username);
        } else if (text.startsWith('/broadcast ')) {
            await handleBroadcast(chatId, username, text);
        } else if (text === '/users') {
            await handleUsers(chatId, username);
        } else if (text === '/delete') {
            await handleDelete(chatId, username);
        } else if (text.startsWith('/delete ')) {
            const fileId = text.replace('/delete ', '');
            await handleDeleteFile(chatId, username, fileId);
        } else if (text === '/clearcache') {
            await handleClearCache(chatId, username);
        } else if (text === '/help') {
            await handleHelp(chatId, username);
        } else if (text === '/about') {
            await handleAbout(chatId);
        } else {
            // Unknown command
            await sendMessage(chatId, '❓ Unknown command. Use /help to see available commands.');
        }
    } else if (message.document || message.photo) {
        // Handle file uploads
        await handleFileUpload(chatId, username, message);
    }
}

// Long polling function
async function getUpdates() {
    try {
        const response = await axios.get(`${BASE_URL}/getUpdates`, {
            params: {
                offset: offset,
                timeout: 10,
                limit: 100
            }
        });
        
        const updates = response.data.result;
        
        for (const update of updates) {
            offset = update.update_id + 1;
            
            if (update.message) {
                await processMessage(update.message);
            }
        }
    } catch (error) {
        console.error('Error getting updates:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
    }
}

// Get bot info
async function getBotInfo() {
    try {
        const response = await axios.get(`${BASE_URL}/getMe`);
        bot_info = response.data.result;
        console.log('Bot info:', bot_info);
    } catch (error) {
        console.error('Error getting bot info:', error.message);
        process.exit(1);
    }
}

// Periodic cleanup function
async function periodicCleanup() {
    try {
        // Clean up old download stats (keep last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        for (let i = 31; i <= 60; i++) {
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - i);
            const dateKey = oldDate.toISOString().split('T')[0];
            await redisClient.del(`stats:downloads:${dateKey}`);
        }
        
        console.log('🧹 Periodic cleanup completed');
    } catch (error) {
        console.error('Error in periodic cleanup:', error);
    }
}

// Main function
async function main() {
    console.log('🤖 Starting Telegram Uploader Bot...');
    
    // Connect to Redis
    await connectRedis();
    
    // Get bot information
    await getBotInfo();
    
    console.log(`✅ Bot @${bot_info.username}
