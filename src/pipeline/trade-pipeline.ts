/**
 * TRADE PIPELINE
 * 
 * Orchestrates the automated trading flow:
 * 1. Quick pre-filter (fast rejection)
 * 2. Full checklist (comprehensive safety checks)
 * 3. Trade execution via Metis
 * 4. Position creation and monitoring
 */

import { PumpPortalToken } from '../api/pump-portal.js';
import { fetchPumpFunToken } from '../api/pump-fun.js';
import { quickPreCheck, runPreTradeChecklist, ChecklistResult } from '../checkers/pre-trade-checklist.js';
import { 
  calculateTradeSize, 
  createPosition, 
  isTradingAllowed,
  getActivePositions,
  Position 
} from '../trading/position-manager.js';
import { executeBuy } from '../trading/executor.js';
import { 
  generateEntrySignal, 
  displayEntrySignal,
  waitForTranche2Confirmation 
} from '../trading/entry-logic.js';
import { fetchTokenInfo } from '../api/data-providers.js';
import { startTokenMonitoring } from '../monitoring/dev-wallet-monitor.js';
import { CandidateQueue } from '../discovery/candidate-queue.js';
import { CONFIG } from '../config/index.js';
import logger from '../utils/logger.js';

// Pipeline configuration
export const PIPELINE_CONFIG = {
  maxConcurrentAnalysis: 2,      // Don't overload APIs
  autoEnterOnPass: true,         // Enter automatically when checklist passes
  maxOpenPositions: 1,           // From POSITION_SIZING.MAX_OPEN_TRADES
  maxDailyTrades: 2,             // From DAILY_LIMITS.MAX_TRADES_PER_DAY
  tradeCooldownMs: 60000,        // 1 minute between trades
  enableTranche2: true,          // Enable second tranche execution
};

// Pipeline result
export interface PipelineResult {
  mint: string;
  symbol: string;
  entered: boolean;
  rejected: boolean;
  position?: Position;
  reason: string;
  checklistResult?: ChecklistResult;
}

// Processing state
interface ProcessingState {
  currentlyProcessing: Set<string>;
  lastTradeTime: number;
}

/**
 * Trade Pipeline Class
 */
export class TradePipeline {
  private queue: CandidateQueue;
  private state: ProcessingState;
  private onTradeEntered?: (result: PipelineResult) => void;
  private onTradeRejected?: (result: PipelineResult) => void;
  
  constructor(
    queue: CandidateQueue,
    callbacks?: {
      onTradeEntered?: (result: PipelineResult) => void;
      onTradeRejected?: (result: PipelineResult) => void;
    }
  ) {
    this.queue = queue;
    this.state = {
      currentlyProcessing: new Set(),
      lastTradeTime: 0,
    };
    this.onTradeEntered = callbacks?.onTradeEntered;
    this.onTradeRejected = callbacks?.onTradeRejected;
  }
  
