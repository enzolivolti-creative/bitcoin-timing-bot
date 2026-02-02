// Railway-compatible version - ENV vars already available
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

// Configurazione - Railway provides ENV vars directly
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 15;
const BUY_THRESHOLD = parseInt(process.env.BUY_THRESHOLD) || 70;
const SELL_THRESHOLD = parseInt(process.env.SELL_THRESHOLD) || 70;
const RISK_PROFILE = process.env.RISK_PROFILE || 'Moderate';
const ONLY_STRONG_SIGNALS = process.env.ONLY_STRONG_SIGNALS === 'true';

// Verifica configurazione
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN non trovato nelle variabili d\'ambiente!');
  console.error('Aggiungi la variabile su Railway: Variables → New Variable');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('❌ TELEGRAM_CHAT_ID non trovato nelle variabili d\'ambiente!');
  console.error('Aggiungi la variabile su Railway: Variables → New Variable');
  process.exit(1);
}

// Inizializza bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// State management
let lastBuyScore = 0;
let lastSellScore = 0;
let lastAction = 'HOLD';
let isMonitoring = true;
let lastNewsCheck = null;
let cachedNews = null;

console.log('🤖 Bitcoin Timing Bot avviato su Railway!');
console.log(`📊 Check ogni ${CHECK_INTERVAL} minuti`);
console.log(`🎯 Soglie: Buy=${BUY_THRESHOLD}, Sell=${SELL_THRESHOLD}`);
console.log(`⚡ Profilo: ${RISK_PROFILE}`);

// ==================== NEWS INTELLIGENCE ====================

async function fetchBitcoinNews() {
  try {
    console.log('📰 Recupero news Bitcoin...');
    let articles = [];
    
    // CryptoPanic API (gratuita)
    try {
      const cryptoPanicUrl = 'https://cryptopanic.com/api/v1/posts/?auth_token=free&currencies=BTC&kind=news';
      const response = await axios.get(cryptoPanicUrl);
      
      if (response.data && response.data.results) {
        articles = response.data.results.slice(0, 10).map(item => ({
          title: item.title,
          url: item.url,
          publishedAt: item.published_at,
          sentiment: item.votes ? (item.votes.positive - item.votes.negative) : 0,
          source: item.source?.title || 'CryptoPanic'
        }));
      }
    } catch (e) {
      console.warn('CryptoPanic non disponibile:', e.message);
    }
    
    return articles;
    
  } catch (error) {
    console.error('❌ Errore recupero news:', error.message);
    return [];
  }
}

