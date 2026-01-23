/**
 * HELIUS ON-CHAIN PRICE MONITOR
 * 
 * Truly real-time price monitoring via Helius WebSocket subscriptions
 * Subscribes directly to on-chain account changes (bonding curves, pools)
 * 
 * Advantages over PumpPortal:
 * - Direct on-chain data (no middleman delay)
 * - Updates on EVERY transaction, not just trade events
 * - More reliable connection with Helius infrastructure
 * 
 * Requirements:
 * - HELIUS_API_KEY environment variable
 * - Or SOLANA_WS_URL pointing to Helius WebSocket endpoint
 */

import WebSocket from 'ws';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ENV } from '../config/index.js';
import logger from '../utils/logger.js';

// Pump.fun program ID (for bonding curve accounts)
const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Bonding curve account data layout offsets (from Pump.fun program)
// These offsets are for the bonding curve PDA account structure
const BONDING_CURVE_LAYOUT = {
  // Account discriminator
  DISCRIMINATOR_OFFSET: 0,
  DISCRIMINATOR_SIZE: 8,
  
  // Virtual token reserves (u64)
  VIRTUAL_TOKEN_RESERVES_OFFSET: 8,
  VIRTUAL_TOKEN_RESERVES_SIZE: 8,
  
  // Virtual SOL reserves (u64)
  VIRTUAL_SOL_RESERVES_OFFSET: 16,
  VIRTUAL_SOL_RESERVES_SIZE: 8,
  
  // Real token reserves (u64)
  REAL_TOKEN_RESERVES_OFFSET: 24,
  REAL_TOKEN_RESERVES_SIZE: 8,
  
  // Real SOL reserves (u64)
  REAL_SOL_RESERVES_OFFSET: 32,
  REAL_SOL_RESERVES_SIZE: 8,
  
  // Token total supply (u64)
  TOKEN_TOTAL_SUPPLY_OFFSET: 40,
  TOKEN_TOTAL_SUPPLY_SIZE: 8,
  
  // Complete flag (bool)
  COMPLETE_OFFSET: 48,
  COMPLETE_SIZE: 1,
};

// Parsed bonding curve state
export interface BondingCurveState {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  realTokenReserves: number;
  realSolReserves: number;
  tokenTotalSupply: number;
  complete: boolean;
  priceSol: number;
  marketCapSol: number;
}

// Price update event
export interface HeliusPriceUpdate {
  mint: string;
  bondingCurve: string;
  priceSol: number;
  priceUsd: number;
  marketCapSol: number;
  marketCapUsd: number;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  bondingCurveProgress: number;
  isGraduated: boolean;
  timestamp: number;
  slot: number;
  source: 'helius_onchain';
}

// Subscription info
interface AccountSubscription {
  mint: string;
  bondingCurve: string;
  subscriptionId: number | null;
  lastUpdate: number;
  lastState: BondingCurveState | null;
  callbacks: ((update: HeliusPriceUpdate) => void)[];
}

// WebSocket message types
interface HeliusAccountNotification {
  jsonrpc: '2.0';
  method: 'accountNotification';
  params: {
    result: {
      context: { slot: number };
      value: {
        lamports: number;
        data: [string, 'base64'] | { parsed: unknown };
        owner: string;
        executable: boolean;
        rentEpoch: number;
      };
    };
    subscription: number;
  };
}

/**
 * Helius On-Chain Price Monitor
 * 
 * Subscribes to bonding curve account changes via WebSocket
 * Provides truly real-time price updates
 */
