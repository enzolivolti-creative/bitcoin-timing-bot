// Final version - No Binance (avoids 451 completely)
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 15;
const BUY_THRESHOLD = parseInt(process.env.BUY_THRESHOLD) || 70;
const SELL_THRESHOLD = parseInt(process.env.SELL_THRESHOLD) || 70;
const RISK_PROFILE = process.env.RISK_PROFILE || 'Moderate';
const ONLY_STRONG_SIGNALS = process.env.ONLY_STRONG_SIGNALS === 'true';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Variabili mancanti!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let lastBuyScore = 0;
let lastSellScore = 0;
let lastAction = 'HOLD';
let isMonitoring = true;
let priceHistory = []; // Cache prezzi per analisi

console.log('🤖 Bitcoin Bot - CoinGecko Mode (No 451!)');
console.log(`📊 Check ogni ${CHECK_INTERVAL} min`);
console.log(`⚡ ${RISK_PROFILE}`);

const profileThresholds = {
  Conservative: { buyStrong: 75, buyWeak: 60, sellStrong: 75, sellWeak: 60 },
  Moderate: { buyStrong: 70, buyWeak: 50, sellStrong: 70, sellWeak: 50 },
  Aggressive: { buyStrong: 65, buyWeak: 45, sellStrong: 65, sellWeak: 45 }
};

const profileMultipliers = {
  Conservative: { position: 0.2, stopLoss: 0.03, tp1: 1.05, tp2: 1.12 },
  Moderate: { position: 0.3, stopLoss: 0.04, tp1: 1.08, tp2: 1.18 },
  Aggressive: { position: 0.5, stopLoss: 0.05, tp1: 1.12, tp2: 1.25 }
};

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50; // Neutral default
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateBollinger(prices, period = 20) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const sma = recentPrices.reduce((a, b) => a + b) / period;
  const squaredDiffs = recentPrices.map(p => Math.pow(p - sma, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / period;
  const stdDev = Math.sqrt(variance);
  const upper = sma + (2 * stdDev);
  const lower = sma - (2 * stdDev);
  const current = prices[prices.length - 1];
  let position = 'middle';
  if (current < lower) position = 'below_lower';
  else if (current > upper) position = 'above_upper';
  return { upper, lower, position, current };
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  return recentPrices.reduce((a, b) => a + b) / period;
}

async function getBitcoinPrice() {
  try {
    // CoinGecko - più affidabile, no geoblocking
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true',
      {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BitcoinTimingBot/1.0'
        }
      }
    );
    
    if (response.data && response.data.bitcoin) {
      return {
        price: response.data.bitcoin.usd,
        change24h: response.data.bitcoin.usd_24h_change || 0
      };
    }
    
    return null;
  } catch (error) {
    console.warn(`⚠️ CoinGecko: ${error.message}`);
    return null;
  }
}

async function getFearGreed() {
  try {
    const response = await axios.get(
      'https://api.alternative.me/fng/?limit=1',
      { timeout: 5000 }
    );
    
    if (response.data && response.data.data && response.data.data[0]) {
      return parseInt(response.data.data[0].value);
    }
    
    return null;
  } catch (error) {
    console.warn('⚠️ F&G skip');
    return null;
  }
}