  /**
   * Process a candidate token through the pipeline
   */
  async process(token: PumpPortalToken): Promise<PipelineResult> {
    const mint = token.mint;
    const symbol = token.symbol || 'UNKNOWN';
    
    // Prevent duplicate processing
    if (this.state.currentlyProcessing.has(mint)) {
      return {
        mint,
        symbol,
        entered: false,
        rejected: false,
        reason: 'Already being processed',
      };
    }
    
    // Check concurrent limit
    if (this.state.currentlyProcessing.size >= PIPELINE_CONFIG.maxConcurrentAnalysis) {
      return {
        mint,
        symbol,
        entered: false,
        rejected: false,
        reason: 'Concurrent analysis limit reached',
      };
    }
    
    this.state.currentlyProcessing.add(mint);
    
    try {
      logger.header(`PIPELINE: ${symbol}`);
      logger.info(`Analyzing ${mint.slice(0, 8)}...`);
      
      // STAGE 1: Check if we can trade at all
      const canTradeResult = await this.canTrade();
      if (!canTradeResult.allowed) {
        return this.reject(mint, symbol, canTradeResult.reason || 'Trading not allowed');
      }
      
      // STAGE 2: Quick pre-filter
      logger.info('[1/4] Quick pre-filter...');
      const quickCheck = await quickPreCheck(mint);
      if (!quickCheck.shouldAnalyze) {
        return this.reject(mint, symbol, quickCheck.reason || 'Failed quick pre-check');
      }
      logger.success('Quick pre-filter passed');
      
      // STAGE 3: Full pre-trade checklist
      logger.info('[2/4] Running full checklist...');
      const checklistResult = await runPreTradeChecklist(mint);
      
      if (!checklistResult.passed) {
        const failReason = checklistResult.failedChecks.join(', ');
        return this.reject(mint, symbol, failReason, checklistResult);
      }
      logger.success('Full checklist passed');
      
      // STAGE 4: Calculate trade size
      logger.info('[3/4] Calculating trade size...');
      const sizeResult = await calculateTradeSize();
      
      if (!sizeResult.allowed) {
        return this.reject(mint, symbol, sizeResult.reason || 'Trade size not allowed');
      }
      logger.info(`Trade size: ${sizeResult.size.toFixed(3)} SOL`);
      
      // STAGE 5: Execute entry
      logger.info('[4/4] Executing entry...');
      const entryResult = await this.executeEntry(mint, symbol, checklistResult, sizeResult.size);
      
      if (!entryResult.entered) {
        return this.reject(mint, symbol, entryResult.reason, checklistResult);
      }
      
      // Success!
      this.state.lastTradeTime = Date.now();
      this.queue.markProcessed(mint);
      
      const result: PipelineResult = {
        mint,
        symbol,
        entered: true,
        rejected: false,
        position: entryResult.position,
        reason: 'Trade entered successfully',
        checklistResult,
      };
      
      this.onTradeEntered?.(result);
      return result;
      
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Pipeline error: ${errMsg}`);
      return this.reject(mint, symbol, `Pipeline error: ${errMsg}`);
    } finally {
      this.state.currentlyProcessing.delete(mint);
    }
  }
  
  /**
   * Check if we can trade (limits, cooldown, etc.)
   */
  private async canTrade(): Promise<{ allowed: boolean; reason?: string }> {
    // Check cooldown
    const timeSinceLastTrade = Date.now() - this.state.lastTradeTime;
    if (this.state.lastTradeTime > 0 && timeSinceLastTrade < PIPELINE_CONFIG.tradeCooldownMs) {
      const remaining = Math.ceil((PIPELINE_CONFIG.tradeCooldownMs - timeSinceLastTrade) / 1000);
      return { allowed: false, reason: `Trade cooldown: ${remaining}s remaining` };
    }
    
    // Check position limits
    const activePositions = getActivePositions();
    if (activePositions.length >= PIPELINE_CONFIG.maxOpenPositions) {
      return { allowed: false, reason: `Max positions reached (${activePositions.length}/${PIPELINE_CONFIG.maxOpenPositions})` };
    }
    
    // Check trading limits (daily/weekly)
    const tradingAllowed = await isTradingAllowed();
    if (!tradingAllowed.allowed) {
      return { allowed: false, reason: tradingAllowed.reason };
    }
    
    return { allowed: true };
  }
  
  /**
   * Execute the entry trade
   */
  private async executeEntry(
    mint: string,
    symbol: string,
    checklistResult: ChecklistResult,
    totalSize: number
  ): Promise<{ entered: boolean; position?: Position; reason: string }> {
    try {
      // Get fresh token info
      const tokenInfo = await fetchTokenInfo(mint);
      
      // Generate entry signal
      const signal = generateEntrySignal(
        mint,
        symbol,
        checklistResult.details.entryAnalysis!,
        totalSize
      );
      
      displayEntrySignal(signal, symbol);
      
      // Execute tranche 1 (60%)
      logger.info('Executing Tranche 1 (60%)...');
      const tranche1Result = await executeBuy(
        mint,
        signal.tranche1Size,
        CONFIG.slippage.BUY_SLIPPAGE_PERCENT
      );
      
      if (!tranche1Result.success) {
        return { 
          entered: false, 
          reason: `Tranche 1 failed: ${tranche1Result.error}` 
        };
      }
      
      logger.success(`Tranche 1 executed: ${tranche1Result.signature}`);
      
      // Create position
      const position = createPosition(
        mint,
        symbol,
        signal.entryPrice,
        tranche1Result.amountReceived || 0,
        signal.tranche1Size
      );
      
      // Start dev wallet monitoring
      await startTokenMonitoring(mint);
      
      // Execute tranche 2 if enabled (40%)
      if (PIPELINE_CONFIG.enableTranche2) {
        logger.info('Waiting for Tranche 2 confirmation...');
        
        const tranche2Confirm = await waitForTranche2Confirmation(
          mint,
          signal.entryPrice
        );
        
        if (tranche2Confirm.confirmed) {
          logger.info('Tranche 2 confirmed, executing...');
          
          const tranche2Result = await executeBuy(
            mint,
            signal.tranche2Size,
            CONFIG.slippage.BUY_SLIPPAGE_PERCENT
          );
          
          if (tranche2Result.success) {
            // Update position with tranche 2
            const { addTranche } = await import('../trading/position-manager.js');
            addTranche(position.id, tranche2Confirm.currentPrice, signal.tranche2Size);
            logger.success('Tranche 2 executed');
          } else {
            logger.warn(`Tranche 2 failed: ${tranche2Result.error}`);
          }
        } else {
          logger.warn('Tranche 2 not confirmed - price not holding');
        }
      }
      
      logger.success(`Position opened: ${symbol}`);
      
      return {
        entered: true,
        position,
        reason: 'Entry successful',
      };
      
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      return { entered: false, reason: `Entry error: ${errMsg}` };
    }
  }
  
  /**
   * Reject a candidate and mark in queue
   */
  private reject(
    mint: string,
    symbol: string,
    reason: string,
    checklistResult?: ChecklistResult
  ): PipelineResult {
    logger.warn(`REJECTED: ${symbol} - ${reason}`);
    
    this.queue.markRejected(mint, reason);
    
    const result: PipelineResult = {
      mint,
      symbol,
      entered: false,
      rejected: true,
      reason,
      checklistResult,
    };
    
    this.onTradeRejected?.(result);
    return result;
  }
  
  /**
   * Get pipeline statistics
   */
  getStats(): {
    currentlyProcessing: number;
    lastTradeTime: number;
    timeSinceLastTrade: number;
  } {
    return {
      currentlyProcessing: this.state.currentlyProcessing.size,
      lastTradeTime: this.state.lastTradeTime,
      timeSinceLastTrade: this.state.lastTradeTime > 0 
        ? Date.now() - this.state.lastTradeTime 
        : -1,
    };
  }
  
  /**
   * Check if pipeline is idle
   */
  isIdle(): boolean {
    return this.state.currentlyProcessing.size === 0;
  }
  
  /**
   * Reset cooldown (for testing)
   */
  resetCooldown(): void {
    this.state.lastTradeTime = 0;
  }
}

// Export factory function
export function createTradePipeline(
  queue: CandidateQueue,
  callbacks?: {
    onTradeEntered?: (result: PipelineResult) => void;
    onTradeRejected?: (result: PipelineResult) => void;
  }
): TradePipeline {
  return new TradePipeline(queue, callbacks);
}