export class HeliusPriceMonitor {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private subscriptions: Map<string, AccountSubscription> = new Map(); // keyed by mint
  private subscriptionIdToMint: Map<number, string> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private messageId = 1;
  private pendingRequests: Map<number, { resolve: (id: number) => void; reject: (err: Error) => void }> = new Map();
  private solPrice = 150; // Cached SOL price
  private heartbeatInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    // Start SOL price refresh
    this.refreshSolPrice();
    setInterval(() => this.refreshSolPrice(), 30000);
  }
  
  /**
   * Get Helius WebSocket URL
   */
  private getWebSocketUrl(): string {
    // Check for Helius API key first
    if (ENV.HELIUS_API_KEY) {
      return `wss://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`;
    }
    
    // Fall back to configured WebSocket URL
    if (ENV.SOLANA_WS_URL && ENV.SOLANA_WS_URL.includes('helius')) {
      return ENV.SOLANA_WS_URL;
    }
    
    // Use RPC URL to derive WebSocket URL if it's Helius
    if (ENV.SOLANA_RPC_URL && ENV.SOLANA_RPC_URL.includes('helius')) {
      return ENV.SOLANA_RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    }
    
    throw new Error('Helius API key or Helius WebSocket URL required for on-chain monitoring');
  }
  
  /**
   * Connect to Helius WebSocket
   */
  async connect(): Promise<void> {
    if (this.isConnected && this.ws) {
      return;
    }
    
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.getWebSocketUrl();
        logger.info(`Connecting to Helius WebSocket...`);
        
        this.ws = new WebSocket(wsUrl);
        
        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          logger.success('Connected to Helius WebSocket (on-chain monitoring enabled)');
          
          // Start heartbeat
          this.startHeartbeat();
          
          // Resubscribe to all accounts
          this.resubscribeAll();
          
          resolve();
        });
        
        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            logger.debug(`Helius message parse error: ${error}`);
          }
        });
        
        this.ws.on('close', () => {
          this.isConnected = false;
          this.stopHeartbeat();
          logger.warn('Helius WebSocket disconnected');
          this.attemptReconnect();
        });
        
        this.ws.on('error', (error) => {
          logger.error('Helius WebSocket error:', error);
          if (!this.isConnected) {
            reject(error);
          }
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    this.subscriptions.clear();
    this.subscriptionIdToMint.clear();
    this.pendingRequests.clear();
    
    logger.info('Helius WebSocket disconnected');
  }
  
  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.isConnected) {
        // Send a simple getHealth request as heartbeat
        const id = this.messageId++;
        this.ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'getHealth',
        }));
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  /**
   * Attempt to reconnect
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached for Helius WebSocket');
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    logger.info(`Reconnecting to Helius in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect().catch(() => {});
    }, delay);
  }
  
  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: any): void {
    // Handle subscription responses
    if (message.id && message.result !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        pending.resolve(message.result);
        this.pendingRequests.delete(message.id);
      }
      return;
    }
    
    // Handle subscription errors
    if (message.id && message.error) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        pending.reject(new Error(message.error.message || 'Subscription error'));
        this.pendingRequests.delete(message.id);
      }
      return;
    }
    
    // Handle account notifications
    if (message.method === 'accountNotification') {
      this.handleAccountNotification(message as HeliusAccountNotification);
    }
  }
  
  /**
   * Handle account change notification
   */
  private handleAccountNotification(notification: HeliusAccountNotification): void {
    const subscriptionId = notification.params.subscription;
    const mint = this.subscriptionIdToMint.get(subscriptionId);
    
    if (!mint) {
      logger.debug(`Received notification for unknown subscription: ${subscriptionId}`);
      return;
    }
    
    const subscription = this.subscriptions.get(mint);
    if (!subscription) {
      return;
    }
    
    const accountData = notification.params.result.value.data;
    const slot = notification.params.result.context.slot;
    
    // Parse the bonding curve data
    if (Array.isArray(accountData) && accountData[1] === 'base64') {
      const buffer = Buffer.from(accountData[0], 'base64');
      const state = this.parseBondingCurveData(buffer);
      
      if (state) {
        subscription.lastState = state;
        subscription.lastUpdate = Date.now();
        
        // Create price update using helper
        const update = this.createPriceUpdate(mint, subscription.bondingCurve, state, slot);
        
        // Notify all callbacks
        for (const callback of subscription.callbacks) {
          try {
            callback(update);
          } catch (error) {
            logger.debug(`Helius callback error: ${error}`);
          }
        }
        
        logger.debug(`[HELIUS] ${mint.slice(0, 8)}... price: ${state.priceSol.toExponential(4)} SOL (slot ${slot})`);
      }
    }
  }
  
  /**
   * Parse bonding curve account data
   */
  private parseBondingCurveData(buffer: Buffer): BondingCurveState | null {
    try {
      if (buffer.length < 49) {
        logger.debug(`Buffer too small for bonding curve: ${buffer.length} bytes`);
        return null;
      }
      
      // Read u64 values as BigInt then convert to number
      // Note: Pump.fun uses little-endian byte order
      const virtualTokenReserves = Number(buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_TOKEN_RESERVES_OFFSET));
      const virtualSolReserves = Number(buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.VIRTUAL_SOL_RESERVES_OFFSET));
      const realTokenReserves = Number(buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_TOKEN_RESERVES_OFFSET));
      const realSolReserves = Number(buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.REAL_SOL_RESERVES_OFFSET));
      const tokenTotalSupply = Number(buffer.readBigUInt64LE(BONDING_CURVE_LAYOUT.TOKEN_TOTAL_SUPPLY_OFFSET));
      const complete = buffer.readUInt8(BONDING_CURVE_LAYOUT.COMPLETE_OFFSET) === 1;
      
      // Convert to human-readable values
      // virtualSolReserves is in lamports, virtualTokenReserves is in token atoms (6 decimals)
      const vSol = virtualSolReserves / LAMPORTS_PER_SOL;
      const vTokens = virtualTokenReserves / 1e6;
      const rSol = realSolReserves / LAMPORTS_PER_SOL;
      const rTokens = realTokenReserves / 1e6;
      const totalSupply = tokenTotalSupply / 1e6;
      
      // Calculate price: SOL per token
      const priceSol = vTokens > 0 ? vSol / vTokens : 0;
      
      // Market cap = price * total supply
      const marketCapSol = priceSol * (totalSupply || 1_000_000_000);
      
      return {
        virtualTokenReserves: vTokens,
        virtualSolReserves: vSol,
        realTokenReserves: rTokens,
        realSolReserves: rSol,
        tokenTotalSupply: totalSupply,
        complete,
        priceSol,
        marketCapSol,
      };
      
    } catch (error) {
      logger.debug(`Failed to parse bonding curve data: ${error}`);
      return null;
    }
  }
  
  /**
   * Subscribe to bonding curve account changes
   */
  async subscribeToBondingCurve(
    mint: string,
    bondingCurve: string,
    callback: (update: HeliusPriceUpdate) => void
  ): Promise<() => void> {
    // Ensure connected
    if (!this.isConnected) {
      await this.connect();
    }
    
    // Check if already subscribed
    let subscription = this.subscriptions.get(mint);
    
    if (subscription) {
      // Add callback to existing subscription
      subscription.callbacks.push(callback);
      logger.debug(`Added callback to existing Helius subscription for ${mint.slice(0, 8)}...`);
      
      // Send initial state if we have it
      if (subscription.lastState) {
        const update = this.createPriceUpdate(mint, bondingCurve, subscription.lastState, 0);
        callback(update);
      }
      
      return () => {
        this.removeCallback(mint, callback);
      };
    }
    
    // Create new subscription
    subscription = {
      mint,
      bondingCurve,
      subscriptionId: null,
      lastUpdate: 0,
      lastState: null,
      callbacks: [callback],
    };
    
    this.subscriptions.set(mint, subscription);
    
    // Subscribe to account
    try {
      const subscriptionId = await this.sendAccountSubscribe(bondingCurve);
      subscription.subscriptionId = subscriptionId;
      this.subscriptionIdToMint.set(subscriptionId, mint);
      
      logger.success(`Helius subscribed to ${mint.slice(0, 8)}... (bonding curve: ${bondingCurve.slice(0, 8)}...)`);
      
      // Fetch initial account state (since WebSocket only sends changes)
      await this.fetchInitialState(mint, bondingCurve, callback);
      
    } catch (error) {
      logger.error(`Failed to subscribe to ${mint.slice(0, 8)}...: ${error}`);
      this.subscriptions.delete(mint);
    }
    
    return () => {
      this.removeCallback(mint, callback);
    };
  }
  
  /**
   * Fetch initial account state via RPC
   */
  private async fetchInitialState(
    mint: string, 
    bondingCurve: string, 
    callback: (update: HeliusPriceUpdate) => void
  ): Promise<void> {
    try {
      // Use Helius RPC to get current account state
      const rpcUrl = ENV.HELIUS_API_KEY 
        ? `https://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`
        : ENV.SOLANA_RPC_URL;
      
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [bondingCurve, { encoding: 'base64' }],
        }),
      });
      
      if (!response.ok) {
        logger.debug(`[HELIUS] Failed to fetch initial state: ${response.status}`);
        return;
      }
      
      const data = await response.json() as any;
      
      if (data.result?.value?.data) {
        const accountData = data.result.value.data;
        if (Array.isArray(accountData) && accountData[1] === 'base64') {
          const buffer = Buffer.from(accountData[0], 'base64');
          const state = this.parseBondingCurveData(buffer);
          
          if (state) {
            const subscription = this.subscriptions.get(mint);
            if (subscription) {
              subscription.lastState = state;
              subscription.lastUpdate = Date.now();
            }
            
            const update = this.createPriceUpdate(mint, bondingCurve, state, 0);
            callback(update);
            
            logger.info(`[HELIUS] Initial state: ${mint.slice(0, 8)}... price=${state.priceSol.toExponential(4)} SOL`);
          }
        }
      } else {
        logger.warn(`[HELIUS] Bonding curve account not found: ${bondingCurve.slice(0, 8)}...`);
      }
    } catch (error) {
      logger.debug(`[HELIUS] Error fetching initial state: ${error}`);
    }
  }
  
  /**
   * Create price update object from state
   */
  private createPriceUpdate(
    mint: string, 
    bondingCurve: string, 
    state: BondingCurveState, 
    slot: number
  ): HeliusPriceUpdate {
    return {
      mint,
      bondingCurve,
      priceSol: state.priceSol,
      priceUsd: state.priceSol * this.solPrice,
      marketCapSol: state.marketCapSol,
      marketCapUsd: state.marketCapSol * this.solPrice,
      virtualSolReserves: state.virtualSolReserves,
      virtualTokenReserves: state.virtualTokenReserves,
      bondingCurveProgress: (state.realSolReserves / 85) * 100,
      isGraduated: state.complete,
      timestamp: Date.now(),
      slot,
      source: 'helius_onchain',
    };
  }
  
  /**
   * Send accountSubscribe request
   */
  private async sendAccountSubscribe(account: string): Promise<number> {
    if (!this.ws || !this.isConnected) {
      throw new Error('WebSocket not connected');
    }
    
    const id = this.messageId++;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      const request = {
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        params: [
          account,
          {
            encoding: 'base64',
            commitment: 'confirmed',
          },
        ],
      };
      
      this.ws!.send(JSON.stringify(request));
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Subscription request timed out'));
        }
      }, 10000);
    });
  }
  
  /**
   * Send accountUnsubscribe request
   */
  private async sendAccountUnsubscribe(subscriptionId: number): Promise<void> {
    if (!this.ws || !this.isConnected) {
      return;
    }
    
    const id = this.messageId++;
    
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'accountUnsubscribe',
      params: [subscriptionId],
    }));
  }
  
  /**
   * Remove a callback from a subscription
   */
  private removeCallback(mint: string, callback: (update: HeliusPriceUpdate) => void): void {
    const subscription = this.subscriptions.get(mint);
    if (!subscription) return;
    
    const index = subscription.callbacks.indexOf(callback);
    if (index > -1) {
      subscription.callbacks.splice(index, 1);
    }
    
    // If no more callbacks, unsubscribe
    if (subscription.callbacks.length === 0) {
      if (subscription.subscriptionId !== null) {
        this.sendAccountUnsubscribe(subscription.subscriptionId);
        this.subscriptionIdToMint.delete(subscription.subscriptionId);
      }
      this.subscriptions.delete(mint);
      logger.debug(`Helius unsubscribed from ${mint.slice(0, 8)}...`);
    }
  }
  
  /**
   * Resubscribe all accounts after reconnection
   */
  private async resubscribeAll(): Promise<void> {
    for (const [mint, subscription] of this.subscriptions) {
      try {
        const subscriptionId = await this.sendAccountSubscribe(subscription.bondingCurve);
        subscription.subscriptionId = subscriptionId;
        this.subscriptionIdToMint.set(subscriptionId, mint);
        logger.debug(`Resubscribed to ${mint.slice(0, 8)}...`);
      } catch (error) {
        logger.warn(`Failed to resubscribe to ${mint.slice(0, 8)}...: ${error}`);
      }
    }
  }
  
  /**
   * Refresh cached SOL price
   */
  private async refreshSolPrice(): Promise<void> {
    try {
      const response = await fetch('https://frontend-api-v3.pump.fun/sol-price');
      if (response.ok) {
        const data = await response.json() as { solPrice: number } | number;
        this.solPrice = typeof data === 'number' ? data : (data.solPrice || 150);
      }
    } catch {
      // Keep using cached price
    }
  }
  
  /**
   * Get current SOL price
   */
  getSolPrice(): number {
    return this.solPrice;
  }
  
  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.isConnected;
  }
  
  /**
   * Get subscription count
   */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }
  
  /**
   * Check if a token is subscribed
   */
  isSubscribed(mint: string): boolean {
    return this.subscriptions.has(mint);
  }
  
  /**
   * Get last known state for a token
   */
  getLastState(mint: string): BondingCurveState | null {
    return this.subscriptions.get(mint)?.lastState || null;
  }
}