async function analyzeNewsImpact(articles, currentPrice, priceChangePct) {
  try {
    if (!articles || articles.length === 0) {
      return {
        impact: 'NEUTRAL',
        summary: 'Nessuna news significativa rilevata',
        sentiment: 0,
        keyEvents: []
      };
    }
    
    const positiveKeywords = [
      'surge', 'rally', 'soar', 'pump', 'bullish', 'adoption', 'approved', 'etf',
      'institutional', 'buying', 'accumulation', 'breakout', 'high', 'record',
      'partnership', 'integration', 'accepts', 'mainstream', 'positive', 'growth'
    ];
    
    const negativeKeywords = [
      'crash', 'plunge', 'dump', 'bearish', 'ban', 'regulation', 'crackdown',
      'scam', 'hack', 'fear', 'sells', 'drops', 'falls', 'concern', 'risk',
      'warning', 'investigation', 'fraud', 'collapse', 'down', 'decline'
    ];
    
    const criticalKeywords = [
      'sec', 'lawsuit', 'banned', 'emergency', 'crisis', 'hack', 'exploit',
      'government', 'central bank', 'federal reserve', 'regulation', 'crackdown'
    ];
    
    let sentimentScore = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    let criticalCount = 0;
    const keyEvents = [];
    
    articles.forEach(article => {
      const title = (article.title || '').toLowerCase();
      
      const hasPositive = positiveKeywords.some(kw => title.includes(kw));
      const hasNegative = negativeKeywords.some(kw => title.includes(kw));
      const hasCritical = criticalKeywords.some(kw => title.includes(kw));
      
      if (hasPositive) {
        positiveCount++;
        sentimentScore += 1;
      }
      if (hasNegative) {
        negativeCount++;
        sentimentScore -= 1;
      }
      if (hasCritical) {
        criticalCount++;
        sentimentScore -= 2;
        keyEvents.push({
          title: article.title,
          type: 'CRITICAL',
          source: article.source
        });
      }
      
      if ((hasPositive || hasNegative || hasCritical) && keyEvents.length < 3) {
        if (!keyEvents.find(e => e.title === article.title)) {
          keyEvents.push({
            title: article.title,
            type: hasCritical ? 'CRITICAL' : hasNegative ? 'NEGATIVE' : 'POSITIVE',
            source: article.source
          });
        }
      }
    });
    
    let impact = 'NEUTRAL';
    let summary = '';
    
    if (criticalCount > 0) {
      impact = 'CRITICAL_NEGATIVE';
      summary = `⚠️ EVENTI CRITICI: ${criticalCount} news negative importanti rilevate`;
    } else if (sentimentScore >= 3) {
      impact = 'POSITIVE';
      summary = `✅ Sentiment positivo: ${positiveCount} news positive vs ${negativeCount} negative`;
    } else if (sentimentScore <= -3) {
      impact = 'NEGATIVE';
      summary = `🔴 Sentiment negativo: ${negativeCount} news negative vs ${positiveCount} positive`;
    } else {
      impact = 'NEUTRAL';
      summary = `⚖️ Sentiment misto: ${positiveCount} positive, ${negativeCount} negative`;
    }
    
    if (Math.abs(priceChangePct) > 5) {
      if (priceChangePct > 5 && sentimentScore > 0) {
        summary += ' - movimento coerente con news positive';
      } else if (priceChangePct < -5 && sentimentScore < 0) {
        summary += ' - movimento coerente con news negative';
      } else if (priceChangePct < -5 && sentimentScore > 0) {
        summary += ' ⚠️ DIVERGENZA: news positive ma prezzo scende (possibile opportunità)';
        impact = 'DIVERGENCE_POSITIVE';
      } else if (priceChangePct > 5 && sentimentScore < 0) {
        summary += ' ⚠️ DIVERGENZA: news negative ma prezzo sale (cautela)';
        impact = 'DIVERGENCE_NEGATIVE';
      }
    }
    
    return {
      impact,
      summary,
      sentiment: sentimentScore,
      keyEvents: keyEvents.slice(0, 3),
      positiveCount,
      negativeCount,
      criticalCount
    };
    
  } catch (error) {
    console.error('Errore analisi news:', error.message);
    return {
      impact: 'NEUTRAL',
      summary: 'Errore analisi news',
      sentiment: 0,
      keyEvents: []
    };
  }
}

