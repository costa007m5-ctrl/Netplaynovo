import { useState, useEffect, useCallback, useRef } from 'react';

export interface NetworkStats {
  // Conexão
  isOnline: boolean;
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';
  downlink: number; // Mbps
  rtt: number; // Round-trip time em ms
  saveData: boolean;
  
  // Diagnóstico
  latency: number;
  jitter: number;
  packetLoss: number;
  bandwidth: number; // Mbps estimado
  
  // Status
  connectionQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
  isStable: boolean;
  lastCheck: number;
}

export interface NetworkDiagnosticsOptions {
  checkInterval?: number; // ms
  enablePrefetch?: boolean;
  onQualityChange?: (quality: NetworkStats['connectionQuality']) => void;
}

const DEFAULT_STATS: NetworkStats = {
  isOnline: true,
  effectiveType: 'unknown',
  downlink: 10,
  rtt: 50,
  saveData: false,
  latency: 50,
  jitter: 10,
  packetLoss: 0,
  bandwidth: 10,
  connectionQuality: 'good',
  isStable: true,
  lastCheck: Date.now(),
};

/**
 * Hook para diagnóstico e monitoramento de rede em tempo real.
 * Detecta problemas de conexão e ajusta parâmetros de streaming automaticamente.
 */
export function useNetworkDiagnostics(options: NetworkDiagnosticsOptions = {}) {
  const { checkInterval = 10000, enablePrefetch = true, onQualityChange } = options;
  
  const [stats, setStats] = useState<NetworkStats>(DEFAULT_STATS);
  const [history, setHistory] = useState<number[]>([]);
  const lastQualityRef = useRef<NetworkStats['connectionQuality']>('good');
  const checkCountRef = useRef(0);

  // Detecta informações da API Network Information
  const getNetworkInfo = useCallback(() => {
    const connection = (navigator as any).connection || 
                      (navigator as any).mozConnection || 
                      (navigator as any).webkitConnection;
    
    if (connection) {
      return {
        effectiveType: connection.effectiveType || 'unknown',
        downlink: connection.downlink || 10,
        rtt: connection.rtt || 50,
        saveData: connection.saveData || false,
      };
    }
    
    return {
      effectiveType: 'unknown' as const,
      downlink: 10,
      rtt: 50,
      saveData: false,
    };
  }, []);

  // Mede latência real fazendo um ping ao servidor
  const measureLatency = useCallback(async (url?: string): Promise<{ latency: number; success: boolean }> => {
    const testUrl = url || 'https://www.google.com/generate_204';
    const start = performance.now();
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      await fetch(testUrl, {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      const latency = performance.now() - start;
      
      return { latency, success: true };
    } catch {
      return { latency: 9999, success: false };
    }
  }, []);

  // Estima bandwidth baseado em download de pequeno arquivo
  const measureBandwidth = useCallback(async (): Promise<number> => {
    // Usa uma imagem pequena conhecida para teste
    const testUrls = [
      'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png',
    ];
    
    const testUrl = testUrls[0];
    const fileSize = 13504; // bytes aproximados do logo Google
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const start = performance.now();
      const response = await fetch(testUrl, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal,
      });
      
      // Em modo no-cors não conseguimos ler o body, mas o tempo de resposta indica
      const elapsed = (performance.now() - start) / 1000; // segundos
      clearTimeout(timeoutId);
      
      if (elapsed > 0) {
        const bitsPerSecond = (fileSize * 8) / elapsed;
        const mbps = bitsPerSecond / 1000000;
        return Math.min(mbps, 100); // Cap em 100 Mbps
      }
      
      return 10; // Default
    } catch {
      return 1; // Conexão muito lenta ou falhou
    }
  }, []);

  // Calcula jitter baseado no histórico de latências
  const calculateJitter = useCallback((latencies: number[]): number => {
    if (latencies.length < 2) return 0;
    
    let totalDiff = 0;
    for (let i = 1; i < latencies.length; i++) {
      totalDiff += Math.abs(latencies[i] - latencies[i - 1]);
    }
    
    return totalDiff / (latencies.length - 1);
  }, []);

  // Determina qualidade da conexão baseado em métricas
  const determineQuality = useCallback((
    latency: number,
    jitter: number,
    bandwidth: number,
    isOnline: boolean
  ): NetworkStats['connectionQuality'] => {
    if (!isOnline) return 'offline';
    
    // Score baseado em múltiplas métricas
    let score = 100;
    
    // Penalidades por latência
    if (latency > 500) score -= 40;
    else if (latency > 300) score -= 25;
    else if (latency > 150) score -= 10;
    
    // Penalidades por jitter
    if (jitter > 100) score -= 30;
    else if (jitter > 50) score -= 15;
    else if (jitter > 20) score -= 5;
    
    // Penalidades por baixo bandwidth
    if (bandwidth < 1) score -= 40;
    else if (bandwidth < 3) score -= 25;
    else if (bandwidth < 5) score -= 10;
    
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
  }, []);

  // Executa diagnóstico completo
  const runDiagnostics = useCallback(async () => {
    const isOnline = navigator.onLine;
    const networkInfo = getNetworkInfo();
    
    if (!isOnline) {
      setStats(prev => ({
        ...prev,
        isOnline: false,
        connectionQuality: 'offline',
        lastCheck: Date.now(),
      }));
      return;
    }
    
    // Mede latência
    const { latency, success } = await measureLatency();
    
    // Atualiza histórico para calcular jitter
    const newHistory = [...history.slice(-9), latency];
    setHistory(newHistory);
    
    const jitter = calculateJitter(newHistory);
    const packetLoss = success ? 0 : (checkCountRef.current > 0 ? 10 : 0);
    
    // Estima bandwidth (a cada 5 checks para não sobrecarregar)
    let bandwidth = stats.bandwidth;
    if (checkCountRef.current % 5 === 0) {
      bandwidth = await measureBandwidth();
    }
    checkCountRef.current++;
    
    const connectionQuality = determineQuality(latency, jitter, bandwidth, isOnline);
    const isStable = jitter < 30 && packetLoss === 0;
    
    const newStats: NetworkStats = {
      isOnline,
      effectiveType: networkInfo.effectiveType as NetworkStats['effectiveType'],
      downlink: networkInfo.downlink,
      rtt: networkInfo.rtt,
      saveData: networkInfo.saveData,
      latency,
      jitter,
      packetLoss,
      bandwidth,
      connectionQuality,
      isStable,
      lastCheck: Date.now(),
    };
    
    setStats(newStats);
    
    // Notifica mudança de qualidade
    if (connectionQuality !== lastQualityRef.current) {
      lastQualityRef.current = connectionQuality;
      onQualityChange?.(connectionQuality);
    }
  }, [
    getNetworkInfo, measureLatency, measureBandwidth, calculateJitter, 
    determineQuality, history, stats.bandwidth, onQualityChange
  ]);

  // Retorna configuração HLS otimizada baseada na qualidade da conexão
  const getOptimizedHlsConfig = useCallback(() => {
    const { connectionQuality, bandwidth, latency } = stats;
    
    // Configuração base
    const baseConfig = {
      enableWorker: true,
      lowLatencyMode: true,
      startFragPrefetch: true,
      capLevelToPlayerSize: true,
      autoStartLoad: true,
      progressive: true,
      stretchShortVideoTrack: true,
    };
    
    switch (connectionQuality) {
      case 'excellent':
        return {
          ...baseConfig,
          startLevel: -1, // Auto - começa na melhor qualidade
          abrEwmaDefaultEstimate: bandwidth * 1000000,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          maxBufferSize: 60 * 1000 * 1000,
          manifestLoadingTimeOut: 10000,
          fragLoadingTimeOut: 20000,
          maxStarvationDelay: 4,
          maxLoadingDelay: 4,
        };
        
      case 'good':
        return {
          ...baseConfig,
          startLevel: 0,
          abrEwmaDefaultEstimate: Math.min(bandwidth * 1000000, 5000000),
          maxBufferLength: 20,
          maxMaxBufferLength: 40,
          maxBufferSize: 40 * 1000 * 1000,
          manifestLoadingTimeOut: 8000,
          fragLoadingTimeOut: 15000,
          maxStarvationDelay: 3,
          maxLoadingDelay: 3,
        };
        
      case 'fair':
        return {
          ...baseConfig,
          startLevel: 0,
          abrEwmaDefaultEstimate: Math.min(bandwidth * 1000000, 2000000),
          maxBufferLength: 10,
          maxMaxBufferLength: 20,
          maxBufferSize: 20 * 1000 * 1000,
          manifestLoadingTimeOut: 6000,
          fragLoadingTimeOut: 12000,
          maxStarvationDelay: 2,
          maxLoadingDelay: 2,
        };
        
      case 'poor':
      default:
        return {
          ...baseConfig,
          startLevel: 0,
          abrEwmaDefaultEstimate: 500000, // 500kbps
          maxBufferLength: 5,
          maxMaxBufferLength: 10,
          maxBufferSize: 10 * 1000 * 1000,
          manifestLoadingTimeOut: 5000,
          fragLoadingTimeOut: 8000,
          maxStarvationDelay: 1,
          maxLoadingDelay: 1,
          // Configurações mais agressivas para conexões ruins
          manifestLoadingMaxRetry: 8,
          fragLoadingMaxRetry: 8,
          manifestLoadingRetryDelay: 500,
          fragLoadingRetryDelay: 500,
        };
    }
  }, [stats]);

  // Prefetch de URLs para aquecer cache e conexões
  const prefetchUrl = useCallback(async (url: string) => {
    if (!enablePrefetch || !stats.isOnline) return;
    
    try {
      await fetch(url, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        priority: 'high' as RequestPriority,
      });
    } catch {
      // Ignora erros de prefetch
    }
  }, [enablePrefetch, stats.isOnline]);

  // Event listeners para mudanças de conexão
  useEffect(() => {
    const handleOnline = () => runDiagnostics();
    const handleOffline = () => {
      setStats(prev => ({
        ...prev,
        isOnline: false,
        connectionQuality: 'offline',
        lastCheck: Date.now(),
      }));
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Listener para mudanças na Network Information API
    const connection = (navigator as any).connection;
    if (connection) {
      connection.addEventListener('change', runDiagnostics);
    }
    
    // Executa diagnóstico inicial
    runDiagnostics();
    
    // Diagnóstico periódico
    const intervalId = setInterval(runDiagnostics, checkInterval);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (connection) {
        connection.removeEventListener('change', runDiagnostics);
      }
      clearInterval(intervalId);
    };
  }, [runDiagnostics, checkInterval]);

  return {
    stats,
    runDiagnostics,
    getOptimizedHlsConfig,
    prefetchUrl,
    isOnline: stats.isOnline,
    connectionQuality: stats.connectionQuality,
  };
}

export default useNetworkDiagnostics;