// Graduated token polling subscription
interface GraduatedTokenSubscription {
  mint: string;
  poolAddress: string;
  callbacks: ((update: HeliusPriceUpdate) => void)[];
  intervalId: NodeJS.Timeout | null;
  lastPrice: number;
  lastMcSol: number;
}

/**
 * Extended Helius Price Monitor with support for graduated tokens
 * Uses Helius RPC polling for graduated tokens (Raydium pools)
 */
export class HeliusPriceMonitorExtended extends HeliusPriceMonitor {
  private graduatedSubscriptions: Map<string, GraduatedTokenSubscription> = new Map();
  private pollIntervalMs = 2000; // Poll every 2 seconds
  
  /**
   * Subscribe to price updates for a graduated token via Helius RPC polling
   * This uses Helius RPC to fetch pool data periodically
   */
  async subscribeToGraduatedToken(
    mint: string,
    poolAddress: string,
    callback: (update: HeliusPriceUpdate) => void,
    pollIntervalMs: number = 2000
  ): Promise<() => void> {
    this.pollIntervalMs = pollIntervalMs;
    
    // Check if already subscribed
    let subscription = this.graduatedSubscriptions.get(mint);
    
    if (subscription) {
      subscription.callbacks.push(callback);
      logger.debug(`[HELIUS] Added callback to existing graduated subscription for ${mint.slice(0, 8)}...`);
      
      // Send last known price if available
      if (subscription.lastPrice > 0) {
        callback({
          mint,
          bondingCurve: poolAddress,
          priceSol: subscription.lastPrice,
          priceUsd: subscription.lastPrice * this.getSolPrice(),
          marketCapSol: subscription.lastMcSol,
          marketCapUsd: subscription.lastMcSol * this.getSolPrice(),
          virtualSolReserves: 0,
          virtualTokenReserves: 0,
          bondingCurveProgress: 100,
          isGraduated: true,
          timestamp: Date.now(),
          slot: 0,
          source: 'helius_onchain',
        });
      }
      
      return () => this.removeGraduatedCallback(mint, callback);
    }
    
    // Create new subscription
    subscription = {
      mint,
      poolAddress,
      callbacks: [callback],
      intervalId: null,
      lastPrice: 0,
      lastMcSol: 0,
    };
    
    this.graduatedSubscriptions.set(mint, subscription);
    
    // Fetch initial price
    await this.fetchGraduatedPrice(mint, subscription);
    
    // Start polling interval
    subscription.intervalId = setInterval(async () => {
      await this.fetchGraduatedPrice(mint, subscription!);
    }, this.pollIntervalMs);
    
    logger.success(`[HELIUS] Subscribed to graduated token ${mint.slice(0, 8)}... (polling every ${pollIntervalMs}ms)`);
    
    return () => this.removeGraduatedCallback(mint, callback);
  }
  
