// Final version - With historical data import + EUR support
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
let priceHistory = [];
let isInitialized = false;
let eurUsdRate = 1.08; // Default exchange rate

console.log('🤖 Bitcoin Bot - USD/EUR + Dati Storici');
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

// ==================== EUR/USD EXCHANGE RATE ====================

async function getExchangeRate() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur',
      {
        timeout: 5000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BitcoinTimingBot/1.0'
        }
      }
    );
    
    if (response.data && response.data.bitcoin) {
      const usd = response.data.bitcoin.usd;
      const eur = response.data.bitcoin.eur;
      
      if (usd && eur) {
        eurUsdRate = usd / eur; // Calculate USD/EUR rate
        console.log(`💱 Cambio EUR/USD: ${eurUsdRate.toFixed(4)}`);
        return eurUsdRate;
      }
    }
    
    return eurUsdRate; // Return last known rate
  } catch (error) {
    console.warn('⚠️ Cambio EUR/USD: uso ultimo valore');
    return eurUsdRate;
  }
}

function convertToEUR(usdAmount) {
  return usdAmount / eurUsdRate;
}

// ==================== HISTORICAL DATA IMPORT ====================

async function importHistoricalData() {
  try {
    console.log('📥 Import dati storici da CoinGecko...');
    
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart',
      {
        params: {
          vs_currency: 'usd',
          days: '200',
          interval: 'daily'
        },
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'BitcoinTimingBot/1.0'
        }
      }
    );
    
    if (response.data && response.data.prices) {
      const prices = response.data.prices.map(item => item[1]);
      priceHistory = prices;
      
      console.log(`✅ Importati ${priceHistory.length} prezzi storici`);
      console.log(`📊 Range: $${Math.min(...priceHistory).toFixed(0)} - $${Math.max(...priceHistory).toFixed(0)}`);
      console.log(`💰 Ultimo: $${priceHistory[priceHistory.length - 1].toFixed(2)}`);
      
      isInitialized = true;
      return true;
    }
    
    console.warn('⚠️ Formato dati inatteso');
    return false;
    
  } catch (error) {
    console.error(`❌ Errore import: ${error.message}`);
    console.log('⚠️ Continuo con raccolta manuale');
    return false;
  }
}

// ==================== TECHNICAL INDICATORS ====================

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
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

// ==================== PRICE DATA ====================

async function getCurrentPrice() {
  try {
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
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
    console.warn(`⚠️ Prezzo: ${error.message}`);
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
    return null;
  }
}

// ==================== MARKET ANALYSIS ====================

