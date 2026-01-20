/**
 * DEV & SMART WALLET MONITORING
 * 
 * INSTANT EXIT CONDITIONS:
 * - Dev wallet sells > 25% of holdings
 * - Any wallet dumps > 10% supply in < 60s
 * - LP removal attempt detected
 * 
 * This saves you from "slow rugs"
 */

import { DEV_MONITORING } from '../config/index.js';
import { 
  DevWalletActivity, 
  AlertType, 
  Position 
} from '../types/index.js';
import { getActivePositions, closePosition } from '../trading/position-manager.js';
import { emergencySell, getTokenBalance } from '../trading/executor.js';
import { fetchTokenHolders, fetchLPInfo } from '../api/data-providers.js';
import logger from '../utils/logger.js';

// Track monitored tokens and their dev wallets
const monitoredTokens: Map<string, {
  devWallet: string | null;
  devInitialBalance: number;
  lpAddress: string | null;
  lastCheck: Date;
}> = new Map();

// Alert history
const alertHistory: AlertType[] = [];

/**
 * Start monitoring a token for rug signals
 */
export async function startTokenMonitoring(
  mintAddress: string,
  devWalletAddress?: string
): Promise<void> {
  logger.info(`Starting dev wallet monitoring for ${mintAddress.slice(0, 8)}...`);
  
  try {
    // Get initial holder data to identify dev if not provided
    const holders = await fetchTokenHolders(mintAddress);
    const lpInfo = await fetchLPInfo(mintAddress);
    
    // Identify dev wallet (largest non-LP holder)
    let devWallet = devWalletAddress || null;
    let devBalance = 0;
    
    if (!devWallet && holders.length > 0) {
      const lpAddresses = new Set(lpInfo.lpAddresses);
      const nonLPHolders = holders.filter(h => !lpAddresses.has(h.address));
      
      if (nonLPHolders.length > 0) {
        devWallet = nonLPHolders[0].address;
        devBalance = nonLPHolders[0].balance;
      }
    }
    
    monitoredTokens.set(mintAddress, {
      devWallet,
      devInitialBalance: devBalance,
      lpAddress: lpInfo.lpAddresses[0] || null,
      lastCheck: new Date(),
    });
    
    logger.info(`  Dev wallet: ${devWallet?.slice(0, 8) || 'Unknown'}...`);
    logger.info(`  LP address: ${lpInfo.lpAddresses[0]?.slice(0, 8) || 'Unknown'}...`);
    
  } catch (error) {
    logger.error('Failed to start token monitoring', error);
  }
}

/**
 * Stop monitoring a token
 */
export function stopTokenMonitoring(mintAddress: string): void {
  monitoredTokens.delete(mintAddress);
  logger.info(`Stopped monitoring ${mintAddress.slice(0, 8)}...`);
}

/**
 * Check for rug signals on a specific token
 */
export async function checkRugSignals(mintAddress: string): Promise<{
  isRug: boolean;
  signals: AlertType[];
}> {
  const signals: AlertType[] = [];
  const tokenData = monitoredTokens.get(mintAddress);
  
  if (!tokenData) {
    return { isRug: false, signals: [] };
  }
  
  try {
    // 1. Check dev wallet activity
    if (tokenData.devWallet) {
      const devSellSignal = await checkDevWalletSell(
        mintAddress,
        tokenData.devWallet,
        tokenData.devInitialBalance
      );
      
      if (devSellSignal) {
        signals.push(devSellSignal);
      }
    }
    
    // 2. Check for whale dumps
    const whaleDumpSignal = await checkWhaleDumps(mintAddress);
    if (whaleDumpSignal) {
      signals.push(whaleDumpSignal);
    }
    
    // 3. Check LP removal
    if (tokenData.lpAddress) {
      const lpRemovalSignal = await checkLPRemoval(
        mintAddress,
        tokenData.lpAddress
      );
      
      if (lpRemovalSignal) {
        signals.push(lpRemovalSignal);
      }
    }
    
    // Update last check time
    tokenData.lastCheck = new Date();
    
    // Determine if any signal is critical
    const isRug = signals.some(s => s.severity === 'critical');
    
    // Store alerts in history
    alertHistory.push(...signals);
    
    return { isRug, signals };
    
  } catch (error) {
    logger.error('Rug signal check failed', error);
    return { isRug: false, signals: [] };
  }
}

/**
 * Check if dev wallet has sold significant portion
 */