  /**
   * Fetch current price for a graduated token via Helius RPC
   */
  private async fetchGraduatedPrice(mint: string, subscription: GraduatedTokenSubscription): Promise<void> {
    try {
      const rpcUrl = ENV.HELIUS_API_KEY 
        ? `https://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`
        : ENV.SOLANA_RPC_URL;
      
      // Use Helius DAS API to get token price (more reliable for graduated tokens)
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAsset',
          params: { id: mint },
        }),
      });
      
      if (response.ok) {
        const data = await response.json() as any;
        
        // Check if asset has price info
        if (data.result?.token_info?.price_info?.price_per_token) {
          const priceUsd = data.result.token_info.price_info.price_per_token;
          const supply = data.result.token_info.supply || 1_000_000_000_000_000; // 6 decimals
          const actualSupply = supply / 1e6; // Convert from raw to human-readable
          const solPrice = this.getSolPrice();
          const priceSol = priceUsd / solPrice;
          const mcSol = priceSol * actualSupply;
          
          subscription.lastPrice = priceSol;
          subscription.lastMcSol = mcSol;
          
          const update: HeliusPriceUpdate = {
            mint,
            bondingCurve: subscription.poolAddress,
            priceSol,
            priceUsd,
            marketCapSol: mcSol,
            marketCapUsd: mcSol * solPrice,
            virtualSolReserves: 0,
            virtualTokenReserves: 0,
            bondingCurveProgress: 100,
            isGraduated: true,
            timestamp: Date.now(),
            slot: 0,
            source: 'helius_onchain',
          };
          
          for (const cb of subscription.callbacks) {
            try {
              cb(update);
            } catch (err) {
              logger.debug(`[HELIUS] Graduated callback error: ${err}`);
            }
          }
          
          logger.debug(`[HELIUS] Graduated price: ${mint.slice(0, 8)}... = ${priceSol.toExponential(4)} SOL`);
          return;
        }
      }
      
      // Fallback: Try to get pool account data directly
      await this.fetchPoolPrice(mint, subscription);
      
    } catch (error) {
      logger.debug(`[HELIUS] Graduated price fetch error: ${error}`);
    }
  }
  
  /**
   * Fetch price from pool account data (Raydium CPMM)
   */
  private async fetchPoolPrice(mint: string, subscription: GraduatedTokenSubscription): Promise<void> {
    try {
      const rpcUrl = ENV.HELIUS_API_KEY 
        ? `https://mainnet.helius-rpc.com/?api-key=${ENV.HELIUS_API_KEY}`
        : ENV.SOLANA_RPC_URL;
      
      // Fetch pool account
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [subscription.poolAddress, { encoding: 'base64' }],
        }),
      });
      
      if (!response.ok) {
        return;
      }
      
      const data = await response.json() as any;
      
      if (data.result?.value?.data) {
        const accountData = data.result.value.data;
        if (Array.isArray(accountData) && accountData[1] === 'base64') {
          const buffer = Buffer.from(accountData[0], 'base64');
          
          // Try to parse as Raydium CPMM pool
          // CPMM layout: discriminator(8) + amm_config(32) + pool_creator(32) + token_0_vault(32) + ...
          // token_0_mint(32) + token_1_mint(32) + lp_mint(32) + token_0_amount(8) + token_1_amount(8) + ...
          
          if (buffer.length >= 300) {
            // Try different pool layouts
            const parsed = this.parsePoolData(buffer, mint);
            if (parsed) {
              subscription.lastPrice = parsed.priceSol;
              subscription.lastMcSol = parsed.mcSol;
              
              const update: HeliusPriceUpdate = {
                mint,
                bondingCurve: subscription.poolAddress,
                priceSol: parsed.priceSol,
                priceUsd: parsed.priceSol * this.getSolPrice(),
                marketCapSol: parsed.mcSol,
                marketCapUsd: parsed.mcSol * this.getSolPrice(),
                virtualSolReserves: parsed.solReserves,
                virtualTokenReserves: parsed.tokenReserves,
                bondingCurveProgress: 100,
                isGraduated: true,
                timestamp: Date.now(),
                slot: 0,
                source: 'helius_onchain',
              };
              
              for (const cb of subscription.callbacks) {
                try {
                  cb(update);
                } catch (err) {
                  logger.debug(`[HELIUS] Pool callback error: ${err}`);
                }
              }
              
              logger.debug(`[HELIUS] Pool price: ${mint.slice(0, 8)}... = ${parsed.priceSol.toExponential(4)} SOL`);
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`[HELIUS] Pool price fetch error: ${error}`);
    }
  }
  
  /**
   * Parse pool account data to extract reserves and calculate price
   */
  private parsePoolData(buffer: Buffer, targetMint: string): { priceSol: number; mcSol: number; solReserves: number; tokenReserves: number } | null {
    try {
      // Raydium CPMM pool layout (simplified)
      // Different pool types have different layouts, so we try common patterns
      
      // Pattern 1: Raydium CPMM
      // Offsets may vary, common structure:
      // - Various config/state data
      // - Token vault amounts at specific offsets
      
      // Try to find token amounts (u64 values that look like reserves)
      // Look for pairs of reasonable-looking reserve values
      
      for (let offset = 200; offset < Math.min(buffer.length - 16, 400); offset += 8) {
        try {
          const val1 = Number(buffer.readBigUInt64LE(offset));
          const val2 = Number(buffer.readBigUInt64LE(offset + 8));
          
          // Check if these look like reserves (reasonable values)
          // SOL reserves typically 1-1000 SOL (1e9 - 1e12 lamports)
          // Token reserves typically 1M-1B tokens (1e12 - 1e15 with 6 decimals)
          
          const val1Sol = val1 / LAMPORTS_PER_SOL;
          const val2Sol = val2 / LAMPORTS_PER_SOL;
          const val1Tokens = val1 / 1e6;
          const val2Tokens = val2 / 1e6;
          
          // Try to identify which is SOL and which is token
          // SOL reserves for graduated tokens are typically 80-100 SOL initially
          if (val1Sol >= 1 && val1Sol <= 10000 && val2Tokens >= 100_000 && val2Tokens <= 1_000_000_000_000) {
            const priceSol = val1Sol / val2Tokens;
            if (priceSol > 1e-12 && priceSol < 1) {
              const mcSol = priceSol * 1_000_000_000; // 1B supply
              return {
                priceSol,
                mcSol,
                solReserves: val1Sol,
                tokenReserves: val2Tokens,
              };
            }
          }
          
          // Try reverse (token first, then SOL)
          if (val2Sol >= 1 && val2Sol <= 10000 && val1Tokens >= 100_000 && val1Tokens <= 1_000_000_000_000) {
            const priceSol = val2Sol / val1Tokens;
            if (priceSol > 1e-12 && priceSol < 1) {
              const mcSol = priceSol * 1_000_000_000;
              return {
                priceSol,
                mcSol,
                solReserves: val2Sol,
                tokenReserves: val1Tokens,
              };
            }
          }
        } catch {
          continue;
        }
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  /**
   * Remove callback from graduated subscription
   */
  private removeGraduatedCallback(mint: string, callback: (update: HeliusPriceUpdate) => void): void {
    const subscription = this.graduatedSubscriptions.get(mint);
    if (!subscription) return;
    
    const index = subscription.callbacks.indexOf(callback);
    if (index > -1) {
      subscription.callbacks.splice(index, 1);
    }
    
    // If no more callbacks, stop polling
    if (subscription.callbacks.length === 0) {
      if (subscription.intervalId) {
        clearInterval(subscription.intervalId);
      }
      this.graduatedSubscriptions.delete(mint);
      logger.debug(`[HELIUS] Unsubscribed from graduated token ${mint.slice(0, 8)}...`);
    }
  }
  
  /**
   * Check if a graduated token is subscribed
   */
  isGraduatedSubscribed(mint: string): boolean {
    return this.graduatedSubscriptions.has(mint);
  }
  
  /**
   * Disconnect and clean up all subscriptions
   */
  override disconnect(): void {
    // Clean up graduated subscriptions
    for (const [mint, sub] of this.graduatedSubscriptions) {
      if (sub.intervalId) {
        clearInterval(sub.intervalId);
      }
    }
    this.graduatedSubscriptions.clear();
    
    // Call parent disconnect
    super.disconnect();
  }
}

// Export singleton instance
let heliusMonitorInstance: HeliusPriceMonitorExtended | null = null;

export function getHeliusPriceMonitor(): HeliusPriceMonitorExtended {
  if (!heliusMonitorInstance) {
    heliusMonitorInstance = new HeliusPriceMonitorExtended();
  }
  return heliusMonitorInstance;
}

export function resetHeliusPriceMonitor(): void {
  if (heliusMonitorInstance) {
    heliusMonitorInstance.disconnect();
    heliusMonitorInstance = null;
  }
}

/**
 * Derive bonding curve address from mint
 * Uses Pump.fun's PDA derivation
 */
export function deriveBondingCurveAddress(mint: string): string {
  const mintPubkey = new PublicKey(mint);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM_ID)
  );
  return bondingCurve.toBase58();
}
