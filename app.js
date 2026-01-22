import blessed from 'blessed';
import { chromium } from 'playwright';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = path.join(__dirname, 'wallets.txt');
const PROXY_FILE = path.join(__dirname, 'proxies.txt');

const TARGET_URL = "https://faucet.testnet.miden.io/";
let MAX_CONCURRENT_BROWSERS = 4; 
const HEADLESS_MODE = true;

const MAX_RETRIES = 3; 
const RETRY_DELAY_MINUTES = 1; 

const MIN_LOOP_MINUTES = 5;  
const MAX_LOOP_MINUTES = 10;

let screen;
let bots = [];
let menuPageIndex = 0;
let dashboardInterval = null;
let currentView = 'menu';
let currentGroupIndex = 0;
let resizeTimeout = null;
let activeMenuHandler = null;
let activeGroupHandler = null;

let wrapperBox = null;
let bannerBox = null;
let dashboardBox = null;
let backBtn = null;

let activeBrowsers = 0;
const executionQueue = [];

const GROUPS_PER_MENU_PAGE = 5; 
const ACCOUNTS_PER_VIEW = 4;
const globalStats = { total: 0, success: 0, waiting: 0, errors: 0, proxies: 0 };


class MidenBot {
    constructor(wallet, proxy = null, id) {
        this.wallet = wallet;
        this.proxy = proxy; 
        this.id = id;
        this.status = 'Idle';
        this.nextRun = 'Ready';
        this.retryCount = 0;
        this.logs = [];
        this.isRendered = false;
        
        this.accountPane = null;
        this.logPane = null;
        this.browser = null;
        this.countdownInterval = null;
    }

    updateStatus(newStatus) {
        if (this.status === newStatus) return;
        this.status = newStatus;
        if (!this.isRendered && screen && currentView === 'menu') screen.render();
        this.refreshDisplay();
    }

    queueStart() {
        if (this.status.includes('Waiting') || this.status.includes('Queued')) return;
        this.updateStatus('Queued');
        this.addLog('Added to execution queue...');
        executionQueue.push(this);
        processQueue();
    }