// ==================== ANALISI TECNICA ====================

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
    console.log(`🔍 [${new Date().toLocaleTimeString('it-IT')}] Analisi in corso...`);
    
    const tickerRes = await axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
    const currentPrice = parseFloat(tickerRes.data.lastPrice);
    const priceChangePct = parseFloat(tickerRes.data.priceChangePercent);
    
    const klinesRes = await axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=200');
    const historicalPrices = klinesRes.data.map(k => parseFloat(k[4]));
    historicalPrices[historicalPrices.length - 1] = currentPrice;
    
    // NEWS (cache 30 min)
    let newsAnalysis = null;
    const now = Date.now();
    
    if (!lastNewsCheck || (now - lastNewsCheck) > 30 * 60 * 1000) {
      console.log('📰 Aggiornamento news...');
      const articles = await fetchBitcoinNews();
      newsAnalysis = await analyzeNewsImpact(articles, currentPrice, priceChangePct);
      cachedNews = newsAnalysis;
      lastNewsCheck = now;
    } else {
      console.log('📰 Uso cache news');
      newsAnalysis = cachedNews;
    }
    
    let fearGreedValue = null;
    try {
      const fgRes = await axios.get('https://api.alternative.me/fng/?limit=1');
      fearGreedValue = parseInt(fgRes.data.data[0].value);
    } catch (e) {
      console.warn('Fear & Greed non disponibile');
    }
    
    const rsi = calculateRSI(historicalPrices);
    const bollinger = calculateBollinger(historicalPrices);
    const sma200 = calculateSMA(historicalPrices, 200);
    const recentHigh = Math.max(...historicalPrices);
    const drawdown = ((currentPrice - recentHigh) / recentHigh) * 100;
    
    // Buy Score
    let buyScore = 0;
    const buyReasons = [];
    
    if (rsi < 25) {
      buyScore += 30;
      buyReasons.push(`RSI fortemente ipervenduto (${rsi.toFixed(1)})`);
    } else if (rsi < 30) {
      buyScore += 20;
      buyReasons.push(`RSI in ipervenduto (${rsi.toFixed(1)})`);
    } else if (rsi < 40) {
      buyScore += 5;
    }
    
    if (bollinger.position === 'below_lower') {
      buyScore += 20;
      buyReasons.push('Prezzo sotto banda Bollinger inferiore');
    } else if (bollinger.current <= bollinger.lower * 1.01) {
      buyScore += 10;
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue < 20) {
        buyScore += 25;
        buyReasons.push(`Fear & Greed paura estrema (${fearGreedValue})`);
      } else if (fearGreedValue < 30) {
        buyScore += 15;
        buyReasons.push(`Fear & Greed in paura (${fearGreedValue})`);
      } else if (fearGreedValue < 50) {
        buyScore += 5;
      }
    }
    
    if (sma200 && Math.abs(currentPrice - sma200) / sma200 < 0.02) {
      buyScore += 10;
      buyReasons.push(`Supporto SMA200 a $${sma200.toFixed(0)}`);
    }
    
    const minPrice90d = Math.min(...historicalPrices.slice(-90));
    if (Math.abs(currentPrice - minPrice90d) / minPrice90d < 0.03) {
      buyScore += 5;
    }
    
    if (drawdown <= -60) {
      buyScore += 10;
      buyReasons.push(`Drawdown severo (${drawdown.toFixed(1)}%)`);
    } else if (drawdown <= -40) {
      buyScore += 5;
    }
    
    // NEWS adjustment
    if (newsAnalysis) {
      if (newsAnalysis.impact === 'POSITIVE') {
        buyScore += 10;
        buyReasons.push(`📰 ${newsAnalysis.summary}`);
      } else if (newsAnalysis.impact === 'CRITICAL_NEGATIVE') {
        buyScore -= 20;
        buyReasons.push(`⚠️ ${newsAnalysis.summary}`);
      } else if (newsAnalysis.impact === 'DIVERGENCE_POSITIVE') {
        buyScore += 15;
        buyReasons.push(`🎯 ${newsAnalysis.summary}`);
      }
    }
    
    buyScore = Math.max(0, Math.min(100, buyScore));
    
    // Sell Score
    let sellScore = 0;
    const sellReasons = [];
    
    if (rsi > 80) {
      sellScore += 30;
      sellReasons.push(`RSI fortemente ipercomprato (${rsi.toFixed(1)})`);
    } else if (rsi > 75) {
      sellScore += 20;
      sellReasons.push(`RSI ipercomprato (${rsi.toFixed(1)})`);
    } else if (rsi > 70) {
      sellScore += 10;
    }
    
    if (bollinger.position === 'above_upper') {
      sellScore += 20;
      sellReasons.push('Prezzo sopra banda Bollinger superiore');
    } else if (bollinger.current >= bollinger.upper * 0.99) {
      sellScore += 10;
    }
    
    if (fearGreedValue !== null) {
      if (fearGreedValue > 85) {
        sellScore += 25;
        sellReasons.push(`Fear & Greed avidità estrema (${fearGreedValue})`);
      } else if (fearGreedValue > 75) {
        sellScore += 15;
        sellReasons.push(`Fear & Greed in avidità (${fearGreedValue})`);
      } else if (fearGreedValue > 60) {
        sellScore += 5;
      }
    }
    
    const sma50 = calculateSMA(historicalPrices, 50);
    if (sma50 && sma200 && currentPrice > sma50 && sma50 > sma200) {
      if (drawdown >= -10) {
        sellScore += 15;
        sellReasons.push('Prezzo vicino ai massimi');
      } else {
        sellScore += 10;
      }
    }
    
    if (newsAnalysis && (newsAnalysis.impact === 'NEGATIVE' || newsAnalysis.impact === 'CRITICAL_NEGATIVE')) {
      sellScore += 15;
      sellReasons.push(`📰 ${newsAnalysis.summary}`);
    }
    
    sellScore = Math.max(0, Math.min(100, sellScore));
    
    // Determina azione
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
      actionText = 'VENDI / TAKE PROFIT';
      confidence = Math.min(90, 55 + (sellScore - thresholds.sellStrong));
    } else if (sellScore >= thresholds.sellWeak && buyScore < 50) {
      action = 'SELL_WEAK';
      actionIcon = '🟠';
      actionText = 'PRESA PROFITTO PARZIALE';
      confidence = Math.min(70, 50 + (sellScore - thresholds.sellWeak));
    } else if (buyScore >= 50 && sellScore >= 50) {
      action = 'CONFLICT';
      actionIcon = '⚠️';
      actionText = 'CONFLITTO - DCA CAUTO';
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
    
    console.log(`📊 Buy: ${buyScore}, Sell: ${sellScore}, Azione: ${action}`);
    
    const shouldNotify = checkIfShouldNotify(action, buyScore, sellScore, confidence);
    
    if (shouldNotify) {
      await sendAlert({
        action, actionIcon, actionText, confidence, currentPrice, priceChangePct,
        buyScore, sellScore, buyReasons, sellReasons,
        entryLow, entryHigh, stopLossPrice, stopLossPct,
        tp1Price, tp1Pct, tp2Price, tp2Pct, positionSize,
        rsi, fearGreedValue, drawdown, newsAnalysis
      });
    }
    
    lastBuyScore = buyScore;
    lastSellScore = sellScore;
    lastAction = action;
    
  } catch (error) {
    console.error('❌ Errore analisi:', error.message);
  }
}