async function analyzeMarket() {
  try {
    console.log(`🔍 [${new Date().toLocaleTimeString()}] Analisi...`);
    
    // Get price from CoinGecko
    const priceData = await getBitcoinPrice();
    
    if (!priceData) {
      console.error('❌ Impossibile ottenere prezzo');
      return;
    }
    
    const currentPrice = priceData.price;
    const priceChangePct = priceData.change24h;
    
    console.log(`💰 $${currentPrice.toFixed(2)} (${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%)`);
    
    // Build price history
    priceHistory.push(currentPrice);
    if (priceHistory.length > 200) {
      priceHistory.shift(); // Keep last 200
    }
    
    // Need at least 50 prices for meaningful analysis
    if (priceHistory.length < 50) {
      console.log(`📊 Raccolta dati... ${priceHistory.length}/50`);
      return;
    }
    
    // Get Fear & Greed (optional)
    const fearGreedValue = await getFearGreed();
    
    // Calculate indicators
    const rsi = calculateRSI(priceHistory);
    const bollinger = calculateBollinger(priceHistory);
    const sma200 = calculateSMA(priceHistory, Math.min(200, priceHistory.length));
    const recentHigh = Math.max(...priceHistory);
    const drawdown = ((currentPrice - recentHigh) / recentHigh) * 100;
    
    console.log(`📈 RSI: ${rsi.toFixed(1)}, DD: ${drawdown.toFixed(1)}%`);
    
    // Buy Score
    let buyScore = 0;
    const buyReasons = [];
    
    if (rsi < 25) {
      buyScore += 30;
      buyReasons.push(`RSI molto ipervenduto (${rsi.toFixed(1)})`);
    } else if (rsi < 30) {
      buyScore += 20;
      buyReasons.push(`RSI ipervenduto (${rsi.toFixed(1)})`);
    } else if (rsi < 40) {
      buyScore += 5;
    }
    
    if (bollinger && bollinger.position === 'below_lower') {
      buyScore += 20;
      buyReasons.push('Sotto banda Bollinger');
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue < 20) {
        buyScore += 25;
        buyReasons.push(`Paura estrema (${fearGreedValue})`);
      } else if (fearGreedValue < 30) {
        buyScore += 15;
        buyReasons.push(`Paura mercato (${fearGreedValue})`);
      } else if (fearGreedValue < 50) {
        buyScore += 5;
      }
    }
    
    if (sma200 && Math.abs(currentPrice - sma200) / sma200 < 0.02) {
      buyScore += 10;
      buyReasons.push(`Supporto SMA200 ($${sma200.toFixed(0)})`);
    }
    
    if (drawdown <= -60) {
      buyScore += 10;
      buyReasons.push(`Drawdown severo (${drawdown.toFixed(1)}%)`);
    } else if (drawdown <= -40) {
      buyScore += 5;
    }
    
    buyScore = Math.max(0, Math.min(100, buyScore));
    
    // Sell Score
    let sellScore = 0;
    const sellReasons = [];
    
    if (rsi > 80) {
      sellScore += 30;
      sellReasons.push(`RSI molto ipercomprato (${rsi.toFixed(1)})`);
    } else if (rsi > 75) {
      sellScore += 20;
      sellReasons.push(`RSI ipercomprato (${rsi.toFixed(1)})`);
    } else if (rsi > 70) {
      sellScore += 10;
    }
    
    if (bollinger && bollinger.position === 'above_upper') {
      sellScore += 20;
      sellReasons.push('Sopra banda Bollinger');
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue > 85) {
        sellScore += 25;
        sellReasons.push(`Avidità estrema (${fearGreedValue})`);
      } else if (fearGreedValue > 75) {
        sellScore += 15;
        sellReasons.push(`Avidità mercato (${fearGreedValue})`);
      }
    }
    
    const sma50 = calculateSMA(priceHistory, Math.min(50, priceHistory.length));
    if (sma50 && sma200 && currentPrice > sma50 && sma50 > sma200 && drawdown >= -10) {
      sellScore += 15;
      sellReasons.push('Vicino massimi');
    }
    
    sellScore = Math.max(0, Math.min(100, sellScore));
    
    // Determine action
    const thresholds = profileThresholds[RISK_PROFILE];
    const multipliers = profileMultipliers[RISK_PROFILE];
    
    let action = 'HOLD';
    let actionIcon = '⏸️';
    let actionText = 'HOLD';
    let confidence = 50;
    
    if (buyScore >= thresholds.buyStrong && sellScore < 50) {
      action = 'BUY_STRONG';
      actionIcon = '🟢';
      actionText = 'COMPRA ORA';
      confidence = Math.min(95, 60 + (buyScore - thresholds.buyStrong));
    } else if (buyScore >= thresholds.buyWeak && sellScore < 50) {
      action = 'BUY_WEAK';
      actionIcon = '🟡';
      actionText = 'ACCUMULA (DCA)';
      confidence = Math.min(75, 50 + (buyScore - thresholds.buyWeak));
    } else if (sellScore >= thresholds.sellStrong && buyScore < 50) {
      action = 'SELL_STRONG';
      actionIcon = '🔴';
      actionText = 'VENDI';
      confidence = Math.min(90, 55 + (sellScore - thresholds.sellStrong));
    } else if (sellScore >= thresholds.sellWeak && buyScore < 50) {
      action = 'SELL_WEAK';
      actionIcon = '🟠';
      actionText = 'PROFITTO PARZIALE';
      confidence = Math.min(70, 50 + (sellScore - thresholds.sellWeak));
    } else if (buyScore >= 50 && sellScore >= 50) {
      action = 'CONFLICT';
      actionIcon = '⚠️';
      actionText = 'CAUTELA';
      confidence = 45;
    }
    
    const entryLow = currentPrice * 0.985;
    const entryHigh = currentPrice * 1.015;
    const stopLossPrice = currentPrice * (1 - multipliers.stopLoss);
    const tp1Price = currentPrice * multipliers.tp1;
    const tp2Price = currentPrice * multipliers.tp2;
    const stopLossPct = -multipliers.stopLoss * 100;
    const tp1Pct = (multipliers.tp1 - 1) * 100;
    const tp2Pct = (multipliers.tp2 - 1) * 100;
    const positionSize = multipliers.position * 100;
    
    console.log(`📊 Buy: ${buyScore}, Sell: ${sellScore} → ${action}`);
    
    // Check if should notify
    const shouldNotify = (
      (action !== lastAction && action !== 'HOLD') ||
      buyScore >= BUY_THRESHOLD ||
      sellScore >= SELL_THRESHOLD ||
      (ONLY_STRONG_SIGNALS && (action === 'BUY_STRONG' || action === 'SELL_STRONG'))
    );
    
    if (shouldNotify && Math.abs(buyScore - lastBuyScore) >= 10) {
      await sendAlert({
        action, actionIcon, actionText, confidence, currentPrice, priceChangePct,
        buyScore, sellScore, buyReasons, sellReasons,
        entryLow, entryHigh, stopLossPrice, stopLossPct,
        tp1Price, tp1Pct, tp2Price, tp2Pct, positionSize,
        rsi, fearGreedValue, drawdown
      });
    }
    
    lastBuyScore = buyScore;
    lastSellScore = sellScore;
    lastAction = action;
    
  } catch (error) {
    console.error('❌ Errore:', error.message);
  }
}

