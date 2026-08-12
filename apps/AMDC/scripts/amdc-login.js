// @ts-check
// AMDC 登录助手：弹出真实浏览器窗口，建立持久登录态到 .amdc-userdata
// 登录态落盘后，amdc-scraper.js 复用同一目录即可带登录态抓取（解锁下载量/收入/国家分布）
// 用法：node scripts/amdc-login.js   （登录完成后从外部 kill 本进程即可，session 已实时落盘）
const { chromium } = require('@playwright/test');
const path = require('path');

const PROJECT_DIR = path.resolve(process.env.AMDC_PROJECT_DIR || process.cwd());
const USER_DATA_DIR = path.resolve(PROJECT_DIR, process.env.AMDC_USERDATA_DIR || '.amdc-userdata');
// 账号通过环境变量提供（不写死、不入库）：set AMDC_EMAIL=you@example.com
const EMAIL = process.env.AMDC_EMAIL || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findToken(ctx) {
  const pages = ctx.pages().slice().reverse();
  for (const candidate of pages) {
    try {
      const token = await candidate.evaluate(() => (localStorage.getItem('datamagic.token') || '').replace(/^"|"$/g, ''));
      if (token) return token;
    } catch {}
  }
  return '';
}

function launchContext() {
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    viewport: null,
  });
}

(async () => {
  const ctx = await launchContext();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://appmagic.rocks/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  // 尽量自动点击登录入口 + 预填邮箱；失败则保留给用户手动
  try {
    const signin = await page.$(
      'a:has-text("Sign in"), button:has-text("Sign in"), a:has-text("Log in"), button:has-text("Log in"), :text("登录"), :text("登 录")'
    );
    if (signin) { await signin.click().catch(() => {}); await sleep(2500); }
    const emailInput = await page.$('input[type="email"], input[name*="mail" i], input[placeholder*="mail" i]');
    if (emailInput && EMAIL) { await emailInput.fill(EMAIL); console.log('  ✅ 已自动填入邮箱:', EMAIL); }
    else if (!EMAIL) console.log('  ⚠️  未设置 AMDC_EMAIL，请在窗口里手动输入登录邮箱（或设置环境变量后重跑可自动预填）');
    else console.log('  ⚠️  未自动定位到邮箱输入框，请在窗口里手动点登录并输入邮箱:', EMAIL);
  } catch (e) { console.log('  自动填邮箱跳过:', e.message); }

  console.log('\n========================================================');
  console.log('  浏览器窗口已打开。请在窗口中发送登录邮件。');
  console.log('  收到邮件后，回到看板粘贴链接，后端将直接交换登录 token。');
  console.log('========================================================\n');

  // 轮询 token：登录成功即自动退出(exit 0)；超时(默认5分钟)退出码 1。供 ps1 编排调用
  const WAIT_MIN = parseInt(process.env.AMDC_LOGIN_WAIT_MIN || '5', 10);
  const deadline = Date.now() + WAIT_MIN * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const tok = await findToken(ctx);
    if (tok) { console.log(`\n🎉 登录成功（token 长度 ${tok.length}），已落盘到 .amdc-userdata。`); await ctx.close(); process.exit(0); }
  }
  console.log(`\n⏳ ${WAIT_MIN} 分钟内未检测到登录，超时退出。请重新运行本脚本可再次登录。`);
  await ctx.close();
  process.exit(1);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