function checkIfShouldNotify(action, buyScore, sellScore, confidence) {
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
      rsi, fearGreedValue, drawdown, action, newsAnalysis
    } = data;
    
    const changeSymbol = priceChangePct >= 0 ? '📈' : '📉';
    const changeSign = priceChangePct >= 0 ? '+' : '';
    
    let message = `
🔔 <b>BITCOIN TIMING ALERT</b>

${actionIcon} <b>${actionText}</b>
📊 Confidenza: <b>${confidence}%</b>

💰 <b>PREZZO</b>
• Attuale: $${currentPrice.toFixed(2)}
• 24h: ${changeSymbol} ${changeSign}${priceChangePct.toFixed(2)}%

📈 <b>SCORES</b>
• Buy Score: ${buyScore}/100
• Sell Score: ${sellScore}/100
`;

    if (newsAnalysis && newsAnalysis.impact !== 'NEUTRAL') {
      message += `
📰 <b>CONTESTO NEWS</b>
${newsAnalysis.summary}

`;
      
      if (newsAnalysis.keyEvents && newsAnalysis.keyEvents.length > 0) {
        message += `<b>Eventi Chiave:</b>\n`;
        newsAnalysis.keyEvents.forEach(event => {
          const emoji = event.type === 'CRITICAL' ? '🚨' : event.type === 'NEGATIVE' ? '🔴' : '🟢';
          message += `${emoji} ${event.title.substring(0, 60)}...\n`;
        });
        message += '\n';
      }
    }

    if (action.startsWith('BUY')) {
      message += `
🎯 <b>TRADING PLAN</b>
• Entry: $${entryLow.toFixed(0)} - $${entryHigh.toFixed(0)}
• Posizione: ${positionSize.toFixed(0)}% portafoglio
• Stop Loss: $${stopLossPrice.toFixed(0)} (${stopLossPct.toFixed(1)}%)
• TP1: $${tp1Price.toFixed(0)} (+${tp1Pct.toFixed(1)}%)
• TP2: $${tp2Price.toFixed(0)} (+${tp2Pct.toFixed(1)}%)

💡 <b>PERCHÉ ORA</b>
`;
      buyReasons.slice(0, 4).forEach(r => message += `• ${r}\n`);
      
    } else if (action.startsWith('SELL')) {
      message += `
🎯 <b>AZIONE</b>
• Vendi: ${positionSize.toFixed(0)}% posizione
• Stop Loss: $${stopLossPrice.toFixed(0)}

💡 <b>PERCHÉ ORA</b>
`;
      sellReasons.slice(0, 4).forEach(r => message += `• ${r}\n`);
    }
    
    message += `
📊 <b>INDICATORI</b>
• RSI: ${rsi.toFixed(1)}
• F&G: ${fearGreedValue || 'N/A'}
• DD: ${drawdown.toFixed(1)}%

⏰ ${new Date().toLocaleString('it-IT')}
`;

    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Alert inviato: ${actionText}`);
    
  } catch (error) {
    console.error('❌ Errore invio:', error.message);
  }
}

// ==================== COMANDI ====================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `
🤖 <b>Bitcoin Timing Bot ATTIVO</b>
📰 <b>CON NEWS INTELLIGENCE!</b>

