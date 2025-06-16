import requests
import base64
import logging
import asyncio
from telegram import Update, Bot
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

# Enable logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# Telegram bot token
TELEGRAM_TOKEN = ""

# API configuration
API_URL = "https://api.llm7.io/v1/chat/completions"
API_HEADERS = {
    "Authorization": "Bearer unused",  # Replace with your API key from https://token.llm7.io/
    "Content-Type": "application/json"
}

# Store chat history per user (user_id -> list of messages)
chat_history = {}

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send a welcome message and initialize chat history."""
    user_id = update.effective_user.id
    chat_history[user_id] = []  # Initialize history for new user
    welcome_text = (
        "Hello! I'm a chatbot that remembers our conversation. "
        "Send a text or an image (with or without a caption), and I'll respond with context! "
        "For images, I'll try to caption them or respond to your caption."
    )
    await update.message.reply_text(welcome_text)
    chat_history[user_id].append({"role": "assistant", "content": welcome_text})

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Send a help message."""
    user_id = update.effective_user.id
    help_text = (
        "Send a text message, and I'll respond with context. "
        "Send an image with an optional caption (e.g., 'is this cool'), and I'll caption it or respond to your caption. "
        "Use /start to reset or /help for this info."
    )
    await update.message.reply_text(help_text)
    if user_id not in chat_history:
        chat_history[user_id] = []
    chat_history[user_id].append({"role": "assistant", "content": help_text})

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle text messages by sending them to the API with chat history."""
    user_id = update.effective_user.id
    user_text = update.message.text
    logger.info(f"User {user_id} sent text: {user_text}")

    # Initialize history if not exists
    if user_id not in chat_history:
        chat_history[user_id] = []

    # Add user message to history
    chat_history[user_id].append({"role": "user", "content": user_text})

    # Prepare API request with full chat history
    data = {
        "model": "gpt-4.1-nano",
        "messages": chat_history[user_id]
    }

    try:
        response = requests.post(API_URL, headers=API_HEADERS, json=data)
        response.raise_for_status()
        response_content = response.json()["choices"][0]["message"]["content"]
        await update.message.reply_text(response_content)
        # Add bot response to history
        chat_history[user_id].append({"role": "assistant", "content": response_content})
    except requests.RequestException as e:
        logger.error(f"API request failed for user {user_id}: {e}")
        error_message = "Sorry, I couldn't process your request. Try again later."
        await update.message.reply_text(error_message)
        chat_history[user_id].append({"role": "assistant", "content": error_message})

async def handle_image(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle image messages by downloading, encoding, and sending to the API."""
    user_id = update.effective_user.id
    logger.info(f"User {user_id} sent image")

    # Initialize history if not exists
    if user_id not in chat_history:
        chat_history[user_id] = []

    # Get the highest resolution photo
    photo = update.message.photo[-1]
    file = await photo.get_file()
    
    # Get the caption, if any
    user_caption = update.message.caption or ""
    logger.info(f"User {user_id} image caption: {user_caption}")

    # Download the image
    file_path = file.file_path
    response = requests.get(file_path)
    if response.status_code != 200:
        error_message = "Failed to download the image."
        await update.message.reply_text(error_message)
        chat_history[user_id].append({"role": "assistant", "content": error_message})
        return

    # Encode image to base64
    image_data = base64.b64encode(response.content).decode("utf-8")

    # Combine default prompt with user caption
    prompt = f"Caption this image: {user_caption}" if user_caption else "Caption this image"
    logger.info(f"Image prompt for user {user_id}: {prompt}")

    # Prepare image message
    image_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_data}"}}
        ]
    }

    # Add image message to history
    chat_history[user_id].append(image_message)

    # Prepare API request with chat history
    data = {
        "model": "gpt-4.1-nano",
        "messages": chat_history[user_id]
    }

    try:
        api_response = requests.post(API_URL, headers=API_HEADERS, json=data)
        api_response.raise_for_status()
        caption_response = api_response.json()["choices"][0]["message"]["content"]
        await update.message.reply_text(caption_response)
        chat_history[user_id].append({"role": "assistant", "content": caption_response})
    except requests.RequestException as e:
        logger.error(f"Image API request failed for user {user_id}: {str(e)}")
        # Fallback if image processing fails
        fallback_message = (
            f"Sorry, I couldn't process the image. The API may not support image inputs. "
            f"Please describe the image in text, and I'll respond to '{user_caption}' or a description."
        )
        await update.message.reply_text(fallback_message)
        chat_history[user_id].append({"role": "assistant", "content": fallback_message})

async def run_bot():
    """Run the bot using the existing event loop."""
    try:
        # Create the bot instance
        bot = Bot(token=TELEGRAM_TOKEN)
        # Explicitly initialize the bot
        await bot.initialize()
        
        # Create the application
        application = Application.builder().token(TELEGRAM_TOKEN).build()

        # Add handlers
        application.add_handler(CommandHandler("start", start))
        application.add_handler(CommandHandler("help", help_command))
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
        application.add_handler(MessageHandler(filters.PHOTO, handle_image))

        # Start polling
        await application.initialize()
        await application.start()
        await application.updater.start_polling(allowed_updates=Update.ALL_TYPES)

        # Keep the bot running
        while True:
            await asyncio.sleep(3600)

    except Exception as e:
        logger.error(f"Bot failed to start or run: {e}")
        raise
    finally:
        if 'application' in locals():
            await application.stop()
            await application.shutdown()

def main():
    """Entry point to run the bot."""
    loop = asyncio.get_event_loop()
    try:
        if loop.is_running():
            logger.info("Using existing event loop")
            loop.create_task(run_bot())
        else:
            loop.run_until_complete(run_bot())
    except KeyboardInterrupt:
        logger.info("Bot stopped by user")
    except Exception as e:
        logger.error(f"Error in main: {e}")

if __name__ == "__main__":
    main()
