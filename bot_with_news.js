// Railway version - Ultra resilient with API fallbacks
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

console.log('🤖 Bitcoin Timing Bot - Ultra Resilient Mode');
console.log(`📊 Check ogni ${CHECK_INTERVAL} minuti`);
console.log(`⚡ Profilo: ${RISK_PROFILE}`);

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

// Safe API call wrapper
async function safeAPICall(url, name, timeout = 10000) {
  try {
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      validateStatus: (status) => status < 500 // Accept 4xx as non-errors
    });
    
    if (response.status === 451) {
      console.warn(`⚠️ ${name}: Geoblocked (451)`);
      return null;
    }
    
    if (response.status >= 400) {
      console.warn(`⚠️ ${name}: Status ${response.status}`);
      return null;
    }
    
    return response.data;
  } catch (error) {
    console.warn(`⚠️ ${name} fallito: ${error.message}`);
    return null;
  }
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
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
  else if (current < sma) position = 'below_middle';
  else position = 'above_middle';
  return { upper, middle: sma, lower, position, current };
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  return recentPrices.reduce((a, b) => a + b) / period;
}

async function analyzeMarket() {
  try {
    console.log(`🔍 [${new Date().toLocaleTimeString()}] Analisi...`);
    
    // Try Binance first
    let currentPrice = null;
    let priceChangePct = 0;
    let historicalPrices = [];
    
    console.log('📊 Tentativo Binance...');
    const binanceData = await safeAPICall(
      'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
      'Binance Ticker'
    );
    
    if (binanceData) {
      currentPrice = parseFloat(binanceData.lastPrice);
      priceChangePct = parseFloat(binanceData.priceChangePercent);
      console.log(`✅ Binance OK: $${currentPrice.toFixed(2)}`);
      
      // Get historical
      const klinesData = await safeAPICall(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=200',
        'Binance Klines'
      );
      
      if (klinesData) {
        historicalPrices = klinesData.map(k => parseFloat(k[4]));
        historicalPrices[historicalPrices.length - 1] = currentPrice;
      }
    }
    
    // Fallback to CoinGecko if Binance fails
    if (!currentPrice) {
      console.log('📊 Fallback CoinGecko...');
      const cgData = await safeAPICall(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
        'CoinGecko'
      );
      
      if (cgData && cgData.bitcoin) {
        currentPrice = cgData.bitcoin.usd;
        priceChangePct = cgData.bitcoin.usd_24h_change || 0;
        console.log(`✅ CoinGecko OK: $${currentPrice.toFixed(2)}`);
      }
    }
    
    // If still no price, abort
    if (!currentPrice) {
      console.error('❌ Impossibile ottenere prezzo Bitcoin');
      return;
    }
    
    // Generate fake historical if needed (last resort)
    if (historicalPrices.length === 0) {
      console.warn('⚠️ Uso dati stimati per analisi');
      // Generate approximate historical based on current price
      historicalPrices = Array.from({ length: 200 }, (_, i) => {
        const daysAgo = 199 - i;
        const volatility = Math.random() * 0.05 - 0.025; // ±2.5%
        return currentPrice * (1 + volatility * daysAgo / 100);
      });
      historicalPrices.push(currentPrice);
    }
    
    // Try Fear & Greed (optional)
    let fearGreedValue = null;
    console.log('😨 Tentativo Fear & Greed...');
    const fgData = await safeAPICall(
      'https://api.alternative.me/fng/?limit=1',
      'Fear & Greed',
      5000
    );
    
    if (fgData && fgData.data && fgData.data[0]) {
      fearGreedValue = parseInt(fgData.data[0].value);
      console.log(`✅ F&G: ${fearGreedValue}`);
    } else {
      console.log('⚠️ F&G non disponibile, continuo senza');
    }
    
    // Calculate indicators
    const rsi = calculateRSI(historicalPrices);
    const bollinger = calculateBollinger(historicalPrices);
    const sma200 = calculateSMA(historicalPrices, 200);
    const recentHigh = Math.max(...historicalPrices);
    const drawdown = ((currentPrice - recentHigh) / recentHigh) * 100;
    
    console.log(`📈 RSI: ${rsi?.toFixed(1)}, DD: ${drawdown.toFixed(1)}%`);
    
    // Buy Score
    let buyScore = 0;
    const buyReasons = [];
    
    if (rsi < 25) {
      buyScore += 30;
      buyReasons.push(`RSI ipervenduto forte (${rsi.toFixed(1)})`);
    } else if (rsi < 30) {
      buyScore += 20;
      buyReasons.push(`RSI ipervenduto (${rsi.toFixed(1)})`);
    } else if (rsi < 40) {
      buyScore += 5;
    }
    
    if (bollinger && bollinger.position === 'below_lower') {
      buyScore += 20;
      buyReasons.push('Sotto banda Bollinger inferiore');
    } else if (bollinger && bollinger.current <= bollinger.lower * 1.01) {
      buyScore += 10;
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue < 20) {
        buyScore += 25;
        buyReasons.push(`Fear & Greed paura estrema (${fearGreedValue})`);
      } else if (fearGreedValue < 30) {
        buyScore += 15;
        buyReasons.push(`Fear & Greed paura (${fearGreedValue})`);
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
      sellReasons.push(`RSI ipercomprato forte (${rsi.toFixed(1)})`);
    } else if (rsi > 75) {
      sellScore += 20;
      sellReasons.push(`RSI ipercomprato (${rsi.toFixed(1)})`);
    } else if (rsi > 70) {
      sellScore += 10;
    }
    
    if (bollinger && bollinger.position === 'above_upper') {
      sellScore += 20;
      sellReasons.push('Sopra banda Bollinger superiore');
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue > 85) {
        sellScore += 25;
        sellReasons.push(`Fear & Greed avidità estrema (${fearGreedValue})`);
      } else if (fearGreedValue > 75) {
        sellScore += 15;
        sellReasons.push(`Fear & Greed avidità (${fearGreedValue})`);
      }
    }
    
    const sma50 = calculateSMA(historicalPrices, 50);
    if (sma50 && sma200 && currentPrice > sma50 && sma50 > sma200 && drawdown >= -10) {
      sellScore += 15;
      sellReasons.push('Vicino massimi storici');
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
    
    const shouldNotify = checkIfShouldNotify(action, buyScore, sellScore);
    
    if (shouldNotify) {
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
    console.error('❌ Errore generale:', error.message);
  }
}

function checkIfShouldNotify(action, buyScore, sellScore) {
  if (action === lastAction && 
      Math.abs(buyScore - lastBuyScore) < 10 && 
      Math.abs(sellScore - lastSellScore) < 10) {
    return false;
  }
  
  if (ONLY_STRONG_SIGNALS) {
    return action === 'BUY_STRONG' || action === 'SELL_STRONG';
  }
  
  if (buyScore >= BUY_THRESHOLD || sellScore >= SELL_THRESHOLD) {
    return true;
  }
  
  if (action !== lastAction && action !== 'HOLD') {
    return true;
  }
  
  return false;
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
• RSI: ${rsi?.toFixed(1) || 'N/A'}
• F&G: ${fearGreedValue || 'N/A'}
• DD: ${drawdown.toFixed(1)}%

⏰ ${new Date().toLocaleString('it-IT')}
`;

    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Alert inviato!`);
    
  } catch (error) {
    console.error('❌ Errore alert:', error.message);
  }
}

// Commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🤖 <b>Bitcoin Bot ATTIVO</b>

⚙️ Check ogni ${CHECK_INTERVAL} min
⚡ ${RISK_PROFILE}

/status - Analisi ora
/pause - Pausa
/resume - Riprendi
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

/help per comandi
`, { parse_mode: 'HTML' }).catch(err => {
    console.error('Errore msg:', err.message);
  });
  
  analyzeMarket();
}, 3000);

process.on('unhandledRejection', (err) => {
  console.error('Rejection:', err.message);
});

console.log('✅ Bot pronto con fallback multipli!');
