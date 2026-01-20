/**
 * CANDIDATE QUEUE
 * 
 * Manages token candidates for the auto-trading pipeline
 * Features:
 * - Deduplication by mint address
 * - Priority queue (25-70% bonding curve progress = highest priority)
 * - Rejection cooldown (failed tokens not re-analyzed for 15 min)
 * - Max queue size with automatic trimming
 */

import { PumpPortalToken } from '../api/pump-portal.js';
import logger from '../utils/logger.js';

// Queued candidate with metadata
export interface QueuedCandidate {
  token: PumpPortalToken;
  addedAt: number;
  priority: number;
  source: 'poll' | 'websocket';
}

// Rejection record
interface RejectionRecord {
  timestamp: number;
  reason: string;
}

/**
 * Candidate Queue Class
 */
export class CandidateQueue {
  private queue: Map<string, QueuedCandidate> = new Map();
  private rejected: Map<string, RejectionRecord> = new Map();
  private processed: Set<string> = new Set(); // Tokens we've already traded
  
  private maxSize: number;
  private cooldownMs: number;
  
  constructor(maxSize: number = 50, cooldownMinutes: number = 15) {
    this.maxSize = maxSize;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }
  
  /**
   * Add a token candidate to the queue
   * Returns true if added, false if rejected/duplicate
   */
  add(token: PumpPortalToken, source: 'poll' | 'websocket' = 'poll'): boolean {
    const mint = token.mint;
    
    // Check if already processed (traded)
    if (this.processed.has(mint)) {
      return false;
    }
    
    // Check if recently rejected (in cooldown)
    const rejection = this.rejected.get(mint);
    if (rejection && Date.now() - rejection.timestamp < this.cooldownMs) {
      return false;
    }
    
    // Check if already in queue
    if (this.queue.has(mint)) {
      // Update token data if already queued (price may have changed)
      const existing = this.queue.get(mint)!;
      existing.token = token;
      return false;
    }
    
    // Calculate priority based on bonding curve progress
    const priority = this.calculatePriority(token);
    
    // Add to queue
    this.queue.set(mint, {
      token,
      addedAt: Date.now(),
      priority,
      source,
    });
    
    logger.debug(`Queued: ${token.symbol} (${mint.slice(0, 8)}...) priority=${priority.toFixed(0)}`);
    
    // Trim if over max size
    if (this.queue.size > this.maxSize) {
      this.trimQueue();
    }
    
    return true;
  }
  
  /**
   * Get the next highest-priority candidate
   * Removes it from the queue
   */
  getNext(): PumpPortalToken | null {
    if (this.queue.size === 0) {
      return null;
    }
    
    // Find highest priority candidate
    let best: QueuedCandidate | null = null;
    let bestMint: string | null = null;
    
    for (const [mint, candidate] of this.queue) {
      if (!best || candidate.priority > best.priority) {
        best = candidate;
        bestMint = mint;
      }
    }
    
    if (bestMint && best) {
      this.queue.delete(bestMint);
      return best.token;
    }
    
    return null;
  }
  
  /**
   * Peek at the next candidate without removing
   */
  peek(): PumpPortalToken | null {
    if (this.queue.size === 0) {
      return null;
    }
    
    let best: QueuedCandidate | null = null;
    
    for (const candidate of this.queue.values()) {
      if (!best || candidate.priority > best.priority) {
        best = candidate;
      }
    }
    
    return best?.token || null;
  }
  
  /**
   * Mark a token as rejected (enters cooldown)
   */
  markRejected(mint: string, reason: string = 'checklist_failed'): void {
    this.rejected.set(mint, {
      timestamp: Date.now(),
      reason,
    });
    this.queue.delete(mint);
    logger.debug(`Rejected: ${mint.slice(0, 8)}... reason=${reason}`);
  }
  