async function sendAlert(data) {
  try {
    const {
      actionIcon, actionText, confidence, currentPrice, priceChangePct,
      buyScore, sellScore, buyReasons, sellReasons,
      entryLow, entryHigh, stopLossPrice, stopLossPct,
      tp1Price, tp1Pct, tp2Price, tp2Pct, positionSize,
      rsi, fearGreedValue, drawdown, action
    } = data;
    
    const changeSymbol = priceChangePct >= 0 ? '📈' : '📉';
    const changeSign = priceChangePct >= 0 ? '+' : '';
    
    let message = `
🔔 <b>BITCOIN ALERT</b>

${actionIcon} <b>${actionText}</b>
📊 Confidenza: <b>${confidence}%</b>

💰 <b>PREZZO</b>
• $${currentPrice.toFixed(2)}
• 24h: ${changeSymbol} ${changeSign}${priceChangePct.toFixed(2)}%

📈 <b>SCORES</b>
• Buy: ${buyScore}/100
• Sell: ${sellScore}/100
`;

    if (action.startsWith('BUY')) {
      message += `
🎯 <b>PIANO</b>
• Entry: $${entryLow.toFixed(0)}-${entryHigh.toFixed(0)}
• Pos: ${positionSize.toFixed(0)}%
• Stop: $${stopLossPrice.toFixed(0)} (${stopLossPct.toFixed(1)}%)
• TP1: $${tp1Price.toFixed(0)} (+${tp1Pct.toFixed(1)}%)
• TP2: $${tp2Price.toFixed(0)} (+${tp2Pct.toFixed(1)}%)

💡 <b>PERCHÉ</b>
`;
      buyReasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
      
    } else if (action.startsWith('SELL')) {
      message += `
🎯 <b>AZIONE</b>
• Vendi: ${positionSize.toFixed(0)}%
• Stop: $${stopLossPrice.toFixed(0)}

💡 <b>PERCHÉ</b>
`;
      sellReasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
    }
    
    message += `
📊 <b>INDICATORI</b>
• RSI: ${rsi.toFixed(1)}
• F&G: ${fearGreedValue || 'N/A'}
• DD: ${drawdown.toFixed(1)}%

⏰ ${new Date().toLocaleString('it-IT')}
`;

    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Alert inviato!`);
    
  } catch (error) {
    console.error('❌ Alert fallito:', error.message);
  }
}

// Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🤖 <b>Bitcoin Bot</b>

⚙️ Check ogni ${CHECK_INTERVAL} min
⚡ ${RISK_PROFILE}

/status - Analisi
/pause - Pausa
/resume - Attivo
`, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔍 Analisi...');
  await analyzeMarket();
});

bot.onText(/\/pause/, (msg) => {
  isMonitoring = false;
  bot.sendMessage(msg.chat.id, '⏸️ PAUSA');
});

bot.onText(/\/resume/, (msg) => {
  isMonitoring = true;
  bot.sendMessage(msg.chat.id, '▶️ ATTIVO');
});

// Scheduler
const cronExpression = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpression, async () => {
  if (isMonitoring) {
    await analyzeMarket();
  }
});

// Start
setTimeout(() => {
  bot.sendMessage(CHAT_ID, `
🚀 <b>Bot Avviato!</b>

Monitoraggio 24/7
📊 Check ogni ${CHECK_INTERVAL} min

/help per info
`, { parse_mode: 'HTML' }).catch(err => {
    console.error('Msg iniziale:', err.message);
  });
  
  // First analysis
  analyzeMarket();
}, 3000);

process.on('unhandledRejection', (err) => {
  console.error('Rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Exception:', err.message);
});

console.log('✅ Bot ready (CoinGecko mode)!');
