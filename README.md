# 🔴 Red Hand - Miden Faucet Bot
A sophisticated, terminal-based automation tool for the Miden Testnet Faucet.

## ✨ Features
🖥️ Retro TUI: A full-dashboard terminal interface to monitor multiple wallets simultaneously.

🧠 Smart Concurrency: Automatically adjusts resource usage.

🛡️ Proxy Support: Rotates proxies per wallet to avoid rate limits (supports IP and User:Pass auth).

🕵️ Stealth Mode: Uses refined browser arguments to mask automation from detection.

♻️ Auto-Retry: robust error handling that retries failed claims up to 3 times before sleeping.

## 📥 Installation
**Clone the Repository**

```Bash
git clone https://github.com/Chupii37/Miden.git
cd Miden
```
**Install Dependencies**
```Bash
npm install
npx playwright install chromium
```

**⚙️ Configuration**
You must create two files in the root directory. These files are ignored by git to keep your data safe.

1. wallets.txt
Add your Miden wallet addresses, one per line.
```Bash
nano wallets.txt
```

2. proxies.txt (Optional)
Add your proxies, one per line. The bot will rotate through them. Supported formats:
- http://user:pass@ip:port
- ip:port:user:pass
- ip:port (if IP authenticated)
```Bash
nano proxies.txt
```

**🚀 Usage**
Simply run the start command:

```Bash
npm start
```

## ⚠️ Disclaimer
This tool is for educational purposes only. I am not responsible for any banned accounts or lost tokens. Use at your own risk and be a good citizen of the testnet.

## ☕ Fuel the Machine (Treats & Caffeine)
If this code saved your fingers from repetitive clicking, consider buying me a "digital beverage." Here is the menu of acceptable caffeinated transactions:

The "Git Push" Espresso: Short, dark, and strong enough to fix merge conflicts at 3 AM.

The "Panic Kernel" Cold Brew: Iced coffee so potent it halts the CPU.

Latte of Lesser Lag: A smooth blend that reduces ping and increases dopamine.

The "Syntax Sugar" Frappé: Pure sweetness, zero nutritional value, but makes the code look pretty.

Deprecation Decaf: (Please don't buy this, it's just sad water).

[https://saweria.co/chupii]