⚙️ <b>Config:</b>
• Check ogni ${CHECK_INTERVAL} min
• Profilo: ${RISK_PROFILE}
• Soglie: Buy=${BUY_THRESHOLD}, Sell=${SELL_THRESHOLD}

📋 <b>Comandi:</b>
/status - Analisi ora
/news - Solo news
/pause - Pausa
/resume - Riprendi
/help - Guida
`, { parse_mode: 'HTML' });
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, '🔍 Analisi in corso...');
  await analyzeMarket();
});

bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await bot.sendMessage(chatId, '📰 Recupero news...');
    
    const articles = await fetchBitcoinNews();
    const tickerRes = await axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
    const priceChangePct = parseFloat(tickerRes.data.priceChangePercent);
    const currentPrice = parseFloat(tickerRes.data.lastPrice);
    
    const analysis = await analyzeNewsImpact(articles, currentPrice, priceChangePct);
    
    let msg = `
📰 <b>ANALISI NEWS</b>

${analysis.summary}

Sentiment: ${analysis.sentiment > 0 ? '+' : ''}${analysis.sentiment}
Positive: ${analysis.positiveCount}
Negative: ${analysis.negativeCount}
Critiche: ${analysis.criticalCount}
`;
    
    if (analysis.keyEvents && analysis.keyEvents.length > 0) {
      msg += `\n<b>Eventi:</b>\n`;
      analysis.keyEvents.forEach(e => {
        const emoji = e.type === 'CRITICAL' ? '🚨' : e.type === 'NEGATIVE' ? '🔴' : '🟢';
        msg += `\n${emoji} <b>${e.source}</b>\n${e.title}\n`;
      });
    }
    
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  } catch (e) {
    await bot.sendMessage(chatId, '❌ Errore news');
  }
});

bot.onText(/\/pause/, (msg) => {
  isMonitoring = false;
  bot.sendMessage(msg.chat.id, '⏸️ In PAUSA');
});

bot.onText(/\/resume/, (msg) => {
  isMonitoring = true;
  bot.sendMessage(msg.chat.id, '▶️ RIATTIVATO');
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `
📚 <b>Guida Bot</b>

Il bot monitora Bitcoin 24/7 con:
📊 Analisi tecnica
📰 News intelligence
🎯 Segnali automatici

/status - Analisi ora
/news - Solo news
/pause - Pausa
/resume - Riprendi
`, { parse_mode: 'HTML' });
});

// ==================== SCHEDULER ====================

const cronExpression = `*/${CHECK_INTERVAL} * * * *`;
cron.schedule(cronExpression, async () => {
  if (isMonitoring) {
    await analyzeMarket();
  }
});

setTimeout(() => {
  bot.sendMessage(CHAT_ID, `
🚀 <b>Bot Avviato!</b>

Monitoraggio Bitcoin 24/7
📊 Tecnica + 📰 News

Check ogni ${CHECK_INTERVAL} min
Profilo: ${RISK_PROFILE}

/help per comandi
`, { parse_mode: 'HTML' }).catch(err => {
    console.error('Errore invio messaggio iniziale:', err.message);
  });
  
  analyzeMarket();
}, 3000);

process.on('unhandledRejection', (error) => {
  console.error('❌ Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exception:', error);
});

console.log('✅ Bot pronto su Railway!');