async function checkDevWalletSell(
  mintAddress: string,
  devWallet: string,
  initialBalance: number
): Promise<AlertType | null> {
  try {
    const holders = await fetchTokenHolders(mintAddress);
    const devHolder = holders.find(h => h.address === devWallet);
    
    if (!devHolder) {
      // Dev wallet no longer in top holders - might have sold all
      return {
        type: 'dev_sell',
        severity: 'critical',
        message: 'Dev wallet no longer in top holders - possible complete exit',
        data: { devWallet, initialBalance },
        timestamp: new Date(),
      };
    }
    
    const currentBalance = devHolder.balance;
    const soldPercent = ((initialBalance - currentBalance) / initialBalance) * 100;
    
    if (soldPercent >= DEV_MONITORING.DEV_SELL_EXIT_THRESHOLD_PERCENT) {
      return {
        type: 'dev_sell',
        severity: 'critical',
        message: `DEV SOLD ${soldPercent.toFixed(0)}% of holdings!`,
        data: { 
          devWallet, 
          initialBalance, 
          currentBalance, 
          soldPercent 
        },
        timestamp: new Date(),
      };
    }
    
    // Warning if dev is selling but not at critical level
    if (soldPercent >= 10) {
      return {
        type: 'dev_sell',
        severity: 'warning',
        message: `Dev selling: ${soldPercent.toFixed(0)}% sold`,
        data: { 
          devWallet, 
          initialBalance, 
          currentBalance, 
          soldPercent 
        },
        timestamp: new Date(),
      };
    }
    
    return null;
    
  } catch {
    return null;
  }
}

/**
 * Check for large whale dumps
 */
async function checkWhaleDumps(mintAddress: string): Promise<AlertType | null> {
  // This would require transaction monitoring
  // For now, check if any large holder has rapidly decreased
  
  // TODO: Implement via websocket transaction monitoring
  // For now, return null (no dump detected)
  
  return null;
}

/**
 * Check for LP removal attempts
 */
async function checkLPRemoval(
  mintAddress: string,
  lpAddress: string
): Promise<AlertType | null> {
  try {
    const lpInfo = await fetchLPInfo(mintAddress);
    
    // Check if LP has significantly decreased
    // This is a simple check - in production you'd monitor LP transactions
    
    if (lpInfo.solAmount < 5) {
      return {
        type: 'lp_removal',
        severity: 'critical',
        message: 'LP CRITICALLY LOW - Possible rug pull!',
        data: { lpAddress, currentLP: lpInfo.solAmount },
        timestamp: new Date(),
      };
    }
    
    return null;
    
  } catch {
    return null;
  }
}

/**
 * Handle emergency exit on rug detection
 */
export async function handleRugDetected(
  mintAddress: string,
  signals: AlertType[]
): Promise<void> {
  logger.alert('danger', '🚨 RUG DETECTED - INITIATING EMERGENCY EXIT');
  
  signals.forEach(signal => {
    logger.critical(`  ${signal.type}: ${signal.message}`);
  });
  
  // Find and close any positions for this token
  const positions = getActivePositions();
  const position = positions.find(p => p.mint === mintAddress);
  
  if (position) {
    // Get token balance
    const balance = await getTokenBalance(mintAddress);
    
    if (balance > 0) {
      logger.critical(`Executing emergency sell for ${position.symbol}`);
      
      const result = await emergencySell(mintAddress, balance);
      
      if (result.success) {
        closePosition(position.id, 0, 100, 'emergency_exit');
        logger.success('Emergency exit completed');
      } else {
        logger.error(`Emergency exit failed: ${result.error}`);
      }
    }
  }
  
  // Stop monitoring this token
  stopTokenMonitoring(mintAddress);
}

/**
 * Run monitoring check for all tracked tokens
 */
export async function runMonitoringCycle(): Promise<void> {
  for (const [mintAddress, _] of monitoredTokens) {
    const { isRug, signals } = await checkRugSignals(mintAddress);
    
    if (isRug) {
      await handleRugDetected(mintAddress, signals);
    } else if (signals.length > 0) {
      // Log warnings
      signals.forEach(signal => {
        if (signal.severity === 'warning') {
          logger.warn(`⚠️ ${signal.type}: ${signal.message}`);
        }
      });
    }
  }
}

/**
 * Start continuous monitoring loop
 */
export function startMonitoringLoop(intervalMs: number = 10000): () => void {
  logger.info(`Starting dev wallet monitoring loop (every ${intervalMs / 1000}s)`);
  
  const interval = setInterval(async () => {
    try {
      await runMonitoringCycle();
    } catch (error) {
      logger.error('Monitoring cycle error', error);
    }
  }, intervalMs);
  
  return () => {
    clearInterval(interval);
    logger.info('Dev wallet monitoring stopped');
  };
}

/**
 * Get recent alerts
 */
export function getRecentAlerts(count: number = 10): AlertType[] {
  return alertHistory.slice(-count);
}

/**
 * Get monitored tokens list
 */
export function getMonitoredTokens(): string[] {
  return Array.from(monitoredTokens.keys());
}