async function analyzeMarket() {
  try {
    console.log(`🔍 [${new Date().toLocaleTimeString()}] Analisi...`);
    
    // Update exchange rate
    await getExchangeRate();
    
    // Get current price
    const priceData = await getCurrentPrice();
    
    if (!priceData) {
      console.error('❌ Impossibile ottenere prezzo');
      return;
    }
    
    const currentPrice = priceData.price;
    const currentPriceEUR = convertToEUR(currentPrice);
    const priceChangePct = priceData.change24h;
    
    console.log(`💰 $${currentPrice.toFixed(2)} / €${currentPriceEUR.toFixed(2)} (${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%)`);
    
    // Update price history
    if (isInitialized) {
      priceHistory[priceHistory.length - 1] = currentPrice;
      priceHistory.push(currentPrice);
      if (priceHistory.length > 300) {
        priceHistory.shift();
      }
    } else {
      priceHistory.push(currentPrice);
      if (priceHistory.length < 50) {
        console.log(`📊 Raccolta dati... ${priceHistory.length}/50`);
        return;
      }
    }
    
    // Get Fear & Greed
    const fearGreedValue = await getFearGreed();
    if (fearGreedValue) {
      console.log(`😨 Fear & Greed: ${fearGreedValue}`);
    }
    
    // Calculate indicators
    const rsi = calculateRSI(priceHistory);
    const bollinger = calculateBollinger(priceHistory);
    const sma50 = calculateSMA(priceHistory, Math.min(50, priceHistory.length));
    const sma200 = calculateSMA(priceHistory, Math.min(200, priceHistory.length));
    const recentHigh = Math.max(...priceHistory);
    const recentLow = Math.min(...priceHistory.slice(-90));
    const drawdown = ((currentPrice - recentHigh) / recentHigh) * 100;
    
    console.log(`📈 RSI: ${rsi.toFixed(1)}, DD: ${drawdown.toFixed(1)}%, Hist: ${priceHistory.length}`);
    
    // BUY SCORE
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
      buyReasons.push('Sotto banda Bollinger inferiore');
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
      buyReasons.push(`Supporto SMA200 ($${sma200.toFixed(0)} / €${convertToEUR(sma200).toFixed(0)})`);
    }
    
    if (Math.abs(currentPrice - recentLow) / recentLow < 0.03) {
      buyScore += 10;
      buyReasons.push(`Vicino minimi recenti ($${recentLow.toFixed(0)} / €${convertToEUR(recentLow).toFixed(0)})`);
    }
    
    if (drawdown <= -60) {
      buyScore += 10;
      buyReasons.push(`Drawdown severo (${drawdown.toFixed(1)}%)`);
    } else if (drawdown <= -40) {
      buyScore += 5;
      buyReasons.push(`Drawdown significativo (${drawdown.toFixed(1)}%)`);
    }
    
    buyScore = Math.max(0, Math.min(100, buyScore));
    
    // SELL SCORE
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
      sellReasons.push('Sopra banda Bollinger superiore');
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
    
    if (sma50 && sma200 && currentPrice > sma50 && sma50 > sma200 && drawdown >= -10) {
      sellScore += 15;
      sellReasons.push('Vicino massimi in uptrend');
    }
    
    if (drawdown >= -5) {
      sellScore += 10;
      sellReasons.push(`Molto vicino ai massimi (${drawdown.toFixed(1)}%)`);
    }
    
    sellScore = Math.max(0, Math.min(100, sellScore));
    
    // ACTION DETERMINATION
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
    
    // Trading plan (in USD and EUR)
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
    const significantChange = Math.abs(buyScore - lastBuyScore) >= 10 || Math.abs(sellScore - lastSellScore) >= 10;
    const actionChanged = action !== lastAction && action !== 'HOLD';
    const thresholdMet = buyScore >= BUY_THRESHOLD || sellScore >= SELL_THRESHOLD;
    const strongSignal = action === 'BUY_STRONG' || action === 'SELL_STRONG';
    
    const shouldNotify = (
      (actionChanged || thresholdMet || (ONLY_STRONG_SIGNALS && strongSignal)) &&
      significantChange
    );
    
    if (shouldNotify) {
      await sendAlert({
        action, actionIcon, actionText, confidence, currentPrice, currentPriceEUR, priceChangePct,
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

// ==================== ALERT SYSTEM ====================

async function sendAlert(data) {
  try {
    const {
      actionIcon, actionText, confidence, currentPrice, currentPriceEUR, priceChangePct,
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
• $${currentPrice.toFixed(2)} USD
• €${currentPriceEUR.toFixed(2)} EUR
• 24h: ${changeSymbol} ${changeSign}${priceChangePct.toFixed(2)}%

📈 <b>SCORES</b>
• Buy: ${buyScore}/100
• Sell: ${sellScore}/100
`;

    if (action.startsWith('BUY')) {
      message += `
🎯 <b>PIANO TRADING</b>
• Entry: $${entryLow.toFixed(0)}-${entryHigh.toFixed(0)}
  (€${convertToEUR(entryLow).toFixed(0)}-${convertToEUR(entryHigh).toFixed(0)})
• Posizione: ${positionSize.toFixed(0)}% portafoglio
• Stop Loss: $${stopLossPrice.toFixed(0)} / €${convertToEUR(stopLossPrice).toFixed(0)}
  (${stopLossPct.toFixed(1)}%)
• TP1: $${tp1Price.toFixed(0)} / €${convertToEUR(tp1Price).toFixed(0)}
  (+${tp1Pct.toFixed(1)}%)
• TP2: $${tp2Price.toFixed(0)} / €${convertToEUR(tp2Price).toFixed(0)}
  (+${tp2Pct.toFixed(1)}%)

💡 <b>PERCHÉ ORA</b>
`;
      buyReasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
      
    } else if (action.startsWith('SELL')) {
      message += `
🎯 <b>AZIONE SUGGERITA</b>
• Vendi: ${positionSize.toFixed(0)}% posizione
• Stop Loss: $${stopLossPrice.toFixed(0)} / €${convertToEUR(stopLossPrice).toFixed(0)}

💡 <b>PERCHÉ ORA</b>
`;
      sellReasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
    }
    
    message += `
📊 <b>INDICATORI</b>
• RSI(14): ${rsi.toFixed(1)}
• Fear & Greed: ${fearGreedValue || 'N/A'}
• Drawdown: ${drawdown.toFixed(1)}%

⏰ ${new Date().toLocaleString('it-IT')}
`;

    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Alert inviato: ${actionText}`);
    
  } catch (error) {
    console.error('❌ Errore alert:', error.message);
  }
}

// ==================== BOT COMMANDS ====================

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `
🤖 <b>Bitcoin Timing Bot</b>

✅ Dati storici: ${isInitialized ? 'Importati' : 'In raccolta'}
💱 Supporto: USD + EUR
⚙️ Check ogni ${CHECK_INTERVAL} min
⚡ Profilo: ${RISK_PROFILE}
📊 Prezzi: ${priceHistory.length}

📋 <b>Comandi:</b>
/status - Analisi immediata
/info - Stato sistema
/pause - Pausa
/resume - Riprendi
`, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(msg.chat.id, '🔍 Analisi in corso...');
  await analyzeMarket();
});

bot.onText(/\/info/, async (msg) => {
  const priceData = await getCurrentPrice();
  const currentEUR = priceData ? convertToEUR(priceData.price) : 0;
  
  bot.sendMessage(msg.chat.id, `
📊 <b>Stato Sistema</b>

💰 <b>Prezzo Attuale</b>
• USD: $${priceData ? priceData.price.toFixed(2) : 'N/A'}
• EUR: €${currentEUR.toFixed(2)}
• Cambio: ${eurUsdRate.toFixed(4)}

📈 <b>Sistema</b>
• Prezzi storici: ${priceHistory.length}
• Dati importati: ${isInitialized ? '✅' : '❌'}
• Monitoraggio: ${isMonitoring ? '🟢' : '🔴'}
• Profilo: ${RISK_PROFILE}
• Soglie: Buy=${BUY_THRESHOLD}, Sell=${SELL_THRESHOLD}

📊 <b>Ultimi Scores</b>
• Buy: ${lastBuyScore}
• Sell: ${lastSellScore}
• Azione: ${lastAction}
`, { parse_mode: 'HTML' });
});

bot.onText(/\/pause/, (msg) => {
  isMonitoring = false;
  bot.sendMessage(msg.chat.id, '⏸️ PAUSA');
});

bot.onText(/\/resume/, (msg) => {
  isMonitoring = true;
  bot.sendMessage(msg.chat.id, '▶️ ATTIVO');
});

// ==================== SCHEDULER ====================

const cronExpression = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpression, async () => {
  if (isMonitoring) {
    await analyzeMarket();
  }
});

// ==================== INITIALIZATION ====================

async function initialize() {
  console.log('🚀 Inizializzazione...');
  
  // Get exchange rate
  await getExchangeRate();
  
  // Import historical data
  const imported = await importHistoricalData();
  
  if (imported) {
    console.log('✅ Dati storici pronti!');
  } else {
    console.log('⚠️ Uso raccolta manuale.');
  }
  
  // Send startup message
  setTimeout(async () => {
    try {
      await bot.sendMessage(CHAT_ID, `
🚀 <b>Bot Avviato!</b>

${imported ? '✅ Dati storici: ' + priceHistory.length + ' prezzi' : '📊 Modalità raccolta dati'}
💱 Supporto: USD + EUR
${imported ? '🎯 Analisi accurata da subito!' : '⏳ Completa dopo 50 check'}

📊 Check ogni ${CHECK_INTERVAL} min
⚡ ${RISK_PROFILE}

/info per stato
`, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Msg iniziale:', err.message);
    }
    
    if (imported) {
      console.log('🔍 Prima analisi...');
      await analyzeMarket();
    }
  }, 3000);
}

// ==================== ERROR HANDLING ====================

process.on('unhandledRejection', (err) => {
  console.error('Rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Exception:', err.message);
});

// ==================== START ====================

console.log('✅ Bot ready - Dual currency USD/EUR');
initialize();