    async runFaucet() {
        this.updateStatus('Running Browser');
        this.addLog(`Launching Chromium (Attempt ${this.retryCount + 1}/${MAX_RETRIES + 1})...`);
        
        let context = null;
        let page = null;

        try {
            const launchOptions = {
                headless: HEADLESS_MODE,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox'
                ]
            };

            if (this.proxy) {
                launchOptions.proxy = { server: this.proxy.server };
                if (this.proxy.username) {
                    launchOptions.proxy.username = this.proxy.username;
                    launchOptions.proxy.password = this.proxy.password;
                }
            }

            this.browser = await chromium.launch(launchOptions);
            
            context = await this.browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            page = await context.newPage();

            await page.addInitScript(() => {
                if (!Uint8Array.fromHex) {
                    Uint8Array.fromHex = function(hexString) {
                        if (hexString.length % 2 !== 0) throw new Error('Invalid hex');
                        const byteArray = new Uint8Array(hexString.length / 2);
                        for (let i = 0; i < hexString.length; i += 2) {
                            byteArray[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
                        }
                        return byteArray;
                    };
                }
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            this.addLog(`Opening ${TARGET_URL}`);
            await page.goto(TARGET_URL, { timeout: 60000 });
            
            this.addLog('Waiting for input...');
            await page.waitForSelector('#recipient-address', { state: 'visible', timeout: 30000 });

            this.addLog('Typing wallet...');
            await page.fill('#recipient-address', this.wallet);

              this.addLog('Selecting amount (1000)...');
            
            try {
                await page.selectOption('#token-amount', { label: '1000' });
            } catch (e) {
                const options = await page.$$('#token-amount option');
                if (options.length > 0) {
                     const lastValue = await options[options.length - 1].getAttribute('value');
                     await page.selectOption('#token-amount', lastValue);
                }
            }
            await page.waitForTimeout(2000 + Math.random() * 3000); 

            this.addLog('Clicking SEND...');
            await page.click('#send-public-button');

            this.updateStatus('Processing');
            this.addLog('Waiting for Proof Generation (60s)...');
            
            await page.waitForTimeout(60000);
            
            this.addLog('Cycle completed.');
            globalStats.success++;
            
            this.retryCount = 0;
            this.scheduleNextLoop();

        } catch (error) {
            this.addLog(`Error: ${error.message.substring(0, 45)}`);
            globalStats.errors++;
            
            if (this.retryCount < MAX_RETRIES) {
                this.retryCount++;
                this.scheduleRetry();
            } else {
                this.addLog(chalk.red('Max retries. Sleeping long.'));
                this.retryCount = 0; 
                this.scheduleNextLoop();
            }
        } finally {
            if (this.browser) {
                await this.browser.close().catch(() => {});
                this.browser = null;
            }
            activeBrowsers--;
            processQueue(); 
        }
    }


    scheduleRetry() {
        const waitMs = RETRY_DELAY_MINUTES * 60 * 1000;
        this.updateStatus(`Retry ${this.retryCount}/${MAX_RETRIES}`);
        this.addLog(`Retrying in ${RETRY_DELAY_MINUTES}m...`);
        this.startCountdown(waitMs);
    }

    scheduleNextLoop() {
        const minMs = MIN_LOOP_MINUTES * 60 * 1000;
        const maxMs = MAX_LOOP_MINUTES * 60 * 1000;
        const waitMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        
        const minutes = Math.floor(waitMs / 60000);
        
        this.updateStatus('Sleeping');
        this.addLog(`Sleeping for ${minutes}m...`);
        this.startCountdown(waitMs);
    }

    startCountdown(duration) {
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        
        let remainingSeconds = Math.floor(duration / 1000);
        this.updateCountdownText(remainingSeconds);

        this.countdownInterval = setInterval(() => {
            remainingSeconds--;
            if (remainingSeconds <= 0) {
                clearInterval(this.countdownInterval);
                this.nextRun = 'Ready';
                this.queueStart();
            } else {
                this.updateCountdownText(remainingSeconds);
            }
            this.refreshDisplay();
        }, 1000);
    }

    updateCountdownText(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) this.nextRun = `${h}h ${m}m`;
        else this.nextRun = `${m}m ${s}s`;
    }


    addLog(msg) {
        const time = new Date().toLocaleTimeString('en-GB');
        let coloredMsg = msg;

        if (msg.includes('Cycle completed')) coloredMsg = chalk.greenBright(msg);
        else if (msg.includes('Error')) coloredMsg = chalk.redBright(msg);
        else if (msg.includes('Retry')) coloredMsg = chalk.yellowBright(msg);
        else if (msg.includes('Sleeping')) coloredMsg = chalk.magenta(msg);
        else if (msg.includes('Launching')) coloredMsg = chalk.cyan(msg);
        
        this.logs.push(`${chalk.whiteBright('[' + time + ']')} ${coloredMsg}`);
        if (this.logs.length > 50) this.logs.shift();
        
        if (this.isRendered && this.logPane) {
            this.logPane.setContent(this.logs.join('\n'));
            this.logPane.setScrollPerc(100);
            screen.render();
        }
    }

    refreshDisplay() {
        if (!this.isRendered || !this.accountPane) return;
        
        let pName = 'Direct';
        if (this.proxy) pName = this.proxy.server.split('@').pop() || 'Proxy';
        
        let statusColor = chalk.white;
        if (this.status === 'Running Browser') statusColor = chalk.greenBright;
        else if (this.status === 'Queued') statusColor = chalk.yellow;
        else if (this.status === 'Sleeping') statusColor = chalk.magenta;
        else if (this.status.includes('Retry')) statusColor = chalk.redBright;

        const shortWallet = this.wallet.substring(0, 8) + '...' + this.wallet.substring(this.wallet.length - 6);

        const content = 
            `{bold}${shortWallet}{/bold}\n` +
            `{bold}Stat:{/bold} ${statusColor(this.status)}\n` +
            `{bold}Next:{/bold} ${chalk.cyan(this.nextRun)}\n` +
            `{bold}Prx:{/bold}  ${pName}`;

        this.accountPane.setContent(content);
    }

    attachUI(screenObj, top, left, height, width) {
        this.isRendered = true;
        this.accountPane = blessed.box({ 
            parent: screenObj, top: `${top}%`, left: `${left}%`, width: `${Math.floor(width * 0.40)}%`, height: `${height}%`, 
            label: ` Bot ${this.id} `, tags: true, border: { type: 'line' }, style: { border: { fg: 'cyan' } } 
        });
        this.logPane = blessed.box({ 
            parent: screenObj, top: `${top}%`, left: `${left + Math.floor(width * 0.40)}%`, width: `${Math.floor(width * 0.60)}%`, height: `${height}%`, 
            label: ' Logs ', content: this.logs.join('\n'), tags: true, scrollable: true, alwaysScroll: true, scrollbar: { ch: ' ', style: { bg: 'cyan' } }, 
            border: { type: 'line' }, style: { border: { fg: 'white' } } 
        });
        this.refreshDisplay();
    }

    detachUI(screenObj) {
        this.isRendered = false;
        if (this.accountPane) { screenObj.remove(this.accountPane); this.accountPane.destroy(); }
        if (this.logPane) { screenObj.remove(this.logPane); this.logPane.destroy(); }
        this.accountPane = null;
        this.logPane = null;
    }
}

function processQueue() {
    if (activeBrowsers >= MAX_CONCURRENT_BROWSERS) return;
    if (executionQueue.length === 0) return;

    const bot = executionQueue.shift();
    activeBrowsers++;
    bot.runFaucet();
}


function clearScreen() {
    if (activeMenuHandler) { screen.removeListener('keypress', activeMenuHandler); activeMenuHandler = null; }
    if (activeGroupHandler) { screen.removeListener('keypress', activeGroupHandler); activeGroupHandler = null; }
    if (wrapperBox) { screen.remove(wrapperBox); wrapperBox.destroy(); wrapperBox = null; }
    if (backBtn) { screen.remove(backBtn); backBtn.destroy(); backBtn = null; }
    bots.forEach(m => m.detachUI(screen));
    screen.render();
}

function showMainMenu() {
    currentView = 'menu';
    clearScreen();
    if (dashboardInterval) clearInterval(dashboardInterval);

    const height = screen.height;
    const isSmall = height < 34; 
    
    wrapperBox = blessed.box({ parent: screen, top: 'center', left: 'center', width: '85%', height: isSmall ? '100%' : 34, transparent: true });

    if (!isSmall) {
        const bannerContent = `
{red-fg}
  ██████╗ ███████╗██████╗       ██╗  ██╗ █████╗ ███╗   ██╗██████╗ 
  ██╔══██╗██╔════╝██╔══██╗      ██║  ██║██╔══██╗████╗  ██║██╔══██╗
  ██████╔╝█████╗  ██║  ██║      ███████║███████║██╔██╗ ██║██║  ██║
  ██╔══██╗██╔══╝  ██║  ██║      ██╔══██║██╔══██║██║╚██╗██║██║  ██║
  ██║  ██║███████╗██████╔╝      ██║  ██║██║  ██║██║ ╚████║██████╔╝
  ╚═╝  ╚═╝╚══════╝╚═════╝       ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ 
{/red-fg}
{center}Miden Faucet Automation{/center}
`;
        bannerBox = blessed.box({ parent: wrapperBox, top: 0, left: 'center', width: '100%', height: 10, content: bannerContent, tags: true, align: 'center', style: { border: { fg: 'red' } }, border: { type: 'line' } });
    }

    dashboardBox = blessed.box({ 
        parent: wrapperBox, top: isSmall ? 0 : 10, left: 'center', width: '100%', height: isSmall ? '100%' : 24, 
        border: { type: 'line' }, style: { border: { fg: 'red' }, bg: 'black' }, tags: true, label: ' {red-fg}RED HAND MONITOR{/red-fg} ' 
    });

    const statsBox = blessed.box({ 
        parent: dashboardBox, top: 1, left: 'center', width: '90%', height: 5, tags: true, 
        border: { type: 'line' }, style: { border: { fg: 'white' } }, label: ' Global Stats ' 
    });
    
    const updateDashboard = () => {
        const waiting = executionQueue.length;
        const content = ` {bold}Wallets:{/bold} ${globalStats.total}    {bold}Proxies:{/bold} ${globalStats.proxies}    {bold}Active Browser:{/bold} ${activeBrowsers}/${MAX_CONCURRENT_BROWSERS}\n` +
                        ` {bold}Success:{/bold} ${chalk.green(globalStats.success)}     {bold}Queue:{/bold} ${chalk.yellow(waiting)}       {bold}Errors:{/bold} ${chalk.red(globalStats.errors)}`;
        statsBox.setContent(content);
        screen.render();
    };
    updateDashboard();
    dashboardInterval = setInterval(updateDashboard, 1000);

    const listTop = 7; 
    const listBox = blessed.box({ parent: dashboardBox, top: listTop, left: 4, width: '50%', height: 'shrink', tags: true });
    const navBox = blessed.box({ parent: dashboardBox, top: listTop, left: '60%', width: '35%', height: 'shrink', tags: true });

    const totalGroups = Math.ceil(bots.length / ACCOUNTS_PER_VIEW);
    const renderMenuPage = () => {
        const startGroup = menuPageIndex * GROUPS_PER_MENU_PAGE;
        const endGroup = Math.min(startGroup + GROUPS_PER_MENU_PAGE, totalGroups);
        let listContent = '';
        let counter = 1;

        if (globalStats.total === 0) listContent = "{center}No wallets loaded.{/center}";
        else {
            for (let i = startGroup; i < endGroup; i++) {
                const accStart = (i * ACCOUNTS_PER_VIEW) + 1;
                const accEnd = Math.min((i + 1) * ACCOUNTS_PER_VIEW, bots.length);
                listContent += `{bold}{red-fg}[${counter}]{/red-fg}{/bold} Wallets ${accStart}-${accEnd}\n\n`;
                counter++;
            }
        }
        listBox.setContent(listContent);
        navBox.setContent(`Page ${menuPageIndex + 1}\n\n{bold}[ < ] Previous{/bold}\n{bold}[ > ] Next Page{/bold}\n\n{bold}{red-fg}[ Q ] Quit{/red-fg}{/bold}`);
        screen.render();
    };
    renderMenuPage();
    
    screen.append(wrapperBox);
    screen.render();

    const menuHandler = (ch, key) => {
        if (key.name === 'right' && (menuPageIndex + 1) * GROUPS_PER_MENU_PAGE < totalGroups) { menuPageIndex++; renderMenuPage(); }
        else if (key.name === 'left' && menuPageIndex > 0) { menuPageIndex--; renderMenuPage(); }
        else if (key.name === 'q') {
            bots.forEach(b => b.browser && b.browser.close());
            process.exit(0);
        }
        if (ch && /[1-5]/.test(ch)) {
            const selection = parseInt(ch);
            const absIndex = (menuPageIndex * GROUPS_PER_MENU_PAGE) + (selection - 1);
            if (absIndex < totalGroups) {
                if (dashboardInterval) clearInterval(dashboardInterval);
                screen.removeListener('keypress', menuHandler);
                showAccountGroup(absIndex);
            }
        }
    };
    activeMenuHandler = menuHandler;
    screen.on('keypress', menuHandler);
}

function showAccountGroup(groupIndex) {
    currentView = 'group';
    currentGroupIndex = groupIndex;
    clearScreen(); 

    const startIdx = groupIndex * ACCOUNTS_PER_VIEW;
    const endIdx = Math.min((groupIndex + 1) * ACCOUNTS_PER_VIEW, bots.length);
    const subset = bots.slice(startIdx, endIdx);

    subset.forEach((bot, index) => {
        const row = Math.floor(index / 2);
        const col = index % 2;
        const top = row * 50;
        const left = col * 50;
        bot.attachUI(screen, top, left, 50, 50);
    });

    backBtn = blessed.box({ bottom: 0, right: 0, width: 20, height: 3, content: '{center}{bold} [B] BACK {/bold}{/center}', tags: true, style: { bg: 'red', fg: 'white' }, border: { type: 'line', fg: 'white' } });
    screen.append(backBtn);
    screen.render();

    const pageHandler = (ch, key) => {
        if (key.name === 'b' || key.name === 'backspace' || key.name === 'escape') showMainMenu();
    };
    activeGroupHandler = pageHandler;
    screen.on('keypress', pageHandler);
}



async function main() {
    let wallets = [];
    let proxies = [];

    try { 
        wallets = (await fs.readFile(WALLET_FILE, 'utf8'))
            .split('\n')
            .map(x => x.trim())
            .filter(x => x.length > 5); 
    } catch (e) { 
        console.log(chalk.red(`Error: wallets.txt not found at ${WALLET_FILE}`)); 
        process.exit(1); 
    }

    try { 
        const rawProxies = (await fs.readFile(PROXY_FILE, 'utf8'))
            .split('\n')
            .map(x => x.trim())
            .filter(x => x.length > 5);
            
        proxies = rawProxies.map(p => {
            if (p.includes('@')) {
                return { server: p }; 
            } else {
                const parts = p.split(':');
                if (parts.length === 4) return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
                else return { server: `http://${parts[0]}:${parts[1]}` };
            }
        });
    } catch (e) { 
        
    }

    if (wallets.length === 1) {
        MAX_CONCURRENT_BROWSERS = 1;
        console.log(chalk.green(`Detected 1 wallet. Setting concurrency to 1 browser.`));
    } else {
        MAX_CONCURRENT_BROWSERS = 4; 
        console.log(chalk.green(`Detected ${wallets.length} wallets. Setting concurrency to ${MAX_CONCURRENT_BROWSERS} browsers.`));
    }

    await new Promise(r => setTimeout(r, 1500));

    globalStats.total = wallets.length;
    globalStats.proxies = proxies.length;

    for (let i = 0; i < wallets.length; i++) {
        const proxy = proxies.length > 0 ? proxies[i % proxies.length] : null;
        const bot = new MidenBot(wallets[i], proxy, i + 1);
        bots.push(bot);
        bot.queueStart();
    }

    screen = blessed.screen({ smartCSR: true, title: 'RED HAND - MIDEN' });
    
    process.on('unhandledRejection', (reason, p) => {});

    screen.key(['C-c'], () => {
        bots.forEach(b => { if (b.browser) b.browser.close(); });
        process.exit(0);
    });
    
    screen.on('resize', () => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (currentView === 'menu') showMainMenu();
            else if (currentView === 'group') showAccountGroup(currentGroupIndex);
        }, 200);
    });

    showMainMenu();
}

main();