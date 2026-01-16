# SuiNS Buddy

<p align="center">
  <img src="img/logo.png" alt="SuiNS Buddy" width="200">
</p>

A Telegram bot that tracks SuiNS name expirations and sends timely reminders.

**[Try it on Telegram](https://t.me/suinames_bot)**

## Features

- **Track SuiNS names** - Get notified before your names expire
- **Search by address** - Look up all names owned by any Sui address
- **Search by name** - Check availability and expiration of any `.sui` name
- **Smart notifications** - Alerts at 30 days, 14 days, 3 days, 1 day, and on expiration

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot |
| `/help` | Show help information |
| `/privacy` | Privacy policy |
| `/developer_info` | Developer contact |
| `/delete` | Delete all your tracking data |

## Self-hosting

### Prerequisites

- Docker and Docker Compose
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/sui-potatoes/suins-bot.git
   cd suins-bot
   ```

2. Create a `.env` file:
   ```
   NS_BOT_TOKEN=your_telegram_bot_token
   ```

3. Start the bot:
   ```bash
   docker-compose up -d --build
   ```

### Updating

```bash
git pull && docker-compose up -d --build
```

## Development

```bash
pnpm install
NS_BOT_TOKEN=your_token pnpm exec ts-node-dev src/index.ts
```

## License

MIT - [Sui Potatoes](https://github.com/sui-potatoes)
