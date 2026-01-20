#!/usr/bin/env node
/**
 * TEST DISCOVERY & SAFETY CHECKS
 * 
 * Tests polling and safety checks without executing trades.
 * 
 * Usage:
 *   npx ts-node src/cli/test-discovery.ts
 */

import { TokenDiscovery, createDiscoveryEngine, DISCOVERY_CONFIG } from '../discovery/token-discovery.js';
import { CandidateQueue } from '../discovery/candidate-queue.js';
import { quickPreCheck, runPreTradeChecklist } from '../checkers/pre-trade-checklist.js';
import { connectPumpPortal, isConnectedToPumpPortal } from '../api/pump-portal.js';
import { fetchPumpFunToken } from '../api/pump-fun.js';
import logger from '../utils/logger.js';

// Test configuration
const TEST_CONFIG = {
  // How long to run discovery (ms)
  runDurationMs: 60000, // 1 minute
  
  // Max candidates to analyze
  maxCandidatesToAnalyze: 5,
  
  // Show detailed checklist results
  verbose: true,
};

async function main(): Promise<void> {
  logger.header('DISCOVERY & SAFETY CHECK TEST');
  logger.info('This will poll for tokens and run safety checks WITHOUT trading\n');
  
  // Show config
  logger.box('Discovery Config', [
    `Poll interval: ${DISCOVERY_CONFIG.pollIntervalMs / 1000}s`,
    `Age range: ${DISCOVERY_CONFIG.minAgeMinutes}-${DISCOVERY_CONFIG.maxAgeMinutes} min`,
    `Progress range: ${DISCOVERY_CONFIG.minProgress}-${DISCOVERY_CONFIG.maxProgress}%`,
    `Market cap: $${DISCOVERY_CONFIG.minMarketCap}-$${DISCOVERY_CONFIG.maxMarketCap}`,
    `Min trades: ${DISCOVERY_CONFIG.minTradeCount}`,
  ]);
  
  // Connect to PumpPortal
  logger.info('Connecting to PumpPortal...');
  try {
    if (!isConnectedToPumpPortal()) {
      await connectPumpPortal();
    }
    logger.success('PumpPortal connected\n');
  } catch (error) {
    logger.error('Failed to connect to PumpPortal:', error);
    process.exit(1);
  }
  
  // Create discovery components
  const queue = new CandidateQueue(50, 15);
  const discovery = createDiscoveryEngine(queue);
  
  // Track analyzed candidates
  let candidatesAnalyzed = 0;
  const results: Array<{
    symbol: string;
    mint: string;
    quickCheck: boolean;
    fullCheck: boolean;
    reason: string;
  }> = [];
  
  // Start discovery
  logger.info('Starting discovery...');
  logger.info('Press Ctrl+C to stop\n');
  await discovery.start();
  
  // Analysis loop
  const startTime = Date.now();
  
  while (Date.now() - startTime < TEST_CONFIG.runDurationMs) {
    // Get next candidate
    const candidate = queue.getNext();
    
    if (candidate && candidatesAnalyzed < TEST_CONFIG.maxCandidatesToAnalyze) {
      candidatesAnalyzed++;
      
      logger.divider();
      logger.info(`\nAnalyzing candidate ${candidatesAnalyzed}/${TEST_CONFIG.maxCandidatesToAnalyze}`);
      logger.info(`Token: ${candidate.symbol} (${candidate.mint.slice(0, 8)}...)`);
      logger.info(`Age: ${candidate.ageMinutes?.toFixed(1) || '?'} min`);
      logger.info(`Progress: ${candidate.bondingCurveProgress?.toFixed(1) || '?'}%`);
      logger.info(`Market cap: $${candidate.marketCapUsd?.toFixed(0) || '?'}`);
      
      // Run quick pre-check
      logger.info('\n[1] Running quick pre-check...');
      const quickResult = await quickPreCheck(candidate.mint);
      
      if (quickResult.shouldAnalyze) {
        logger.success(`Quick check PASSED`);
        
        // Run full checklist
        logger.info('\n[2] Running full pre-trade checklist...');
        const fullResult = await runPreTradeChecklist(candidate.mint);
        
        if (fullResult.passed) {
          logger.success(`Full checklist PASSED (${fullResult.passedChecks.length} checks)`);
          results.push({
            symbol: candidate.symbol,
            mint: candidate.mint,
            quickCheck: true,
            fullCheck: true,
            reason: 'All checks passed',
          });
        } else {
          logger.warn(`Full checklist FAILED`);
          logger.warn(`Failed checks: ${fullResult.failedChecks.join(', ')}`);
          
          if (TEST_CONFIG.verbose && fullResult.details.pumpFunSafety?.warnings?.length) {
            logger.info('Warnings:');
            fullResult.details.pumpFunSafety.warnings.forEach((w: string) => logger.info(`  - ${w}`));
          }
          
          results.push({
            symbol: candidate.symbol,
            mint: candidate.mint,
            quickCheck: true,
            fullCheck: false,
            reason: fullResult.failedChecks.join(', '),
          });
        }
      } else {
        logger.warn(`Quick check FAILED: ${quickResult.reason}`);
        results.push({
          symbol: candidate.symbol,
          mint: candidate.mint,
          quickCheck: false,
          fullCheck: false,
          reason: quickResult.reason || 'Quick check failed',
        });
      }
      
      // Mark as processed to not re-analyze
      queue.markProcessed(candidate.mint);
    }
    
    // Check if we've analyzed enough
    if (candidatesAnalyzed >= TEST_CONFIG.maxCandidatesToAnalyze) {
      logger.info('\nReached max candidates to analyze');
      break;
    }
    
    // Show queue status periodically
    const stats = queue.getStats();
    const discoveryStats = discovery.getStats();
    
    if (stats.queueSize > 0 && candidatesAnalyzed === 0) {
      logger.debug(`Queue: ${stats.queueSize} | Polls: ${discoveryStats.pollCount}`);
    }
    
    await sleep(500);
  }
  
  // Stop discovery
  discovery.stop();
  
  // Summary
  logger.divider();
  logger.header('TEST SUMMARY');
  
  const passed = results.filter(r => r.fullCheck).length;
  const failed = results.filter(r => !r.fullCheck).length;
  
  logger.box('Results', [
    `Candidates analyzed: ${candidatesAnalyzed}`,
    `Passed full checklist: ${passed}`,
    `Failed: ${failed}`,
    `Discovery polls: ${discovery.getStats().pollCount}`,
    `Total candidates found: ${discovery.getStats().candidatesFound}`,
  ]);
  
  if (results.length > 0) {
    logger.info('\nDetailed Results:');
    results.forEach((r, i) => {
      const icon = r.fullCheck ? '✅' : '❌';
      logger.info(`  ${i + 1}. ${icon} ${r.symbol} - ${r.reason}`);
    });
  }
  
  logger.info('\nTest complete!');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  logger.info('\nStopping test...');
  process.exit(0);
});

// Run
main().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});
