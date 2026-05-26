'use client';

import { memo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wifi, WifiOff, Signal, SignalLow, SignalMedium, SignalHigh, AlertTriangle, Zap } from 'lucide-react';

interface NetworkStats {
  isOnline: boolean;
  effectiveType: '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';
  latency: number;
  bandwidth: number;
  connectionQuality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline';
  isStable: boolean;
}

interface NetworkStatusIndicatorProps {
  stats: NetworkStats;
  show?: boolean;
  compact?: boolean;
  className?: string;
}

const qualityConfig = {
  excellent: {
    icon: SignalHigh,
    color: 'text-green-500',
    bgColor: 'bg-green-500/20',
    borderColor: 'border-green-500/30',
    label: 'Excelente',
    description: 'Conexão estável e rápida',
  },
  good: {
    icon: SignalMedium,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/20',
    borderColor: 'border-blue-500/30',
    label: 'Boa',
    description: 'Conexão adequada para streaming',
  },
  fair: {
    icon: SignalLow,
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/20',
    borderColor: 'border-yellow-500/30',
    label: 'Regular',
    description: 'Pode haver buffering ocasional',
  },
  poor: {
    icon: Signal,
    color: 'text-red-500',
    bgColor: 'bg-red-500/20',
    borderColor: 'border-red-500/30',
    label: 'Fraca',
    description: 'Qualidade reduzida automaticamente',
  },
  offline: {
    icon: WifiOff,
    color: 'text-gray-500',
    bgColor: 'bg-gray-500/20',
    borderColor: 'border-gray-500/30',
    label: 'Offline',
    description: 'Sem conexão com a internet',
  },
};

export const NetworkStatusIndicator = memo(function NetworkStatusIndicator({
  stats,
  show = true,
  compact = false,
  className = '',
}: NetworkStatusIndicatorProps) {
  const config = qualityConfig[stats.connectionQuality];
  const Icon = config.icon;

  if (!show) return null;

  if (compact) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`flex items-center gap-1.5 ${className}`}
        title={`${config.label} - ${config.description}`}
      >
        <Icon size={14} className={config.color} />
        {!stats.isStable && (
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            <AlertTriangle size={12} className="text-yellow-500" />
          </motion.div>
        )}
      </motion.div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className={`
          flex items-center gap-3 px-4 py-2.5 rounded-xl
          ${config.bgColor} ${config.borderColor} border
          backdrop-blur-sm ${className}
        `}
      >
        <div className={`p-1.5 rounded-lg ${config.bgColor}`}>
          <Icon size={18} className={config.color} />
        </div>
        
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-semibold ${config.color}`}>
              {config.label}
            </span>
            {stats.connectionQuality !== 'offline' && (
              <span className="text-xs text-white/50">
                {stats.latency.toFixed(0)}ms
              </span>
            )}
          </div>
          <span className="text-xs text-white/40">
            {config.description}
          </span>
        </div>

        {!stats.isStable && stats.connectionQuality !== 'offline' && (
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="ml-auto"
          >
            <AlertTriangle size={16} className="text-yellow-500" />
          </motion.div>
        )}

        {stats.connectionQuality === 'excellent' && (
          <motion.div
            animate={{ scale: [1, 1.2, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="ml-auto"
          >
            <Zap size={16} className="text-green-400" />
          </motion.div>
        )}
      </motion.div>
    </AnimatePresence>
  );
});

// Componente de toast para mudanças de qualidade
interface NetworkQualityToastProps {
  quality: NetworkStats['connectionQuality'];
  show: boolean;
  onHide: () => void;
}

export const NetworkQualityToast = memo(function NetworkQualityToast({
  quality,
  show,
  onHide,
}: NetworkQualityToastProps) {
  const config = qualityConfig[quality];
  const Icon = config.icon;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 50, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 50, scale: 0.9 }}
          onAnimationComplete={() => {
            setTimeout(onHide, 3000);
          }}
          className={`
            fixed bottom-24 left-1/2 -translate-x-1/2 z-[500]
            flex items-center gap-3 px-5 py-3 rounded-2xl
            ${config.bgColor} ${config.borderColor} border
            backdrop-blur-xl shadow-2xl
          `}
        >
          <Icon size={20} className={config.color} />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white">
              Qualidade da conexão: {config.label}
            </span>
            <span className="text-xs text-white/60">
              {config.description}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

export default NetworkStatusIndicator;