  /**
   * Mark a token as processed (we've traded it)
   */
  markProcessed(mint: string): void {
    this.processed.add(mint);
    this.queue.delete(mint);
    this.rejected.delete(mint);
  }
  
  /**
   * Check if a token is in cooldown
   */
  isInCooldown(mint: string): boolean {
    const rejection = this.rejected.get(mint);
    if (!rejection) return false;
    return Date.now() - rejection.timestamp < this.cooldownMs;
  }
  
  /**
   * Calculate priority score for a token
   * Higher = better candidate
   */
  private calculatePriority(token: PumpPortalToken): number {
    let priority = 50; // Base score
    
    const progress = token.bondingCurveProgress;
    
    // Ideal range: 25-70% progress (peak at ~47.5%)
    if (progress >= 25 && progress <= 70) {
      // Parabolic curve peaking at 47.5%
      const distanceFromIdeal = Math.abs(progress - 47.5);
      priority = 100 - distanceFromIdeal;
    } else if (progress < 25) {
      // Too early - lower priority
      priority = 30 + progress;
    } else {
      // Too late (> 70%) - lower priority
      priority = 30 + (100 - progress);
    }
    
    // Boost for higher market cap (more liquidity)
    if (token.marketCapUsd >= 20000) {
      priority += 10;
    } else if (token.marketCapUsd >= 15000) {
      priority += 5;
    }
    
    // Boost for more trades (engagement)
    if (token.tradeCount >= 20) {
      priority += 5;
    } else if (token.tradeCount >= 10) {
      priority += 2;
    }
    
    // Slight boost for having social links
    if (token.twitter || token.telegram || token.website) {
      priority += 3;
    }
    
    return Math.max(0, Math.min(100, priority));
  }
  
  /**
   * Trim queue to max size by removing lowest priority items
   */
  private trimQueue(): void {
    const entries = [...this.queue.entries()];
    entries.sort((a, b) => a[1].priority - b[1].priority);
    
    while (this.queue.size > this.maxSize && entries.length > 0) {
      const [mint] = entries.shift()!;
      this.queue.delete(mint);
    }
    
    logger.debug(`Queue trimmed to ${this.queue.size} candidates`);
  }
  
  /**
   * Clean up expired rejections
   */
  cleanupExpiredRejections(): void {
    const now = Date.now();
    for (const [mint, rejection] of this.rejected) {
      if (now - rejection.timestamp >= this.cooldownMs) {
        this.rejected.delete(mint);
      }
    }
  }
  
  /**
   * Get current queue size
   */
  get size(): number {
    return this.queue.size;
  }
  
  /**
   * Get rejection count
   */
  get rejectedCount(): number {
    return this.rejected.size;
  }
  
  /**
   * Get processed count
   */
  get processedCount(): number {
    return this.processed.size;
  }
  
  /**
   * Clear the entire queue
   */
  clear(): void {
    this.queue.clear();
  }
  
  /**
   * Reset everything (queue, rejections, processed)
   */
  reset(): void {
    this.queue.clear();
    this.rejected.clear();
    this.processed.clear();
  }
  
  /**
   * Get queue statistics
   */
  getStats(): {
    queueSize: number;
    rejectedCount: number;
    processedCount: number;
    topCandidate: { symbol: string; priority: number } | null;
  } {
    const top = this.peek();
    
    return {
      queueSize: this.queue.size,
      rejectedCount: this.rejected.size,
      processedCount: this.processed.size,
      topCandidate: top ? {
        symbol: top.symbol,
        priority: this.queue.get(top.mint)?.priority || 0,
      } : null,
    };
  }
  
  /**
   * Get all queued tokens (for display/debugging)
   */
  getAllQueued(): Array<{ token: PumpPortalToken; priority: number }> {
    return [...this.queue.values()]
      .sort((a, b) => b.priority - a.priority)
      .map(c => ({ token: c.token, priority: c.priority }));
  }
}

// Export default instance
export const candidateQueue = new CandidateQueue();
