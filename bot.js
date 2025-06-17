const axios = require('axios');
const redis = require('redis');
const fs = require('fs');
const path = require('path');

const TOKEN = '1183415743:FyWO37jmdjVC9rHBRqqkbDOZpTCvYHd6O81UhRa1';
const REDIS_URL = 'redis://default:IWbworXhfHfTLrSKJUfpLGhAWOeCPVpg@tramway.proxy.rlwy.net:56978';
const BOT_API = `https://tapi.bale.ai/bot${TOKEN}`;
const client = redis.createClient({ url: REDIS_URL });
client.connect();

const admins = ['zonercm', 'zonercm'];

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

let offset = 0;

async function sendTyping(chatId) {
  await axios.post(`${BOT_API}/sendChatAction`, {
    chat_id: chatId,
    action: 'typing'
  });
}

async function sendMessage(chatId, text, options = {}) {
  await sendTyping(chatId);
  return axios.post(`${BOT_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...options
  });
}

async function sendPhoto(chatId, photoPath, caption = '') {
  await sendTyping(chatId);
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('photo', fs.createReadStream(photoPath));
  if (caption) formData.append('caption', caption);
  return axios.post(`${BOT_API}/sendPhoto`, formData, {
    headers: formData.getHeaders()
  });
}

async function sendDocument(chatId, filePath, caption = '') {
  await sendTyping(chatId);
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', fs.createReadStream(filePath));
  if (caption) formData.append('caption', caption);
  return axios.post(`${BOT_API}/sendDocument`, formData, {
    headers: formData.getHeaders()
  });
}

async function generateStartLink(fileId) {
  const linkId = Date.now().toString();
  await client.set(`link:${linkId}`, fileId);
  return `https://t.me/yourbot?start=${linkId}`;
}

async function handleStart(update) {
  const chatId = update.message.chat.id;
  const startPayload = update.message.text.split(' ')[1];
  
  if (startPayload) {
    const fileId = await client.get(`link:${startPayload}`);
    if (fileId) {
      const fileType = await client.get(`fileType:${fileId}`);
      const caption = await client.get(`caption:${fileId}`) || '';
      
      if (fileType === 'photo') {
        await sendPhoto(chatId, await client.get(`path:${fileId}`), caption);
      } else if (fileType === 'document') {
        await sendDocument(chatId, await client.get(`path:${fileId}`), caption);
      } else {
        await sendMessage(chatId, caption);
      }
      await sendMessage(chatId, '📥 محتوا با موفقیت ارسال شد!');
    } else {
      await sendMessage(chatId, '❌ لینک نامعتبر است!');
    }
  } else {
    await sendMessage(chatId, '👋 *خوش آمدید!* \nبرای استفاده از لینک‌های اشتراک‌گذاری، لینک را دنبال کنید.');
  }
}

async function handleAdminCommands(update) {
  const chatId = update.message.chat.id;
  const username = update.message.from.username;
  if (!admins.includes(username)) {
    await sendMessage(chatId, '❌ شما ادمین نیستید!');
    return;
  }

  const text = update.message.text;
  
  if (text.startsWith('/broadcast')) {
    const message = text.slice(10).trim();
    if (!message) {
      await sendMessage(chatId, '📢 لطفاً متن پیام را وارد کنید!');
      return;
    }
    const users = await client.lRange('users', 0, -1);
    for (const userId of users) {
      await sendMessage(userId, `📢 *پیام همگانی:*\n${message}`);
    }
    await sendMessage(chatId, '✅ پیام همگانی ارسال شد!');
  } else if (text.startsWith('/uploadtext')) {
    const content = text.slice(11).trim();
    if (!content) {
      await sendMessage(chatId, '📝 لطفاً متن را وارد کنید!');
      return;
    }
    const fileId = `text_${Date.now()}`;
    await client.set(`fileType:${fileId}`, 'text');
    await client.set(`caption:${fileId}`, content);
    const link = await generateStartLink(fileId);
    await sendMessage(chatId, `🔗 *لینک اشتراک‌گذاری:*\n${link}`);
  }
}

async function handleFileUpload(update) {
  const chatId = update.message.chat.id;
  const username = update.message.from.username;
  if (!admins.includes(username)) {
    await sendMessage(chatId, '❌ شما ادمین نیستید!');
    return;
  }

  let file, fileType, filePath, caption = update.message.caption || '';
  
  if (update.message.photo) {
    file = update.message.photo[update.message.photo.length - 1];
    fileType = 'photo';
  } else if (update.message.document) {
    file = update.message.document;
    fileType = 'document';
  } else {
    await sendMessage(chatId, '📤 لطفاً فایل یا عکس ارسال کنید!');
    return;
  }

  const fileData = await axios.get(`${BOT_API}/getFile?file_id=${file.file_id}`);
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileData.data.result.file_path}`;
  const fileExt = path.extname(fileData.data.result.file_path);
  filePath = path.join(uploadDir, `${file.file_id}${fileExt}`);
  
  const response = await axios({
    url: fileUrl,
    method: 'GET',
    responseType: 'stream'
  });
  
  response.data.pipe(fs.createWriteStream(filePath));
  
  await client.set(`path:${file.file_id}`, filePath);
  await client.set(`fileType:${file.file_id}`, fileType);
  await client.set(`caption:${file.file_id}`, caption);
  
  const link = await generateStartLink(file.file_id);
  await sendMessage(chatId, `🔗 *لینک اشتراک‌گذاری:*\n${link}`);
}

async function pollUpdates() {
  try {
    const response = await axios.get(`${BOT_API}/getUpdates`, {
      params: { offset, timeout: 30 }
    });
    
    const updates = response.data.result;
    for (const update of updates) {
      offset = update.update_id + 1;
      
      if (update.message) {
        const chatId = update.message.chat.id;
        await client.lPush('users', chatId);
        
        if (update.message.text?.startsWith('/start')) {
          await handleStart(update);
        } else if (update.message.text?.startsWith('/')) {
          await handleAdminCommands(update);
        } else if (update.message.photo || update.message.document) {
          await handleFileUpload(update);
        } else {
          await sendMessage(chatId, '🤖 لطفاً دستور یا فایل معتبر ارسال کنید!');
        }
      }
    }
  } catch (error) {
    console.error('Error polling updates:', error.message);
  }
  setTimeout(pollUpdates, 1000);
}

pollUpdates();

process.on('SIGINT', async () => {
  await client.quit();
  process.exit();
});
