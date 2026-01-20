/**
 * CLI: Test Setup
 * Verifies all API connections and configuration
 * 
 * Usage: npm run test:setup
 */

import 'dotenv/config';
import { ENV } from '../config/index.js';
import logger from '../utils/logger.js';

async function testSetup() {
  console.log(`
╔═══════════════════════════════════════════╗
║         AXIOM BOT - SETUP TEST            ║
╚═══════════════════════════════════════════╝
  `);
  
  let allPassed = true;
  const results: { test: string; passed: boolean; detail: string }[] = [];
  
  // 1. Test RPC Connection
  logger.info('Testing Solana RPC connection...');
  try {
    const response = await fetch(ENV.SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getHealth',
      }),
    });
    
    if (response.ok) {
      const data = await response.json() as { result?: string };
      results.push({ 
        test: 'Solana RPC', 
        passed: true, 
        detail: data.result === 'ok' ? 'Healthy' : 'Connected' 
      });
    } else {
      results.push({ test: 'Solana RPC', passed: false, detail: `HTTP ${response.status}` });
      allPassed = false;
    }
  } catch (error) {
    results.push({ test: 'Solana RPC', passed: false, detail: 'Connection failed' });
    allPassed = false;
  }
  
  // 2. Test Birdeye API
  logger.info('Testing Birdeye API...');
  if (ENV.BIRDEYE_API_KEY) {
    try {
      const response = await fetch(
        'https://public-api.birdeye.so/defi/price?address=So11111111111111111111111111111111111111112',
        {
          headers: {
            'X-API-KEY': ENV.BIRDEYE_API_KEY,
            'Accept': 'application/json',
          },
        }
      );
      
      if (response.ok) {
        const data = await response.json() as { data?: { value?: number } };
        const solPrice = data.data?.value?.toFixed(2) || 'N/A';
        results.push({ test: 'Birdeye API', passed: true, detail: `SOL = $${solPrice}` });
      } else {
        results.push({ test: 'Birdeye API', passed: false, detail: `HTTP ${response.status}` });
        allPassed = false;
      }
    } catch (error) {
      results.push({ test: 'Birdeye API', passed: false, detail: 'Connection failed' });
      allPassed = false;
    }
  } else {
    results.push({ test: 'Birdeye API', passed: false, detail: 'API key not set' });
    allPassed = false;
  }
  
  // 3. Test Helius API (optional)
  logger.info('Testing Helius API...');
  if (ENV.HELIUS_API_KEY) {
    try {
      const response = await fetch(
        `https://api.helius.xyz/v0/addresses/So11111111111111111111111111111111111111112/balances?api-key=${ENV.HELIUS_API_KEY}`
      );
      
      if (response.ok) {
        results.push({ test: 'Helius API', passed: true, detail: 'Connected' });
      } else {
        results.push({ test: 'Helius API', passed: false, detail: `HTTP ${response.status}` });
      }
    } catch (error) {
      results.push({ test: 'Helius API', passed: false, detail: 'Connection failed' });
    }
  } else {
    results.push({ test: 'Helius API', passed: true, detail: 'Not configured (optional)' });
  }
  
  // 4. Test Pump.fun API (optional - no official API, Cloudflare protected)
  logger.info('Testing Pump.fun API...');
  try {
    const response = await fetch('https://frontend-api.pump.fun/coins?limit=1', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://pump.fun/',
        'Origin': 'https://pump.fun',
      },
    });
    
    if (response.ok) {
      const data = await response.json();
      results.push({ test: 'Pump.fun API', passed: true, detail: 'Connected' });
    } else {
      // Non-critical - Pump.fun doesn't have official API, Cloudflare blocks direct access
      results.push({ test: 'Pump.fun API', passed: true, detail: `HTTP ${response.status} (expected - no official API)` });
    }
  } catch (error) {
    // Non-critical - this is expected since there's no official API and Cloudflare blocks it
    results.push({ test: 'Pump.fun API', passed: true, detail: 'Unreachable (expected - Cloudflare protected)' });
  }
  
  // 5. Test Jupiter API (optional for paper trading)
  logger.info('Testing Jupiter API...');
  const paperMode = process.env.PAPER_TRADE === 'true';
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    // Try price API first (simpler endpoint)
    const response = await fetch(
      'https://price.jup.ag/v4/price?ids=SOL',
      {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      }
    );
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json() as { data?: { SOL?: { price?: number } } };
      const solPrice = data.data?.SOL?.price?.toFixed(2) || 'N/A';
      results.push({ test: 'Jupiter API', passed: true, detail: `Connected (SOL = $${solPrice})` });
    } else {
      // Fallback: try quote API
      const quoteResponse = await fetch(
        'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000',
        {
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
          },
        }
      );
      
      if (quoteResponse.ok) {
        results.push({ test: 'Jupiter API', passed: true, detail: 'Connected (quote API)' });
      } else {
        // Non-critical in paper trading mode
        if (paperMode) {
          results.push({ test: 'Jupiter API', passed: true, detail: `HTTP ${quoteResponse.status} (optional for paper trading)` });
        } else {
          const errorText = await quoteResponse.text().catch(() => '');
          results.push({ test: 'Jupiter API', passed: false, detail: `HTTP ${quoteResponse.status}${errorText ? ': ' + errorText.substring(0, 50) : ''}` });
          allPassed = false;
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    // Non-critical in paper trading mode
    if (paperMode) {
      results.push({ test: 'Jupiter API', passed: true, detail: 'Unreachable (optional for paper trading)' });
    } else {
      if (errorMsg.includes('aborted') || errorMsg.includes('timeout')) {
        results.push({ test: 'Jupiter API', passed: false, detail: 'Timeout - required for live trading' });
      } else if (errorMsg.includes('fetch')) {
        results.push({ test: 'Jupiter API', passed: false, detail: 'Network error - required for live trading' });
      } else {
        results.push({ test: 'Jupiter API', passed: false, detail: `Error: ${errorMsg.substring(0, 60)}` });
      }
      allPassed = false;
    }
  }
  
  // 6. Check Wallet Key
  logger.info('Checking wallet configuration...');
  if (ENV.WALLET_PRIVATE_KEY && ENV.WALLET_PRIVATE_KEY !== 'your_private_key_here') {
    results.push({ test: 'Wallet Key', passed: true, detail: 'Configured' });
  } else {
    results.push({ test: 'Wallet Key', passed: true, detail: 'Not set (paper trading only)' });
  }
  
  // 7. Check Paper Trading Mode
  results.push({ 
    test: 'Paper Trading', 
    passed: true, 
    detail: paperMode ? 'ENABLED ✓' : 'Disabled (set PAPER_TRADE=true to enable)' 
  });
  
  // Display results
  logger.header('TEST RESULTS');
  
  for (const result of results) {
    logger.checklist(result.test, result.passed, result.detail);
  }
  
  logger.divider();
  
  if (allPassed) {
    logger.success('\n✅ All critical tests passed! Bot is ready.');
    logger.info('\nNext steps:');
    logger.info('  1. Run paper trading: npm run paper');
    logger.info('  2. Check a token: npm run check <mint_address>');
    logger.info('  3. View paper stats: npm run paper:stats');
  } else {
    logger.error('\n❌ Some tests failed. Please check your .env configuration.');
  }
  
  process.exit(allPassed ? 0 : 1);
}

testSetup().catch(console.error);
