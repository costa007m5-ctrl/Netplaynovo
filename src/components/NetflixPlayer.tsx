import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Maximize, Minimize, X, ChevronLeft, Settings, Subtitles, FastForward, WifiOff, AlertCircle, Cast, Tv, Share2, Info, Smile, Users, PictureInPicture, ZoomIn, ZoomOut, Lock, Unlock } from 'lucide-react';
import screenfull from 'screenfull';
import Hls from 'hls.js';
import { motion, AnimatePresence } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../lib/supabase';
import { useNetworkDiagnostics } from '../hooks/useNetworkDiagnostics';

interface NetflixPlayerProps {
  src: string;
  title: string;
  seriesTitle?: string;
  movieId?: string | number;
  backdropUrl?: string; // Backdrop image (landscape)
  posterUrl?: string;   // Poster image (portrait)
  logoUrl?: string;     // Movie logo PNG
  onClose: () => void;
  onProgress?: (currentTime: number, duration?: number) => void;
  initialTime?: number;
  onNextEpisode?: () => void;
  hasNextEpisode?: boolean;
  isMovie?: boolean;
  recommendations?: any[];
  onSelectRecommendation?: (movie: any) => void;
  onSwitchPlayer?: () => void;
  subtitleUrl?: string;
  videoUrlOptions?: { id: string; label: string; url: string }[];
  isHost?: boolean;
  roomId?: string;
  profile?: any;
  maxQualityHeight?: number;
  isBackgroundMode?: boolean;
  onClickBackground?: () => void;
  autoNextOffset?: number;
  episodes?: any[];
  onSelectEpisode?: (episode: any) => void;
}

const NetflixPlayer: React.FC<NetflixPlayerProps> = ({ 
  src, 
  title, 
  seriesTitle,
  movieId,
  backdropUrl,
  posterUrl,
  logoUrl,
  onClose, 
  onProgress, 
  initialTime = 0,
  onNextEpisode,
  hasNextEpisode,
  isMovie = false,
  recommendations = [],
  onSelectRecommendation,
  onSwitchPlayer,
  subtitleUrl,
  videoUrlOptions = [],
  isHost = true,
  roomId = null,
  profile,
  maxQualityHeight,
  isBackgroundMode = false,
  onClickBackground,
  autoNextOffset,
  episodes = [],
  onSelectEpisode
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  
  const isIframeMode = useMemo(() => {
    if (!src) return false;
    const lowerSrc = src.toLowerCase();

    // Links agregadores com video_url/subtitle_url funcionam melhor no player nativo
    // para dar autoplay real (clicou, começou) e permitir retry/proxy interno.
    if (lowerSrc.includes('video_url=')) {
      return false;
    }

    return false;
  }, [src]);

  const wrapWithProxy = useCallback((rawUrl?: string | null) => {
    if (!rawUrl) return rawUrl || '';
    try {
      const decoded = decodeURIComponent(rawUrl).replace(/&amp;/g, '&');
      const lower = decoded.toLowerCase();
      const needsProxy =
        lower.includes('.m3u8') &&
        (lower.includes('teradl.kingx.dev') || lower.includes('kingx.dev'));

      if (!needsProxy || decoded.startsWith('/api/proxy/m3u8')) return decoded;
      return `/api/proxy/m3u8?url=${encodeURIComponent(decoded)}`;
    } catch {
      return rawUrl;
    }
  }, []);

  // Robust Extraction of nested URLs (KingX, Terabox, etc.)
  const parsedUrls = useMemo(() => {
    if (isIframeMode) return { video_url: src, subtitle_url: subtitleUrl };

    let vToPlay = src;
    let sToPlay = subtitleUrl;
    
    try {
      if (src && src.includes('video_url=')) {
        const urlObj = new URL(src, window.location.origin);
        
        // 1. Try standard searchParams
        let v = urlObj.searchParams.get('video_url');
        let sub = urlObj.searchParams.get('subtitle_url');
        
        // 2. Try hashParams if not found
        if (!v && urlObj.hash && urlObj.hash.includes('video_url=')) {
           let hashStr = urlObj.hash.substring(1);
           // Remove prefix se o hash for formatado estranho (ex: #/nav?video_url=...)
           if (hashStr.startsWith('/') && hashStr.includes('?')) {
             hashStr = hashStr.substring(hashStr.indexOf('?') + 1);
           }
           
           // Se a hash string não for urlencoded corretamente e tiver um link cru ali:
           // A classe URLSearchParams pode engolir parâmetros do link embeddado se houver múltiplos '&'.
           // Para extrair manual de string bruta de forma segura sem ser corrompido:
           const vMatch = hashStr.match(/video_url=([^&]+(?:&[^&]+)*?)(?:&subtitle_url=|$)/);
           if (vMatch && vMatch[1]) {
             v = decodeURIComponent(vMatch[1]).replace(/&amp;/g, '&');
           } else {
             // Fallback
             const hashParams = new URLSearchParams(hashStr);
             v = hashParams.get('video_url');
           }
           
           const subMatch = hashStr.match(/subtitle_url=([^&]+(?:&[^&]+)*?)(?:&video_url=|$)/);
           if (subMatch && subMatch[1]) {
              sub = decodeURIComponent(subMatch[1]).replace(/&amp;/g, '&');
           } else {
              const hashParams = new URLSearchParams(hashStr);
              sub = hashParams.get('subtitle_url') || sub;
           }
        }
        
        // 3. Fallback regex se tudo falhar - extraindo de forma mais robusta sem quebrar nos '&' do streaming embeddado
        if (!v) {
          const matchVid = src.match(/(?:[?&#])video_url=(https?[^&]+(?:&[^&]+)*?)(?:&subtitle_url=|$)/i);
          if (matchVid && matchVid[1]) {
             v = decodeURIComponent(matchVid[1]);
          }
        }
        
        if (v) vToPlay = wrapWithProxy(v);
        if (sub) sToPlay = wrapWithProxy(sub);
      }
      vToPlay = wrapWithProxy(vToPlay);
      sToPlay = wrapWithProxy(sToPlay);
      console.log('URL EXTRACTED:', vToPlay);
    } catch (e) {
      console.warn("URL Extraction failed", e);
    }
    
    return { video_url: vToPlay, subtitle_url: sToPlay };
  }, [isIframeMode, src, subtitleUrl, wrapWithProxy]);

  const [activeSrc, setActiveSrc] = useState(parsedUrls.video_url);
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState(parsedUrls.subtitle_url);
  const [sessionKey, setSessionKey] = useState(() => Date.now());
  
  // Classificação indicativa local e estática para não quebrar dependências externas
  const ageRating = useMemo(() => {
    const ratings = ['L', '10', '12', '14', '16', '18'];
    let hash = 0;
    const str = title + (movieId || '');
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % ratings.length;
    return ratings[index];
  }, [title, movieId]);

  const [showAgeRating, setShowAgeRating] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setShowAgeRating(false), 8000);
    return () => clearTimeout(t);
  }, []);

  // Independent Mode Detection
  const playerMode = useMemo(() => (initialTime > 0 ? 'resume' : 'fresh'), [initialTime]);

  const toggleReparar = useCallback(() => {
    // Destroy existing HLS instance to ensure clean slate
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (e) {}
      hlsRef.current = null;
    }
    // Reset video element
    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      } catch (e) {}
    }
    // Reset all state for fresh retry
    setSessionKey(Date.now());
    setShowStuckButton(false);
    setError(null);
    setIsLoading(true);
    resetProgress();
    setProgressTarget(15);
    hasStartedPlayedRef.current = false;
    retryCountRef.current = 0;
    autoRepairAttemptRef.current = 0;
    lastProgressCheckRef.current = 0;
  }, []);

  // Sincroniza activeSrc apenas se a prop src mudar externamente.
  // Usado quando o usuário troca de episódio sem desmontar o player —
  // resetamos o estado de playback para evitar que o HLS antigo trave o novo.
  useEffect(() => {
    if (parsedUrls.video_url !== activeSrc) {
      // Destrói qualquer instância de HLS pendente ANTES de mudar o src
      // para evitar que requisições antigas conflitem com as novas (causa do stuck em 25%).
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch (e) {}
        hlsRef.current = null;
      }
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch (e) {}
      }
      setActiveSrc(parsedUrls.video_url);
      setActiveSubtitleUrl(parsedUrls.subtitle_url);
      setSessionKey(Date.now());
      setShowStuckButton(false);
      // Reseta estados de progresso para o novo conteúdo
      setCurrentTime(0);
      setDuration(0);
      setBufferedPercentage(0);
      setIsPlaying(false);
      setIsBuffering(false);
      setError(null);
      setErrorRetryCount(0);
      setErrorRetryCountdown(null);
      setIsLoading(true);
      resetProgress();
      hasStartedPlayedRef.current = false;
      retryCountRef.current = 0;
      lastTimeRef.current = 0;
      recsTargetTimeRef.current = null;
      recsDismissedRef.current = false;
    }
  }, [parsedUrls.video_url, parsedUrls.subtitle_url]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(isBackgroundMode);
  const [showControls, setShowControls] = useState(false); // Hidden by default on entry
  const [isLocked, setIsLocked] = useState(false);
  const [showUnlockOverlay, setShowUnlockOverlay] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isLoadingState, setIsLoadingStateRaw] = useState(true);
  const isLoadingRef = useRef(true);
  // Wrapper que sincroniza state + ref para leituras em tempo real
  const setIsLoading = (val: boolean) => {
    isLoadingRef.current = val;
    setIsLoadingStateRaw(val);
  };
  const isLoading = isLoadingState; // alias para compatibilidade
  const [isBuffering, setIsBuffering] = useState(false);

  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessageIndex, setLoadingMessageIndex] = useState(0);

  // Animador suave 0→100 do loading. Mantemos um "target" e um timer
  // que avança gradualmente, evitando saltos bruscos (25% → tela de play).
  const targetProgressRef = useRef(0);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopProgressAnimation = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };
  const startProgressAnimation = () => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = setInterval(() => {
      setLoadingProgress((prev) => {
        const target = targetProgressRef.current;
        if (prev >= target) return prev;
        const diff = target - prev;
        // Avanço rápido: alcança o target em poucos ticks para evitar
        // sensação de barra "presa" entre marcos do HLS.
        const step = diff > 40 ? 12 : diff > 15 ? 6 : diff > 5 ? 3 : 1;
        return Math.min(prev + step, target);
      });
    }, 30);
  };
  const loadingProgressRef = useRef(0);
  const setProgressTarget = (value: number) => {
    targetProgressRef.current = Math.max(targetProgressRef.current, Math.min(100, value));
    startProgressAnimation();
  };
  // Sincroniza a ref com o state para leituras em tempo real dentro de closures
  useEffect(() => {
    loadingProgressRef.current = loadingProgress;
  }, [loadingProgress]);
  const resetProgress = () => {
    stopProgressAnimation();
    targetProgressRef.current = 0;
    setLoadingProgress(0);
  };
  const completeProgress = () => {
    targetProgressRef.current = 100;
    setLoadingProgress(100);
    stopProgressAnimation();
  };
  // Limpa o timer do animador quando o componente é desmontado
  useEffect(() => {
    return () => stopProgressAnimation();
  }, []);

  const [showStuckButton, setShowStuckButton] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [error, setError] = useState<{ message: string; type: 'network' | 'format' | 'unknown' } | null>(null);
  const [errorRetryCount, setErrorRetryCount] = useState(0);
  const [errorRetryCountdown, setErrorRetryCountdown] = useState<number | null>(null);
  const [bufferedPercentage, setBufferedPercentage] = useState(0);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // Sync background mode changes
  useEffect(() => {
    setIsMuted(!!isBackgroundMode);
    if (!isBackgroundMode) {
      setShowControls(true);
      resetControlsTimer(true);
      // tentar full screen nativo ao sair do modo background
      if (containerRef.current && screenfull.isEnabled) {
        screenfull.request(containerRef.current).catch(() => {});
      }
    }
  }, [isBackgroundMode]);
  const [hoverPosition, setHoverPosition] = useState<number>(0);
  const [showRecsOverlay, setShowRecsOverlay] = useState(false);
  const [showEpisodesSidebar, setShowEpisodesSidebar] = useState(false);
  const [activeSeason, setActiveSeason] = useState(1);
  const [showTvShare, setShowTvShare] = useState(false);
  const [showLogoOverlay, setShowLogoOverlay] = useState(false);
  const [showAutoNext, setShowAutoNext] = useState(false);
  const showSkipIntro = hasNextEpisode !== undefined && currentTime >= 10 && currentTime <= 180;
  const [autoNextCounter, setAutoNextCounter] = useState(10);
  const [isLandscape, setIsLandscape] = useState(false);
  const [qualityLevels, setQualityLevels] = useState<{ id: number; height: number; bitrate: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState<string>(() => {
    return localStorage.getItem('lastQuality') || 'Auto';
  });
  const [isAutoQuality, setIsAutoQuality] = useState(true);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [canCast, setCanCast] = useState(false);
  const [isCasting, setIsCasting] = useState(false);
const [qualityToast, setQualityToast] = useState<string | null>(null);
  
  // Hook de diagnóstico de rede para otimização adaptativa
  // Nota: callback removido para evitar re-renders durante loading
  const { getOptimizedHlsConfig } = useNetworkDiagnostics({
    checkInterval: 60000, // Verifica a cada 60s (menos frequente para evitar interferência)
    enablePrefetch: false,
  });
  
  const [autoRotate, setAutoRotate] = useState(() => {
  const saved = localStorage.getItem('autoRotate');
  return saved !== null ? JSON.parse(saved) : true;
  });
  const [objectFit, setObjectFit] = useState<'contain' | 'cover'>('contain');
  const [emotes, setEmotes] = useState<{ id: string | number; emoji: string; x: number; y: number; profileName?: string }[]>([]);
  const [showEmotePicker, setShowEmotePicker] = useState(false);
  const [roomUsers, setRoomUsers] = useState<any[]>([]);
  const channelRef = useRef<any>(null);
  const clientIdRef = useRef(Math.random().toString(36).substring(2, 10));
  const lastProgressTime = useRef(0);
  
  const EMOTES = ['🔥', '😂', '😱', '😍', '😢', '👏', '👎', '❓', '🍿', '😮', '💀', '🤡'];

  const seasons = useMemo(() => {
    if (!episodes || episodes.length === 0) return [];
    return Array.from(new Set(episodes.map(e => e.season))).sort((a, b) => a - b);
  }, [episodes]);

  useEffect(() => {
    if (episodes && episodes.length > 0 && activeSrc) {
       const currentEq = episodes.find(e => e.videoUrl === activeSrc || e.videoUrl2 === activeSrc);
       if (currentEq) {
          setActiveSeason(currentEq.season);
       } else {
          setActiveSeason(seasons[0] || 1);
       }
    }
  }, [activeSrc, episodes, seasons]);

  const isMedianApp = () => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('median') || ua.includes('gonative');
  };

  const setMedianOrientation = (orientation: 'landscape' | 'portrait' | 'unlocked') => {
    try {
      if (typeof window !== 'undefined' && isMedianApp()) {
        if ((window as any).median) {
          (window as any).median.screen.setOrientation({orientation});
        } else if ((window as any).gonative) {
          (window as any).gonative.screen.setOrientation({orientation});
        } else {
          window.location.href = `median://screen/setOrientation?orientation=${orientation}`;
        }
      }
    } catch(e) {}
  };

  useEffect(() => {
    if (roomId && profile) {
      const channel = supabase.channel(`room:${roomId}`, {
        config: {
          broadcast: {
            ack: true,
          },
          presence: {
            key: clientIdRef.current,
          },
        },
      });

      channelRef.current = channel;

      let syncInterval: any;

      channel
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState();
          const users = Object.values(state).flat().map((p: any) => ({
            id: p.profileId,
            profileName: p.profileName,
            avatar: p.avatar
          }));
          
          const uniqueUsers = Array.from(new Map(users.map(item => [item.profileName, item])).values());
          setRoomUsers(uniqueUsers);
        })
        .on('broadcast', { event: 'room_event' }, ({ payload }) => {
          if (payload.sender_id === clientIdRef.current) return;

          switch (payload.type) {
            case 'sync_host':
              if (!isHost && videoRef.current) {
                const diff = Math.abs(videoRef.current.currentTime - payload.currentTime);
                // Tolerates up to 4 seconds of mismatch
                if (diff > 4) {
                  videoRef.current.currentTime = payload.currentTime;
                }
                if (payload.playing && videoRef.current.paused) {
                  // Only try to play if we have enough data to at least start
                  videoRef.current.play().catch(() => {});
                } else if (!payload.playing && !videoRef.current.paused) {
                  videoRef.current.pause();
                }
              }
              break;
            case 'play':
              if (videoRef.current && videoRef.current.paused) videoRef.current.play().catch(() => {});
              break;
            case 'pause':
              if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
              break;
            case 'seek':
              if (videoRef.current) {
                videoRef.current.currentTime = payload.time;
              }
              break;
            case 'emote':
              const x = 20 + Math.random() * 60;
              const y = 20 + Math.random() * 60;
              const id = Math.random();
              setEmotes(prev => [...prev, { id, emoji: payload.emoji, x, y, profileName: payload.profileName }]);
              setTimeout(() => {
                setEmotes(prev => prev.filter(e => e.id !== id));
              }, 3000);
              break;
          }
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            await channel.track({
              profileId: profile.id || 'anonymous',
              profileName: profile.name || 'Usuário',
              avatar: profile.avatar_url,
              joined_at: new Date().toISOString(),
            });

            if (isHost && !syncInterval) {
              syncInterval = setInterval(() => {
                if (videoRef.current) {
                  channel.send({
                    type: 'broadcast',
                    event: 'room_event',
                    payload: { 
                      type: 'sync_host', 
                      playing: !videoRef.current.paused, 
                      currentTime: videoRef.current.currentTime,
                      sender_id: clientIdRef.current 
                    }
                  }).catch(() => {});
                }
              }, 3000);
            }
          }
        });

      return () => {
        if (syncInterval) clearInterval(syncInterval);
        channel.unsubscribe();
      };
    }
  }, [roomId, isHost, profile, movieId]);

  // Configuração inicial quando liga o componente
  useEffect(() => {
    if (videoRef.current) {
      // Ativa Picture-in-Picture automático para Chromium (ex: quando o app fica em segundo plano/muda de aba)
      try {
        if ('autoPictureInPicture' in videoRef.current) {
          (videoRef.current as any).autoPictureInPicture = true;
        }
        (videoRef.current as any).disablePictureInPicture = false;
      } catch (e) {
         console.warn("PiP feature check:", e);
      }
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (!videoRef.current) return;
      
      try {
        if (document.hidden) {
          // Quando a aba/app ficar oculta, tentar ativar o PiP
          // Apenas se o vídeo estiver tocando
          if (!videoRef.current.paused && document.pictureInPictureEnabled) {
            // Em navegadores que suportam autoPictureInPicture, isso já será tratado nativamente.
            // Aqui estamos apenas tentando forçar caso seja possível nativamente.
            // Ignoraremos o erro de permissão.
            if (!(videoRef.current as any).autoPictureInPicture) {
                await videoRef.current.requestPictureInPicture();
            }
          }
        } else {
          // Quando voltar para a aba, sair do PiP se estiver ativo
          // Para navegadores com autoPictureInPicture nativo, ele geralmente sai automaticamente,
          // Então verificaremos.
          if (document.pictureInPictureElement) {
             await document.exitPictureInPicture();
          }
        }
      } catch (error: any) {
        // Ignora erro de "user gesture required" (comportamento nativo bloqueado)
        if (error.name !== 'NotAllowedError') {
           console.warn('Erro ao processar Picture-in-Picture:', error);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  const sendEmote = (emote: string) => {
    if (channelRef.current && roomId) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'room_event',
        payload: { type: 'emote', emoji: emote, profileName: profile?.name, sender_id: clientIdRef.current }
      }).catch((e: Error) => console.error("Emote broadcast err:", e));
    }
    
    // Always show locally immediately for instant feedback
    const x = 20 + Math.random() * 60;
    const y = 20 + Math.random() * 60;
    const id = Math.random();
    setEmotes(prev => [...prev, { id, emoji: emote, x, y, profileName: profile?.name }]);
    setTimeout(() => {
      setEmotes(prev => prev.filter(e => e.id !== id));
    }, 3000);
    
    setShowEmotePicker(false);
    resetControlsTimer();
  };

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 2;
  const hasSeekedRef = useRef(false);

  const resetControlsTimer = useCallback((forceShow = false) => {
    // Se o player estiver bloqueado e não estivermos forçando a exibição do cadeado (ex: botão de unlock)
    // então não mostramos os controles de reprodução (nesse caso `showControls` não deve ser true para o UI normal).
    if (isLocked && !forceShow) {
      return; 
    }
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
      setShowSpeedMenu(false);
      setShowSettingsMenu(false);
      setShowQualityMenu(false);
      setShowEmotePicker(false);
    }, 5000); // 5s timeout as requested
  }, [isLocked]);

  const handleMouseMove = () => {
    resetControlsTimer(false);
  };

  const toggleRotation = () => {
    const newState = !autoRotate;
    setAutoRotate(newState);
    localStorage.setItem('autoRotate', JSON.stringify(newState));
  };

  const loadingFacts = useMemo(() => {
    const facts = [
      `Conectando a ${title || 'este filme'}...`,
      "Ajustando configurações de servidor...",
      "Preparando a melhor resolução possível...",
      "Baixando os primeiros fragmentos de vídeo...",
      "Conectando ao cluster mais próximo...",
      "Sincronizando áudio e vídeo..."
    ];
    return facts.sort(() => Math.random() - 0.5); // Shuffle
  }, [title]);

  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      setLoadingMessageIndex(prev => (prev + 1) % loadingFacts.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isLoading, loadingFacts.length]);

  const hasStartedPlayedRef = useRef(false);
  const recsDismissedRef = useRef(false);
  const recsDismissedTimeRef = useRef<number | null>(null);
  const recsTargetTimeRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    let timer: any;
    if (!hasStartedPlayedRef.current && !isPlaying && loadingProgress === 100) {
      // (10 segundos a partir de chegar em 100% se ainda não estiver tocando)
      timer = setTimeout(() => {
        // Só mostra se ainda não tocou
        if (!hasStartedPlayedRef.current) {
          setShowStuckButton(true);
        }
      }, 10000);
    } else {
      setShowStuckButton(false);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, loadingProgress]);

  useEffect(() => {
    if (isIframeMode) {
       // O isLoading e afins serão gerenciados pelo onLoad do iframe
       return;
    }

    const video = videoRef.current;
    if (!video) return;

    // Reset state
    setError(null);
    setIsLoading(true);
    resetProgress();
    // Inicia logo o crawl até 15% para dar feedback imediato ao clique
    setProgressTarget(15);
    retryCountRef.current = 0;
    const initPlayer = () => {
      if (!video) return;

      // CLEANUP INDEPENDENTE
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      try {
        video.pause();
        video.currentTime = 0;
        video.removeAttribute('src');
        video.load();
      } catch (e) {}

      const videoToPlay = activeSrc;
      if (!videoToPlay) return;

const lowerSrc = videoToPlay.toLowerCase();
      let startLoadTimer: NodeJS.Timeout;
      
      // PREFETCH: Inicia o download do manifesto em paralelo enquanto prepara o player
      // Isso aquece o cache do navegador e os proxies/CDNs
      if (lowerSrc.includes('.m3u8')) {
        try {
          // Fetch com alta prioridade para aquecer cache e conexão
          fetch(videoToPlay, { 
            method: 'GET', 
            mode: 'cors',
            credentials: 'omit',
            priority: 'high' as RequestPriority,
            cache: 'no-store' // Força requisição fresca para aquecer proxy
          }).catch(() => {}); // Ignora erros - é apenas prefetch
        } catch (e) {}
      }
      
      const initUnifiedMode = () => {
  if (!isMounted || !video) return;
  setProgressTarget(30);
        
        const startPoint = initialTime > 0 ? Math.max(0, initialTime - 2) : -1;
        
        if (lowerSrc.includes('.m3u8')) {
          const canPlayNative = video.canPlayType('application/vnd.apple.mpegurl') !== '';
          const isIOS = /iP(hone|od|ad)/i.test(navigator.userAgent);
          
if (Hls.isSupported() && !isIOS) {
  // Obtém configuração otimizada baseada na qualidade atual da rede
  const networkOptimizedConfig = getOptimizedHlsConfig();
  
  // Configuração híbrida: usa valores agressivos para início rápido
  // mas permite que a rede influencie buffers e timeouts
  const hls = new Hls({
  // Configurações base para início rápido
  enableWorker: true,
  lowLatencyMode: true,
  startFragPrefetch: true,
  capLevelToPlayerSize: true,
  autoStartLoad: true,
  // startLevel: 0 → começa pela QUALIDADE MAIS BAIXA (menor fragmento, download rápido)
  startLevel: 0,
  // Estima bandwidth baseado na qualidade da rede detectada
  abrEwmaDefaultEstimate: networkOptimizedConfig.abrEwmaDefaultEstimate || 2000000,
  // Fatores ABR agressivos para subir qualidade rapidamente
  abrEwmaFastLive: 2.0,
  abrEwmaSlowLive: 4.0,
  abrEwmaFastVoD: 2.0,
  abrEwmaSlowVoD: 4.0,
  testBandwidth: false,
  startPosition: startPoint > 0 ? startPoint : -1,
  // Buffer inicial mínimo para começar rápido, depois adapta baseado na rede
  maxBufferLength: Math.max(2, networkOptimizedConfig.maxBufferLength || 2),
  maxMaxBufferLength: networkOptimizedConfig.maxMaxBufferLength || 30,
  backBufferLength: 0,
  maxBufferSize: networkOptimizedConfig.maxBufferSize || 30 * 1000 * 1000,
  maxBufferHole: 0.8,
  // Timeouts mais tolerantes para proxies que demoram a inicializar (ex: kingx.dev)
  manifestLoadingMaxRetry: networkOptimizedConfig.manifestLoadingMaxRetry || 8,
  levelLoadingMaxRetry: networkOptimizedConfig.levelLoadingMaxRetry || 8,
  fragLoadingMaxRetry: networkOptimizedConfig.fragLoadingMaxRetry || 8,
  manifestLoadingRetryDelay: networkOptimizedConfig.manifestLoadingRetryDelay || 500,
  levelLoadingRetryDelay: networkOptimizedConfig.levelLoadingRetryDelay || 500,
  fragLoadingRetryDelay: networkOptimizedConfig.fragLoadingRetryDelay || 300,
  manifestLoadingTimeOut: networkOptimizedConfig.manifestLoadingTimeOut || 15000, // 15s para manifesto
  levelLoadingTimeOut: networkOptimizedConfig.levelLoadingTimeOut || 15000,
  fragLoadingTimeOut: networkOptimizedConfig.fragLoadingTimeOut || 20000, // 20s para fragmentos
  // Delays adaptativos baseados na rede
  maxStarvationDelay: networkOptimizedConfig.maxStarvationDelay || 1,
  maxLoadingDelay: networkOptimizedConfig.maxLoadingDelay || 1,
  nudgeMaxRetry: 5,
  nudgeOffset: 0.2,
  highBufferWatchdogPeriod: 0.5,
  stretchShortVideoTrack: true,
  progressive: true,
            });
            hls.attachMedia(video);
            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
              setProgressTarget(20);
              hls.loadSource(videoToPlay);
            });
            hls.on(Hls.Events.MANIFEST_LOADING, () => {
              setProgressTarget(30);
            });
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
              let parsedLevels = data.levels.map((l, i) => ({ id: i, height: l.height, bitrate: l.bitrate })).sort((a, b) => b.height - a.height);
              setQualityLevels(parsedLevels);
              setProgressTarget(45);
              
              if (video) {
                 video.play().catch(e => { 
                   console.warn("Autoplay block", e); 
                   setAutoplayBlocked(true); 
                   setShowControls(true); 
                   setIsPlaying(false);
                   // Se autoplay foi bloqueado, esconde o loading para mostrar o botão de play
                   completeProgress();
                   setIsLoading(false);
                   setShowLogoOverlay(false);
                 });
              }
            });
            // Progresso real baseado em eventos do HLS.js
            // FRAG_LOADING → começou a baixar primeiro fragmento (45→60)
            // FRAG_LOADED → terminou (60→85)
            // FRAG_BUFFERED → bufferizado (85→95)
            hls.on(Hls.Events.FRAG_LOADING, () => {
              setProgressTarget(Math.max(targetProgressRef.current, 60));
            });
            hls.on(Hls.Events.FRAG_LOADED, () => {
              setProgressTarget(Math.max(targetProgressRef.current, 85));
            });
            hls.on(Hls.Events.FRAG_BUFFERED, () => {
              setProgressTarget(Math.min(95, Math.max(targetProgressRef.current, 92)));
            });

            hls.on(Hls.Events.ERROR, (event, data) => {
              console.warn("HLS Error:", data);
              if (data.fatal) {
                 console.error("FATAL HLS ERROR DETAILS:", { type: data.type, details: data.details, response: data.response });
                 if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                   // Fail fast for 403 Forbidden or 404 Not Found as retrying won't help
                   if (data.response?.code === 403 || data.response?.code === 404) {
                     setError({ message: "Link expirado ou acesso negado. Feche e tente reproduzir novamente ou escolha outro player.", type: 'format' });
                     setIsLoading(false);
                     return;
                   }
                   // Proxies como kingx.dev/teradl podem precisar de mais tempo para inicializar
                   // Aumentamos para 20 tentativas com delays mais longos
                   const MAX_RETRIES = 20;
                   if (retryCountRef.current < MAX_RETRIES) { 
                     retryCountRef.current++;
                     // Atualiza progresso visual para mostrar que está tentando
                     const progressIncrease = Math.min(5, (100 - targetProgressRef.current) / (MAX_RETRIES - retryCountRef.current + 1));
                     setProgressTarget(Math.min(95, targetProgressRef.current + progressIncrease));
                     
                     // Delay mais longo para dar tempo ao proxy: 500ms, 1s, 1.5s, 2s, 2.5s, 3s (max)
                     const retryDelay = Math.min(500 + (retryCountRef.current * 500), 3000);
                     console.log(`[v0] HLS retry ${retryCountRef.current}/${MAX_RETRIES} em ${retryDelay}ms`);
                     
                     setTimeout(() => {
                       // Reload source completely if manifest failed to load, else try to recover chunks
                       if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || 
                           data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
                           hls.loadSource(videoToPlay);
                       } else {
                           hls.startLoad();
                       }
                     }, retryDelay);
                   } else {
                     setError({ message: "Não foi possível conectar ao servidor de vídeo após várias tentativas. Tente outro player ou verifique se o link ainda é válido.", type: 'format' });
                     setIsLoading(false);
                   }
                 }
                 else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                   hls.recoverMediaError();
                 }
                 else {
                   setError({ message: "Ocorreu um erro no player. O formato de vídeo pode não ser suportado.", type: 'network' });
                   setIsLoading(false);
                 }
              }
            });
            hlsRef.current = hls;
          } else if (canPlayNative) {
            video.src = videoToPlay;
            video.load();
            video.addEventListener('loadedmetadata', () => {
              let safeStartPoint = startPoint;
              if (safeStartPoint > 0) {
                const duration = video.duration || 0;
                const threshold = isMovie ? 450 : 30;
                if (duration > 0 && safeStartPoint >= duration - threshold) { safeStartPoint = 0; }
                video.currentTime = safeStartPoint;
              }
            }, { once: true });
            video.play().catch(e => { console.warn("Autoplay block", e); setAutoplayBlocked(true); setShowControls(true); setIsPlaying(false); });
          }
        } else {
          video.src = videoToPlay;
          video.load();
          video.addEventListener('loadedmetadata', () => {
               let safeStartPoint = startPoint;
               if (safeStartPoint > 0) {
                 const duration = video.duration || 0;
                 const threshold = isMovie ? 450 : 30;
                 if (duration > 0 && safeStartPoint >= duration - threshold) { safeStartPoint = 0; }
                 video.currentTime = safeStartPoint;
               }
          }, { once: true });
          video.play().catch(e => { console.warn("Autoplay block", e); setAutoplayBlocked(true); setShowControls(true); setIsPlaying(false); });
        }
      };

      // EXECUÇÃO IMEDIATA
      initUnifiedMode();

      return () => {
        clearTimeout(startLoadTimer);
      };
    };

    // Adicionar listeners ANTES de carregar o vídeo
    const handleTimeUpdate = () => {
      const time = video.currentTime;
      setCurrentTime(time);
      if (onProgress) {
        if (Math.abs(time - lastProgressTime.current) >= 10) {
           onProgress(time, video.duration);
           lastProgressTime.current = time;
        }
      }

      const didSeek = Math.abs(time - lastTimeRef.current) > 2;
      lastTimeRef.current = time;

// O vídeo já está renderizando frames — empurra o target para 100 e esconde loading.
  // Condição AGRESSIVA: esconde loading assim que tiver qualquer progresso
  // readyState >= 2 (HAVE_CURRENT_DATA) já é suficiente para mostrar o vídeo
  if (time > 0.05 && video.readyState >= 2 && !video.seeking && !video.paused) {
  if (isLoadingRef.current) {
  completeProgress();
  setIsLoading(false);
  setShowLogoOverlay(false);
  }
  }

      if (video.duration > 0) {
        const timeFromEnd = video.duration - time;
        if (hasNextEpisode) {
          const triggerTime = autoNextOffset !== undefined ? autoNextOffset : 120;
          if (timeFromEnd <= triggerTime && timeFromEnd > 0) {
            setShowAutoNext(true);
            const countdownSeconds = Math.min(15, triggerTime);
            if (recsTargetTimeRef.current === null || didSeek) {
               recsTargetTimeRef.current = time + countdownSeconds;
            }
            const nextCounter = Math.max(0, Math.ceil(recsTargetTimeRef.current - time));
            setAutoNextCounter(nextCounter);
            // Automatic switch to next episode at 0
            if (nextCounter === 0 && onNextEpisode) {
               onNextEpisode();
            }
          } else {
            setShowAutoNext(false);
            recsTargetTimeRef.current = null;
          }
        }

        if (!hasNextEpisode) {
          if (timeFromEnd <= 440 && timeFromEnd > 0) {
            if (recsDismissedRef.current && recsDismissedTimeRef.current !== null && time > recsDismissedTimeRef.current + 40) {
               recsDismissedRef.current = false;
               recsTargetTimeRef.current = null;
            }
            if (!recsDismissedRef.current) {
              setShowRecsOverlay(true);
              if (recsTargetTimeRef.current === null || didSeek) {
                 recsTargetTimeRef.current = time + 15;
              }
              const nextCounter = Math.max(0, Math.ceil(recsTargetTimeRef.current - time));
              setAutoNextCounter(nextCounter);
              // Automatic switch to first recommendation at 0
              if (nextCounter === 0 && onSelectRecommendation && recommendations && recommendations.length > 0) {
                 onSelectRecommendation(recommendations[0]);
              }
            }
          } else {
            if (timeFromEnd > 440) {
              setShowRecsOverlay(false);
              recsDismissedRef.current = false;
              recsTargetTimeRef.current = null;
            }
          }
        }
      }
    };

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      if (!hlsRef.current) {
        setCurrentQuality(getQualityLabel(video.videoHeight));
      }
    };

    const handleCanPlay = () => {
      // O vídeo está pronto para tocar — empurra o target para 95%.
      setProgressTarget(95);
      
      // Se já estava tocando antes (ex: seek, buffering), esconde loading imediatamente
      if (hasStartedPlayedRef.current) {
        completeProgress();
        setIsLoading(false);
        setShowLogoOverlay(false);
      }

      if (video.paused) {
        // Only autoplay if we are host, OR if we are not in a room, OR if we are supposed to be playing.
        // Actually, if we are a guest, wait for playback-update to tell us to play. If we try to play automatically, we break the host's pause state.
        if (!roomId || isHost) {
          video.play().catch(err => {
            console.warn("Autoplay blocked:", err);
            completeProgress();
            setIsLoading(false);
            setShowLogoOverlay(false);
            setShowControls(true);
            setIsPlaying(false);
          });
        }
      }
    };

    const handlePause = () => {
      setIsPlaying(false);
      // Only dismiss loading/buffering if the video was already playing
      // Avoids the loading overlay blinking out on initial forced pauses.
      if (hasStartedPlayedRef.current) {
        setIsBuffering(false);
      }
      if (isHost && channelRef.current && roomId) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'room_event',
          payload: { type: 'pause', sender_id: clientIdRef.current }
        }).catch(() => {});
      }
    };

  const handleCanPlayThrough = () => {
  // canplaythrough = pode reproduzir até o fim sem parar
  completeProgress();
  setIsLoading(false);
  setShowLogoOverlay(false);
  };

  const handleWaiting = () => {
  // Durante a carga inicial (antes do vídeo começar a tocar pela primeira vez),
  // o overlay de loading principal já cobre a tela — não exibimos o spinner
  // de buffering pequeno por cima dele.
  if (!hasStartedPlayedRef.current) return;
  // Evita mostrar buffering se já houver buffer suficiente à frente
  if (video.buffered.length > 0) {
  const bufferedEnd = video.buffered.end(video.buffered.length - 1);
  if (bufferedEnd > video.currentTime + 1.5) return;
  }
  setIsBuffering(true);
  };

const handlePlaying = () => {
  hasStartedPlayedRef.current = true;
  // O vídeo começou a reproduzir — esconde loading IMEDIATAMENTE
  // Prioriza mostrar o vídeo ao usuário o mais rápido possível
  completeProgress();
  setIsLoading(false);
  setShowLogoOverlay(false);
  setIsBuffering(false);
  setIsPlaying(true);
  setShowStuckButton(false);
  setError(null);
  // Reset error retry state on successful playback
  setErrorRetryCount(0);
  setErrorRetryCountdown(null);
  retryCountRef.current = 0;
      
      lockOrientation();

      if (isHost && channelRef.current && roomId && video) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'room_event',
          payload: { type: 'play', sender_id: clientIdRef.current }
        }).catch(() => {});
      }
      
      const lock = async () => {
        try {
          if (screen.orientation && (screen.orientation as any).lock) {
            await (screen.orientation as any).lock('landscape').catch(() => {});
            setIsLandscape(true);
          }
          setMedianOrientation('landscape');
        } catch (e) {}
      };
      lock();
    };

    const handleProgress = () => {
      if (video.buffered.length > 0 && video.duration > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const progress = Math.min(100, Math.round((bufferedEnd / video.duration) * 100));
        setBufferedPercentage(progress);
        
        if (!isLoading) {
           // Já está reproduzindo — garante que a barra está em 100
           completeProgress();
        }
        // Quando ainda está carregando, o target é controlado pelos eventos do HLS
        // e por canplay/playing — não usamos o buffer total aqui (ele cresce muito devagar).
      }
    };

    const handleStalled = () => {
      if (video.paused && isPlaying) {
        video.play().catch(e => { console.warn("Autoplay block", e); setAutoplayBlocked(true); setShowControls(true); setIsPlaying(false); });
      }
    };

    const handleError = (e: any) => {
      // Ignora evento abort (1), que acontece ao desmontar o player ou mudar o src
      if (video.error && video.error.code === 1) return;
      
      // Se HLS.js estiver ativo, ele possui seu próprio tratador de erros ultra-robusto (Hls.Events.ERROR).
      // Evitamos conflito com erros nativos prematuros do HTMLMediaElement.
      if (activeSrc && activeSrc.toLowerCase().includes('.m3u8') && Hls.isSupported() && hlsRef.current) {
        return;
      }
      
      if (retryCountRef.current < 15) { // increased to 15 for slower cold starts in Safari / iOS
        retryCountRef.current++;
        setTimeout(() => {
          if (video) {
            video.load();
            video.play().catch(e => { console.warn("Autoplay block", e); setAutoplayBlocked(true); setShowControls(true); setIsPlaying(false); });
          }
        }, 2000);
        return;
      }
      
      // Só chegamos aqui quando os 15 retries falharam — é um erro fatal.
      if (!error) {
        const lowerSrc = (activeSrc || '').toLowerCase();
        let errorMsg = "Não foi possível carregar o vídeo.";
        
        if (lowerSrc.includes('drive.google.com')) {
          errorMsg = "O Google Drive bloqueou o acesso direto a este vídeo. Tente usar o 'Player Padrão' ou verifique as configurações.";
        } else {
          errorMsg = "Erro ao carregar o vídeo. O formato pode ser incompatível ou o link expirou.";
        }

        setError({ 
          message: errorMsg, 
          type: lowerSrc.includes('drive.google.com') ? 'format' : 'network' 
        });
        // Só desliga loading quando há erro fatal exibido
        setIsLoading(false);
      }
    };

video.addEventListener('timeupdate', handleTimeUpdate);
  video.addEventListener('loadedmetadata', handleLoadedMetadata);
  video.addEventListener('canplay', handleCanPlay);
  video.addEventListener('canplaythrough', handleCanPlayThrough);
  video.addEventListener('seeked', () => setIsBuffering(false));
  video.addEventListener('waiting', handleWaiting);
  video.addEventListener('playing', handlePlaying);
  video.addEventListener('pause', handlePause);
  video.addEventListener('progress', handleProgress);
  video.addEventListener('stalled', handleStalled);
  video.addEventListener('error', handleError);

    let isMounted = true;
    const cleanupInit = initPlayer();

    return () => {
      isMounted = false;
      if (cleanupInit) cleanupInit();
video.removeEventListener('timeupdate', handleTimeUpdate);
  video.removeEventListener('loadedmetadata', handleLoadedMetadata);
  video.removeEventListener('canplay', handleCanPlay);
  video.removeEventListener('canplaythrough', handleCanPlayThrough);
  video.removeEventListener('seeked', () => setIsBuffering(false));
  video.removeEventListener('waiting', handleWaiting);
  video.removeEventListener('playing', handlePlaying);
  video.removeEventListener('pause', handlePause);
  video.removeEventListener('progress', handleProgress);
  video.removeEventListener('stalled', handleStalled);
  video.removeEventListener('error', handleError);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (e) {}
    };
  }, [activeSrc, sessionKey, movieId, playerMode]);

  const lockOrientation = useCallback(async () => {
    if (!autoRotate) return;
    try {
      if (screen.orientation && (screen.orientation as any).lock) {
        await (screen.orientation as any).lock('landscape').catch(() => {});
      }
    } catch (e) {
      console.warn("Orientation lock not supported", e);
    }
    setMedianOrientation('landscape');
  }, [autoRotate]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    
    // Auto-rotação para paisagem em dispositivos móveis
    lockOrientation();

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [autoRotate, lockOrientation]);

  useEffect(() => {
    // Artificial interval removed in favor of native buffering tracking
  }, [isLoading, loadingProgress]);

  useEffect(() => {
    let safetyTimeout: NodeJS.Timeout;

    if (isLoading) {
      safetyTimeout = setTimeout(() => {
        if (isLoading) {
          console.warn("Safety timeout forcing exit from loading state");
          setIsLoading(false);
          setLoadingProgress(100);
          setShowLogoOverlay(false);
          
          if (videoRef.current && videoRef.current.paused) {
             videoRef.current.play().catch(e => console.warn("Safety timeout autoplay blocked", e));
          }
        }
      }, 60000); // 60 seconds for long buffering / network delays
    }

    return () => {
      if (safetyTimeout) clearTimeout(safetyTimeout);
    };
  }, [isLoading]);

  useEffect(() => {
    if (!videoRef.current || !movieId) return;
    
    const saveProgress = () => {
      if (videoRef.current) {
        const time = videoRef.current.currentTime;
        const duration = videoRef.current.duration;
        const threshold = isMovie ? 450 : 30;
        
        if (duration > 0) {
          if (time > 10 && time < (duration - threshold)) {
             localStorage.setItem(`netplay_progress_${movieId}`, time.toString());
          } else if (time >= (duration - threshold)) {
             localStorage.removeItem(`netplay_progress_${movieId}`);
          }
        }
      }
    };

    const interval = setInterval(saveProgress, 10000); // Save every 10s
    return () => {
      clearInterval(interval);
      saveProgress();
    };
  }, [movieId]);

  // Auto-repair: detecta quando o loading trava e automaticamente reinicia o HLS.
  // Isso resolve o problema onde a primeira tentativa falha mas clicar em "Reparar" funciona.
  const autoRepairAttemptRef = useRef(0);
  const lastProgressCheckRef = useRef(0);
  
  useEffect(() => {
    let checkTimer: any;
    
    if (isLoading && !hasStartedPlayedRef.current) {
      // Verifica a cada 4 segundos se houve progresso
      checkTimer = setInterval(() => {
        const currentProgress = loadingProgressRef.current;
        const progressDelta = currentProgress - lastProgressCheckRef.current;
        
        // Se o progresso avançou menos de 5% em 4 segundos e ainda não passou de 80%,
        // e ainda não fizemos mais de 2 tentativas de auto-repair
        if (progressDelta < 5 && currentProgress < 80 && autoRepairAttemptRef.current < 2) {
          autoRepairAttemptRef.current++;
          
          // Executa o mesmo código do toggleReparar (reinicia o HLS)
          setSessionKey(Date.now());
          setShowStuckButton(false);
          setError(null);
          resetProgress();
          setProgressTarget(15);
          lastProgressCheckRef.current = 0;
        } else {
          lastProgressCheckRef.current = currentProgress;
        }
      }, 4000);
    } else {
      // Reset quando o vídeo começar a tocar ou loading terminar
      autoRepairAttemptRef.current = 0;
      lastProgressCheckRef.current = 0;
    }
    
    return () => {
      if (checkTimer) clearInterval(checkTimer);
    };
  }, [isLoading]);

// Mostra botão manual de Reparar após 12s (caso auto-repair não resolva)
  useEffect(() => {
    let timer: any;
    if (isLoading) {
      timer = setTimeout(() => {
        setShowStuckButton(true);
      }, 12000);
    } else {
      setShowStuckButton(false);
    }
    return () => clearTimeout(timer);
  }, [isLoading]);

  // Auto-retry na tela de erro com backoff exponencial
  // Tenta recuperar automaticamente sem exigir refresh da página
  useEffect(() => {
    if (!error) {
      // Reset retry state quando o erro é limpo
      setErrorRetryCount(0);
      setErrorRetryCountdown(null);
      return;
    }

    // Limite de 3 tentativas automaticas antes de exigir ação manual
    const MAX_ERROR_RETRIES = 3;
    if (errorRetryCount >= MAX_ERROR_RETRIES) {
      setErrorRetryCountdown(null);
      return;
    }

    // Backoff exponencial: 5s, 10s, 20s
    const delaySeconds = 5 * Math.pow(2, errorRetryCount);
    let countdown = delaySeconds;
    setErrorRetryCountdown(countdown);

    const countdownInterval = setInterval(() => {
      countdown -= 1;
      setErrorRetryCountdown(countdown);
      
      if (countdown <= 0) {
        clearInterval(countdownInterval);
        setErrorRetryCount(prev => prev + 1);
        toggleReparar();
      }
    }, 1000);

    return () => {
      clearInterval(countdownInterval);
    };
  }, [error, errorRetryCount, toggleReparar]);
  
  const togglePlay = () => {
    const video = videoRef.current;
    if (video) {
      if (video.paused) {
        lockOrientation();
        // Allow guest to initiate playback to bypass browser autoplay blocks
        video.play().catch(e => { console.warn("Autoplay block", e); setAutoplayBlocked(true); setShowControls(true); setIsPlaying(false); });
        if (isHost && channelRef.current && roomId) {
          channelRef.current.send({
            type: 'broadcast',
            event: 'room_event',
            payload: { type: 'play', sender_id: clientIdRef.current }
          }).catch(() => {});
        }
      } else {
        if (!isHost && roomId) return; // Only host can actively pause the room
        video.pause();
        if (isHost && channelRef.current && roomId) {
          channelRef.current.send({
            type: 'broadcast',
            event: 'room_event',
            payload: { type: 'pause', sender_id: clientIdRef.current }
          }).catch(() => {});
        }
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isHost && roomId) return;
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
      if (isHost && channelRef.current && roomId) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'room_event',
          payload: { type: 'seek', time, sender_id: clientIdRef.current }
        }).catch(() => {});
      }
    }
  };

  const skip = (amount: number) => {
    if (!isHost && roomId) return;
    if (videoRef.current) {
      videoRef.current.currentTime += amount;
      if (isHost && channelRef.current && roomId) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'room_event',
          payload: { type: 'seek', time: videoRef.current.currentTime, sender_id: clientIdRef.current }
        }).catch(() => {});
      }
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const togglePiP = async () => {
    try {
      const video = videoRef.current as any;
      if (!video) return;

      // Se já está em PiP, sair
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      // Verifica suporte real (alguns navegadores expõem disablePictureInPicture)
      const supportsStandardPiP = !!document.pictureInPictureEnabled && !video.disablePictureInPicture;
      const supportsWebkitPiP = !!video.webkitSupportsPresentationMode &&
        typeof video.webkitSetPresentationMode === 'function';

      if (!supportsStandardPiP && !supportsWebkitPiP) {
        alert('Mini Player (Picture-in-Picture) não é suportado neste navegador.');
        return;
      }

      // PiP não funciona enquanto o vídeo está em fullscreen do documento.
      // Saímos do fullscreen primeiro e aguardamos antes de pedir o PiP.
      if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
        try {
          if (document.exitFullscreen) {
            await document.exitFullscreen();
          } else if ((document as any).webkitExitFullscreen) {
            await (document as any).webkitExitFullscreen();
          }
        } catch (e) {
          console.warn('Falha ao sair do fullscreen antes do PiP:', e);
        }
        // Pequeno atraso para o navegador concluir a saída do fullscreen
        await new Promise((r) => setTimeout(r, 200));
      }

      // Garante que o vídeo tem áudio audível (PiP precisa de mídia ativa)
      try { video.muted = false; } catch (e) {}

      // Garante que o vídeo está tocando — algumas implementações
      // exigem que o elemento esteja em playback para entrar em PiP.
      if (video.paused) {
        try { await video.play(); } catch (e) {}
      }

      try {
        if (supportsStandardPiP) {
          await video.requestPictureInPicture();
        } else if (supportsWebkitPiP) {
          // Fallback Safari (iOS/Mac)
          video.webkitSetPresentationMode('picture-in-picture');
        }
      } catch (err: any) {
        // NotAllowedError, InvalidStateError, etc.
        console.error('Falha ao entrar em PiP:', err);
        alert('Não foi possível ativar o Mini Player. Tente novamente após iniciar o vídeo.');
        return;
      }

      // Após entrar com sucesso em PiP, fecha o player principal para que
      // o usuário possa navegar pelo app enquanto o vídeo continua na janela flutuante.
      // Pequeno atraso garante que o evento enterpictureinpicture já disparou.
      setTimeout(() => {
        if (document.pictureInPictureElement || (video.webkitPresentationMode === 'picture-in-picture')) {
          if (onClose) onClose();
        }
      }, 250);
    } catch (error) {
      console.error('PiP error:', error);
    }
  };

  const toggleFullscreen = () => {
    if (containerRef.current && screenfull.isEnabled) {
      screenfull.toggle(containerRef.current);
      
      // Tentar forçar landscape ao entrar em fullscreen
      if (!screenfull.isFullscreen && screen.orientation && (screen.orientation as any).lock) {
        (screen.orientation as any).lock('landscape').catch(() => {});
      }
    }
    
    // Median.co WebView fallback fullscreen
    try {
      if (isMedianApp()) {
        if (!isFullscreen) {
           window.location.href = 'median://screen/fullScreen';
        } else {
           window.location.href = 'median://screen/normalScreen';
        }
      }
    } catch(e) {}
  };

  const toggleSubtitles = () => {
    if (videoRef.current && videoRef.current.textTracks.length > 0) {
      const newMode = !showSubtitles;
      setShowSubtitles(newMode);
      videoRef.current.textTracks[0].mode = newMode ? 'showing' : 'hidden';
    }
  };

  const toggleCast = () => {
    if (videoRef.current && (videoRef.current as any).remote) {
      (videoRef.current as any).remote.prompt().catch((err: any) => {
        console.warn("Casting failed or dismissed:", err);
        // If native prompt fails, show our custom sharing UI
        setShowTvShare(true);
      });
    } else {
      setShowTvShare(true);
    }
  };

  const getQualityLabel = (height: number) => {
    if (height >= 2160) return '4K';
    if (height >= 1440) return '2K';
    if (height >= 1080) return 'FULL HD';
    if (height >= 720) return 'HD';
    return 'SD';
  };

  const getFullQualityName = (height: number) => {
    if (height >= 2160) return 'ULTRA HD 4K';
    if (height >= 1440) return 'QUAD HD 2K';
    if (height >= 1080) return 'FULL HD 1080p';
    if (height >= 720) return 'HD 720p';
    if (height >= 480) return 'PADRÃO 480p';
    if (height >= 360) return 'ECONOMIA 360p';
    return 'BÁSICO';
  };

  const getQualityColor = (height: number) => {
    if (height >= 2160) return 'from-amber-400 to-amber-600';
    if (height >= 1080) return 'from-red-500 to-red-700';
    if (height >= 720) return 'from-blue-500 to-blue-700';
    return 'from-gray-500 to-gray-700';
  };

  const handleQualityChange = (levelId: number | string) => {
    let label = 'Auto';
    if (levelId === 'auto') {
      if (hlsRef.current) hlsRef.current.currentLevel = -1;
      setIsAutoQuality(true);
      setCurrentQuality('Auto');
      setQualityToast('Qualidade: Automático');
    } else {
      setIsAutoQuality(false);
      
      // Check if it's a fixed URL option
      const fixedOption = videoUrlOptions.find(o => o.id === levelId);
      if (fixedOption) {
        setActiveSrc(fixedOption.url);
        label = fixedOption.id.toUpperCase();
        setCurrentQuality(label);
        setQualityToast(`Qualidade: ${fixedOption.label}`);
      } else {
        // HLS Level
        const id = typeof levelId === 'string' ? parseInt(levelId) : levelId;
        if (hlsRef.current) {
          hlsRef.current.currentLevel = id;
          const level = hlsRef.current.levels[id];
          if (level) {
            label = getQualityLabel(level.height);
            setCurrentQuality(label);
            setQualityToast(`Qualidade definida: ${label}`);
          }
        }
      }
    }
    localStorage.setItem('lastQuality', label);
    setTimeout(() => setQualityToast(null), 3000);
    setShowQualityMenu(false);
  };

  const formatTime = (time: number) => {
    const h = Math.floor(time / 3600);
    const m = Math.floor((time % 3600) / 60);
    const s = Math.floor(time % 60);
    return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleContainerClick = (e: React.MouseEvent | React.TouchEvent) => {
    // Only toggle if clicking background or the video element
    const target = e.target as HTMLElement;
    if (target === e.currentTarget || target.tagName === 'VIDEO' || target.id === 'player-overlay') {
      if (isBackgroundMode) {
         if (onClickBackground) onClickBackground();
         return;
      }
      if (isLocked) {
        setShowUnlockOverlay(true);
        setTimeout(() => setShowUnlockOverlay(false), 3000);
        return;
      }
      if (showControls) {
        setShowControls(false);
        if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      } else {
        handleMouseMove(); 
      }
    }
  };

  return (
    <div 
      ref={containerRef}
      className={isBackgroundMode ? "absolute inset-0 z-0 bg-black flex items-center justify-center select-none overflow-hidden scale-105 pointer-events-auto" : "fixed inset-0 bg-black z-[3000] flex items-center justify-center select-none group overflow-hidden"}
      onMouseMove={handleMouseMove}
      onClick={handleContainerClick}
      onTouchStart={handleMouseMove}
    >
      {/* Backdrop de fundo enquanto carrega ou como papel de parede */}
      <AnimatePresence>
        {(isLoading || showLogoOverlay || showAutoNext || showRecsOverlay) && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={`absolute inset-0 ${(showAutoNext || showRecsOverlay) ? 'z-[2]' : 'z-[5]'}`}
          >
            {backdropUrl && (
              <img 
                src={backdropUrl.startsWith('http') ? backdropUrl : `https://image.tmdb.org/t/p/original/${backdropUrl}`}
                alt=""
                className={`w-full h-full object-cover transition-opacity duration-1000 ${logoUrl && !(showAutoNext || showRecsOverlay) ? 'opacity-40' : 'opacity-90'} ${(showAutoNext || showRecsOverlay) ? 'scale-105 brightness-[0.7]' : ''}`}
                referrerPolicy="no-referrer"
              />
            )}
            {posterUrl && !(showAutoNext || showRecsOverlay) && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-12 md:p-20">
                 <motion.img 
                   src={posterUrl.startsWith('http') ? posterUrl : `https://image.tmdb.org/t/p/w780/${posterUrl}`}
                   alt=""
                   className={`h-[70%] md:h-[80%] rounded-2xl shadow-[0_0_60px_rgba(0,0,0,0.8)] border border-white/10 ${logoUrl ? 'opacity-50' : 'opacity-100'}`}
                   initial={{ scale: 0.9, y: 20 }}
                   animate={{ scale: 1, y: 0 }}
                   referrerPolicy="no-referrer"
                 />
              </div>
            )}
            <div className={`absolute inset-0 bg-gradient-to-t ${logoUrl ? 'from-black via-black/40 to-black/60' : 'from-black/40 via-transparent to-black/40'}`} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay de Recomendações (Elegante e horizontal) */}
      {showRecsOverlay && recommendations.length > 0 && !isLoading && (
        <div className="absolute top-0 right-0 bottom-0 w-[90%] sm:w-[75%] md:w-[60%] lg:w-[50%] bg-gradient-to-l from-black/95 via-black/80 to-transparent z-[315] flex flex-col justify-end animate-in slide-in-from-right duration-[800ms] p-6 md:p-12 overflow-hidden pointer-events-none">
          
          <div className="pointer-events-auto flex flex-col justify-end h-full">
            <div className="flex justify-between items-end mb-4 md:mb-6 mt-auto">
              <h2 className="text-white text-2xl md:text-4xl font-black uppercase tracking-tighter italic shadow-black drop-shadow-lg">
                Descubra a Seguir
              </h2>
              <button 
                onClick={() => {
                  setShowRecsOverlay(false);
                  recsDismissedRef.current = true;
                  recsDismissedTimeRef.current = videoRef.current ? videoRef.current.currentTime : 0;
                }}
                className="text-gray-400 hover:text-white bg-white/10 rounded-full p-2 md:p-3 transition-colors mb-1 md:mb-2"
              >
                <X size={20} className="md:w-6 md:h-6" />
              </button>
            </div>
            
            <div className="flex overflow-x-auto snap-x scrollbar-hide gap-3 md:gap-4 pb-8 -mr-6 md:-mr-12 pr-6 md:pr-12 pointer-events-auto">
              {recommendations.slice(0, 10).map((rec, index) => (
                <div 
                  key={rec.id}
                  onClick={() => onSelectRecommendation?.(rec)}
                  className={`flex-none w-[160px] md:w-[240px] aspect-video relative rounded-xl overflow-hidden cursor-pointer group transition-all duration-500 shadow-2xl snap-start ${index === 0 ? 'ring-2 ring-red-600 scale-100 hover:scale-105 opacity-100' : 'opacity-70 hover:opacity-100 scale-95 hover:scale-100'}`}
                >
                  <img 
                    src={`https://image.tmdb.org/t/p/w500${rec.backdrop_path || rec.poster_path}`}
                    alt={rec.title}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
                    referrerPolicy="no-referrer"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent flex flex-col justify-end p-3 md:p-4">
                    <h4 className="text-white font-bold text-xs md:text-sm line-clamp-2 drop-shadow-md leading-tight">{rec.title || rec.name}</h4>
                    
                    {index === 0 && !hasNextEpisode && autoNextCounter > 0 && (
                       <div className="mt-2 flex items-center gap-2">
                         <div className="w-3 h-3 md:w-4 md:h-4 rounded-full border-2 border-red-500 border-t-transparent animate-spin"/>
                         <span className="text-red-500 font-bold text-[9px] md:text-[10px] tracking-widest uppercase drop-shadow-md">
                           Em {autoNextCounter}s
                         </span>
                       </div>
                    )}
                    {index === 0 && (!autoNextCounter || autoNextCounter <= 0) && (
                       <div className="mt-2 flex items-center gap-1 md:gap-2 text-red-500 font-bold text-[9px] md:text-[10px] tracking-widest uppercase drop-shadow-md">
                          <Play size={10} className="md:w-3 md:h-3" fill="currentColor" /> Reproduzir
                       </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            
            {/* Espaçador para não grudar no bottom dos controllers invisíveis */}
            <div className="h-6 md:h-12 border-t border-transparent" />
          </div>
        </div>
      )}

      {/* Logo Overlay Inicial */}
      <AnimatePresence>
        {qualityToast && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-24 left-1/2 -translate-x-1/2 z-[400] bg-red-600 text-white px-6 py-2 rounded-full font-black text-[10px] uppercase tracking-widest shadow-[0_10px_30px_rgba(220,38,38,0.5)] italic"
          >
            {qualityToast}
          </motion.div>
        )}
        {showLogoOverlay && (
          <motion.div 
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[350] bg-black flex flex-col items-center justify-center p-4"
          >
            <motion.div 
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="flex items-center gap-6"
            >
              <div className="w-20 h-20 md:w-28 md:h-28 bg-red-600 rounded-2xl flex items-center justify-center shadow-[0_0_50px_rgba(220,38,38,0.4)]">
                <Play size={48} fill="white" className="text-white ml-2" />
              </div>
              <h1 className="text-4xl md:text-7xl font-black text-white uppercase tracking-tighter italic font-display leading-none">
                Net<span className="text-red-600">play</span>
              </h1>
            </motion.div>
            <div className="mt-8 flex gap-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
                  className="w-2 h-2 bg-red-600 rounded-full"
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Botão Próximo Episódio Automático e Skip Intro */}
      <AnimatePresence>
        {showAutoNext && hasNextEpisode && (
          <motion.div 
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            className="absolute right-[5%] top-1/2 -translate-y-1/2 z-[310] w-[30%] max-w-sm flex flex-col items-center justify-center gap-6 pointer-events-auto"
          >
            <div className="text-center">
              <h3 className="text-white text-2xl md:text-3xl font-black mb-2 shadow-black drop-shadow-xl">Próximo Episódio</h3>
              <p className="text-gray-300 text-sm md:text-base font-bold shadow-black drop-shadow-lg">Começando em {autoNextCounter}...</p>
            </div>
            <button 
              onClick={(e) => {
                 e.stopPropagation();
                 if (onNextEpisode) onNextEpisode();
              }}
              className="group relative flex items-center gap-4 bg-white text-black p-2 pr-8 rounded-full font-black hover:scale-105 transition-all shadow-2xl overflow-hidden"
            >
              <div className="absolute inset-0 bg-red-600 w-0 group-hover:w-full transition-all duration-500 z-0"></div>
              <div className="w-14 h-14 bg-red-600 rounded-full flex items-center justify-center text-white z-10 shadow-lg group-hover:bg-white group-hover:text-red-600 transition-colors">
                <FastForward size={28} fill="currentColor" />
              </div>
              <div className="text-left z-10 group-hover:text-white transition-colors duration-500">
                <p className="text-lg">Assistir Agora</p>
              </div>
            </button>
          </motion.div>
        )}
        
        {showSkipIntro && !showAutoNext && showControls && !isMovie && (
          <motion.button
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            onClick={(e) => {
               e.stopPropagation();
               if (videoRef.current) {
                 videoRef.current.currentTime += 85; 
                 // Pular abertura genérico de 85s
               }
            }}
            className="absolute bottom-32 right-12 z-[310] bg-white/10 hover:bg-white text-white hover:text-black border border-white/20 px-6 py-3 rounded-md font-bold uppercase tracking-widest text-xs md:text-sm shadow-2xl backdrop-blur-md transition-all pointer-events-auto flex items-center gap-2"
          >
            <FastForward size={18} /> Pular Abertura
          </motion.button>
        )}
      </AnimatePresence>

      {/* Classificação Indicativa (Netflix Style) */}
      <AnimatePresence>
        {showAgeRating && (
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 1 } }}
            className="absolute top-20 left-0 bg-black/60 backdrop-blur-md rounded-r-lg border-y border-r border-white/20 p-4 px-6 z-[300] flex items-center gap-4 pointer-events-none"
          >
            <div className={`w-8 h-8 rounded-md flex items-center justify-center font-bold text-white shadow-lg ${
              ageRating === 'L' ? 'bg-green-600' :
              ageRating === '10' ? 'bg-blue-500' :
              ageRating === '12' ? 'bg-yellow-500' :
              ageRating === '14' ? 'bg-orange-500' :
              ageRating === '16' ? 'bg-red-500' : 'bg-black border-2 border-red-600'
            }`}>
              {ageRating}
            </div>
            <div className="text-white text-sm font-medium pr-4">
              Classificação indicativa
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(showEpisodesSidebar || showSettingsMenu) && (backdropUrl || posterUrl) && (
          <motion.div
             initial={{ opacity: 0 }}
             animate={{ opacity: 1 }}
             exit={{ opacity: 0 }}
             className="absolute inset-0 z-[5] pointer-events-none"
          >
            <img src={backdropUrl || posterUrl} className="w-full h-full object-cover opacity-60 blur-xl" alt="" />
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-black/80 to-black/95" />
          </motion.div>
        )}
      </AnimatePresence>

      {isIframeMode ? (
        <iframe
          src={src}
          className="relative z-[10] w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
          allowFullScreen
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setIsLoading(false);
            setLoadingProgress(100);
            setShowLogoOverlay(false);
            setIsPlaying(true);
            hasStartedPlayedRef.current = true;
          }}
        />
      ) : (
        <video
          ref={videoRef}
          className={`relative z-[10] w-full h-full transition-all duration-700 ${objectFit === 'cover' ? 'object-cover' : 'object-contain'} ${(showAutoNext || showRecsOverlay || showEpisodesSidebar || showSettingsMenu) ? 'scale-[0.7] -translate-x-[15%] rounded-3xl overflow-hidden shadow-2xl origin-center' : ''}`}
          autoPlay
          playsInline
          webkit-playsinline="true"
          x-webkit-airplay="allow"
          disablePictureInPicture={false}
          referrerPolicy="no-referrer"
          onClick={handleContainerClick}
          onDoubleClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x < rect.width / 2) skip(-10);
            else skip(10);
          }}
        >
          {(subtitleUrl || activeSubtitleUrl) && !(subtitleUrl || activeSubtitleUrl || '').includes('.m3u8') && (
            <track 
              kind="subtitles" 
              src={subtitleUrl || activeSubtitleUrl} 
              srcLang="pt" 
              label="Português" 
            />
          )}
        </video>
      )}

      {/* Emotes Overlay Layer */}
      <div className="absolute inset-0 z-[250] pointer-events-none overflow-hidden">
        <AnimatePresence mode="popLayout">
          {emotes.map((emote) => (
            <motion.div
              key={emote.id}
              initial={{ scale: 0, y: 100, opacity: 0, rotate: -20 }}
              animate={{ 
                scale: [1, 1.2, 1], 
                y: -100, 
                opacity: [0, 1, 1, 0],
                rotate: [0, 10, -10, 0]
              }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 4, ease: "linear" }}
              style={{
                position: 'absolute',
                left: `${emote.x}%`,
                top: `${emote.y}%`,
                transform: 'translate(-50%, -50%)',
              }}
              className="flex flex-col items-center gap-2"
            >
              <div className="text-5xl md:text-7xl filter drop-shadow-[0_15px_30px_rgba(0,0,0,0.8)] select-none">
                {emote.emoji}
              </div>
              {emote.profileName && (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="px-4 py-1.5 bg-black/60 backdrop-blur-xl rounded-2xl border border-white/20 shadow-2xl"
                >
                  <span className="text-[9px] md:text-[11px] font-black text-white uppercase tracking-[0.2em] italic whitespace-nowrap">
                    {emote.profileName}
                  </span>
                </motion.div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Overlay de Buffering Menor - só aparece DEPOIS do vídeo já ter começado a tocar */}
      {isBuffering && !isLoading && !error && hasStartedPlayedRef.current && (
        <div className="absolute inset-0 z-[309] flex flex-col items-center justify-center p-4 pointer-events-none">
           <div className="w-16 h-16 border-4 border-white/20 border-t-red-600 rounded-full animate-spin shadow-[0_0_15px_rgba(220,38,38,0.5)]"></div>
        </div>
      )}

      {/* Overlay de Carregamento Circular (1-100%) */}
      {isLoading && !error && (
        <div className="absolute inset-0 z-[310] flex flex-col items-center justify-center p-4">
          <div className="absolute inset-0 overflow-hidden">
             {backdropUrl && (
               <img 
                 src={backdropUrl.startsWith('http') ? backdropUrl : `https://image.tmdb.org/t/p/original/${backdropUrl}`}
                 alt=""
                 className="w-full h-full object-cover scale-105"
                 referrerPolicy="no-referrer"
               />
             )}
             <div className="absolute inset-0 bg-[#080808]/40" />
             <div className="absolute inset-0 bg-gradient-to-t from-[#080808] via-transparent to-[#080808]" />
          </div>

          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="relative z-10 flex flex-col items-center max-w-5xl text-center"
          >
            <div className="flex flex-row items-center justify-center gap-4 md:gap-8 mb-10 px-6 py-5 bg-white/5 rounded-[2rem] border border-white/10 shadow-2xl backdrop-blur-3xl transform scale-90 md:scale-100">
               <div className="flex items-center gap-3 shrink-0">
                  <div className="w-8 h-8 md:w-16 md:h-16 bg-red-600 rounded-lg md:rounded-2xl flex items-center justify-center shadow-[0_0_20px_rgba(220,38,38,0.4)]">
                     <Play size={16} fill="white" className="text-white ml-0.5 md:ml-1 md:w-8 md:h-8" />
                  </div>
                  <div className="text-left">
                     <h2 className="text-lg md:text-3xl font-black text-white uppercase tracking-tighter italic leading-none">Net<span className="text-red-600">play</span></h2>
                     <p className="text-[6px] md:text-[8px] text-gray-500 font-bold uppercase tracking-[0.2em]">Original App</p>
                  </div>
               </div>

               <div className="w-px h-8 bg-white/10" />

               {logoUrl ? (
                  <motion.img 
                    src={logoUrl.startsWith('http') ? logoUrl : `https://image.tmdb.org/t/p/w500/${logoUrl}`}
                    alt={title}
                    className="h-8 md:h-12 max-w-[120px] md:max-w-[200px] object-contain filter drop-shadow-2xl"
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    referrerPolicy="no-referrer"
                  />
               ) : (
                  <div className="flex flex-col relative w-[150px] md:w-[300px] overflow-hidden">
                    <div className="whitespace-nowrap flex animate-marquee">
                      <h1 className="text-white text-sm md:text-xl font-black uppercase italic tracking-tighter drop-shadow-2xl pr-8">
                        {seriesTitle ? `${seriesTitle} • ${title.replace(seriesTitle + ' - ', '')}` : title}
                      </h1>
                      <h1 className="text-white text-sm md:text-xl font-black uppercase italic tracking-tighter drop-shadow-2xl pr-8">
                        {seriesTitle ? `${seriesTitle} • ${title.replace(seriesTitle + ' - ', '')}` : title}
                      </h1>
                    </div>
                  </div>
               )}
            </div>

            <div className="relative w-20 h-20 md:w-24 md:h-24 mb-6">
              <svg className="w-full h-full -rotate-90">
                <circle
                  cx="50%"
                  cy="50%"
                  r="45%"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-white/10"
                />
                <motion.circle
                  cx="50%"
                  cy="50%"
                  r="45%"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  className="text-red-600 transition-all duration-300"
                  strokeDasharray="283"
                  animate={{ strokeDashoffset: 283 - (283 * loadingProgress) / 100 }}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl md:text-2xl font-black text-white italic">{loadingProgress}%</span>
              </div>
            </div>
            
            {autoplayBlocked && (
               <motion.div 
                 initial={{ opacity: 0, scale: 0.9 }}
                 animate={{ opacity: 1, scale: 1 }}
                 className="mt-6 z-50 pointer-events-auto"
               >
                 <button
                   onClick={(e) => {
                     e.stopPropagation();
                     setAutoplayBlocked(false);
                     videoRef.current?.play().catch(()=>console.warn("Still blocked"));
                   }}
                   className="bg-red-600 text-white px-10 py-5 rounded-2xl font-black uppercase tracking-widest text-[14px] md:text-[18px] italic shadow-[0_0_40px_rgba(220,38,38,0.5)] hover:scale-105 hover:bg-white hover:text-red-600 transition-all flex items-center gap-4 animate-bounce"
                 >
                   <Play size={28} fill="currentColor" /> Tocar Para Iniciar
                 </button>
               </motion.div>
            )}

            <motion.p 
              key={loadingMessageIndex}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="text-white/80 font-black tracking-widest uppercase text-[10px] md:text-[12px] italic mt-4 max-w-lg leading-relaxed h-12 flex items-center justify-center text-balance"
            >
              {loadingFacts[loadingMessageIndex]}
            </motion.p>

            {showStuckButton && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-8 flex flex-col items-center gap-4"
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReparar();
                  }}
                  className="bg-white text-black px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-[11px] italic shadow-2xl hover:scale-105 transition-all flex items-center gap-2"
                >
                  <RotateCw size={18} /> Reparar Conexão
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsLoading(false);
                    setLoadingProgress(100);
                    setShowLogoOverlay(false);
                    try {
                      if (!document.fullscreenElement) {
                        document.documentElement.requestFullscreen().catch(() => {});
                      }
                      if (screen.orientation && (screen.orientation as any).lock) {
                        (screen.orientation as any).lock('landscape').catch(() => {});
                      }
                    } catch(e) {}
                    if (videoRef.current) videoRef.current.play().catch(() => {});
                    // play() will trigger handlePlaying which locks orientation.
                  }}
                  className="bg-red-600/20 text-red-500 border border-red-600/30 px-8 py-3 rounded-2xl font-black uppercase tracking-widest text-[10px] italic hover:bg-red-600 hover:text-white transition-all"
                >
                  Iniciar Manualmente
                </button>
                {onSwitchPlayer && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSwitchPlayer();
                    }}
                    className="mt-2 bg-blue-600/20 text-blue-500 border border-blue-600/30 px-8 py-3 rounded-2xl font-black uppercase tracking-widest text-[10px] italic hover:bg-blue-600 hover:text-white transition-all w-full flex justify-center items-center gap-2"
                  >
                    <span>Abrir Player Nativo (Rápido)</span>
                  </button>
                )}
                <p className="text-[9px] text-gray-500 font-bold uppercase tracking-widest italic animate-pulse mt-2">Servidor Instável? Tente o Player Nativo</p>
              </motion.div>
            )}
          </motion.div>
        </div>
      )}

      {/* Mensagem de Erro */}
      {error && (
        <div className="absolute inset-0 z-[320] flex flex-col items-center justify-center bg-[#080808] p-6 text-center">
          <div className="relative mb-8">
            <div className="w-24 h-24 bg-red-600/10 rounded-full flex items-center justify-center border border-red-600/30">
              {error.type === 'network' ? <WifiOff size={48} className="text-red-600" /> : <AlertCircle size={48} className="text-red-600" />}
            </div>
            <motion.div 
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="absolute -top-2 -right-2 w-8 h-8 bg-red-600 rounded-full flex items-center justify-center border-4 border-[#080808]"
            >
              <X size={16} className="text-white" />
            </motion.div>
          </div>
          
          <h3 className="text-3xl font-black text-white mb-4 uppercase tracking-tighter italic font-display">
            {error.type === 'network' ? 'Problema de Conexão' : 'Erro de Carregamento'}
          </h3>
          <p className="text-gray-400 mb-6 max-w-md leading-relaxed font-medium">
            {error.message}
          </p>
          
          {/* Auto-retry countdown indicator */}
          {errorRetryCountdown !== null && errorRetryCount < 3 && (
            <div className="mb-6 flex flex-col items-center">
              <div className="flex items-center gap-2 text-white/60 text-sm">
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                >
                  <RotateCw size={14} />
                </motion.div>
                <span className="font-medium">Tentando novamente em <span className="text-white font-bold">{errorRetryCountdown}s</span></span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">Tentativa {errorRetryCount + 1} de 3</p>
            </div>
          )}
          
          {errorRetryCount >= 3 && (
            <p className="text-yellow-500/80 text-xs mb-6 font-medium">
              Tentativas automáticas esgotadas. Use os botões abaixo.
            </p>
          )}
          
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setErrorRetryCount(0); // Reset retry count for manual retry
                toggleReparar();
              }}
              className="flex-1 bg-white text-black px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-gray-200 transition-all shadow-xl hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
            >
              <RotateCw size={16} /> Tentar Novamente
            </button>
            <button 
              onClick={onSwitchPlayer || onClose}
              className="flex-1 bg-red-600 text-white px-8 py-4 rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-red-700 transition-all shadow-[0_10px_30px_rgba(220,38,38,0.3)] hover:scale-105 active:scale-95"
            >
              Tentar Outro Player
            </button>
          </div>
        </div>
      )}

      {/* Episodes Sidebar Overlay */}
      <AnimatePresence>
        {showEpisodesSidebar && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="absolute top-0 right-0 bottom-0 w-full md:w-[400px] bg-black/95 border-l border-white/10 z-[400] flex flex-col shadow-2xl backdrop-blur-xl"
            onMouseLeave={() => resetControlsTimer()}
          >
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <h2 className="text-xl font-black text-white uppercase italic tracking-tighter">Episódios</h2>
              <button 
                onClick={() => setShowEpisodesSidebar(false)}
                className="text-white/60 hover:text-white hover:scale-110 transition-all p-2 rounded-full hover:bg-white/10"
                title="Fechar"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="px-6 py-4 flex gap-2 overflow-x-auto scrollbar-hide border-b border-white/5">
              {seasons.map(season => (
                <button
                  key={season}
                  onClick={() => setActiveSeason(season)}
                  className={`px-4 py-2 rounded-full text-xs font-bold uppercase transition-all whitespace-nowrap ${activeSeason === season ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                >
                  Temporada {season}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {episodes?.filter(ep => ep.season === activeSeason).map(ep => {
                const isActive = activeSrc === ep.videoUrl || activeSrc === ep.videoUrl2;
                return (
                  <button
                    key={ep.id}
                    onClick={() => {
                        setShowEpisodesSidebar(false);
                        if (onSelectEpisode) {
                           onSelectEpisode(ep);
                        } else {
                           setActiveSrc(ep.videoUrl || ep.videoUrl2 || "");
                        }
                    }}
                    className={`w-full text-left p-3 rounded-xl flex gap-4 items-center group transition-all duration-300 ${isActive ? 'bg-red-600/20 border border-red-600/50 shadow-[0_0_20px_rgba(220,38,38,0.2)]' : 'hover:bg-white/5 border border-transparent'}`}
                  >
                    <div className="w-28 h-16 bg-gray-900 rounded-md overflow-hidden relative shrink-0">
                       {ep.still_path ? (
                         <img src={ep.still_path.startsWith('http') ? ep.still_path : `https://image.tmdb.org/t/p/w300${ep.still_path}`} alt="" className="w-full h-full object-cover" />
                       ) : (
                         <div className="absolute inset-0 flex items-center justify-center">
                            <Tv size={24} className="text-white/20" />
                         </div>
                       )}
                       {isActive && (
                         <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <Play size={20} className="text-white" fill="white" />
                         </div>
                       )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start mb-1">
                        <h4 className={`font-bold text-sm truncate pr-2 ${isActive ? 'text-white' : 'text-gray-300'}`}>{ep.episode}. {ep.title}</h4>
                        {ep.runtime && <span className="text-gray-400 text-[10px] uppercase font-bold tracking-widest shrink-0">{ep.runtime} min</span>}
                      </div>
                      {ep.overview && (
                        <p className="text-gray-500 text-[10px] leading-tight line-clamp-2 md:line-clamp-3">{ep.overview}</p>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay de Desbloqueio (Lock Screen) */}
      <AnimatePresence>
        {isLocked && showUnlockOverlay && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[4000] flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()} // Prevent bubbling to container which might re-trigger
          >
            <motion.div
              drag
              dragConstraints={{ top: -100, bottom: 0, left: -100, right: 100 }}
              dragElastic={0.2}
              onDragEnd={(e, info) => {
                if (info.offset.y < -50 || Math.abs(info.offset.x) > 50) {
                  setIsLocked(false);
                  setShowUnlockOverlay(false);
                  resetControlsTimer(true);
                }
              }}
              className="flex flex-col items-center gap-4 cursor-grab active:cursor-grabbing p-8 rounded-3xl bg-black/80 border border-white/20 shadow-2xl pointer-events-auto relative overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-t from-red-600/10 to-transparent pointer-events-none" />
              <motion.div
                animate={{ y: [0, -10, 0] }}
                transition={{ repeat: Infinity, duration: 1.5 }}
                className="flex flex-col items-center opacity-50"
              >
                <ChevronLeft className="text-white rotate-90 translate-y-2" size={24} />
                <ChevronLeft className="text-white rotate-90" size={24} />
              </motion.div>
              <div className="flex items-center gap-4">
                 <motion.div animate={{ x: [0, -10, 0] }} transition={{ repeat: Infinity, duration: 1.5 }} className="opacity-50 hidden md:block">
                    <ChevronLeft className="text-white" size={24} />
                 </motion.div>
                 <div className="w-20 h-20 bg-red-600/20 rounded-full flex items-center justify-center border-2 border-red-600/50 mb-2 shadow-[0_0_30px_rgba(220,38,38,0.3)] relative z-10">
                   <Lock size={32} className="text-white" />
                 </div>
                 <motion.div animate={{ x: [0, 10, 0] }} transition={{ repeat: Infinity, duration: 1.5 }} className="opacity-50 hidden md:block">
                    <ChevronLeft className="text-white rotate-180" size={24} />
                 </motion.div>
              </div>
              <p className="text-white font-black uppercase tracking-widest text-[10px] md:text-xs relative z-10">
                Arraste para desbloquear
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Overlay de Controles */}
      {!isIframeMode && (
        <div className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/60 transition-opacity duration-500 flex flex-col justify-between p-6 z-[305] ${showControls && !isLoading && !isLocked && !isBackgroundMode ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        
        {/* Topo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <button onClick={onClose} className="text-white hover:scale-110 transition-transform">
              <ChevronLeft size={40} strokeWidth={3} />
            </button>
            <div className="flex flex-col relative w-[150px] md:w-[300px] overflow-hidden mask-image:linear-gradient(to_right,black_80%,transparent)]">
              <div className="whitespace-nowrap flex animate-marquee">
                <h1 className="text-white text-xs md:text-lg font-black uppercase italic tracking-tighter drop-shadow-md pr-8">
                  {seriesTitle ? `${seriesTitle} • ${title.replace(seriesTitle + ' - ', '')}` : title}
                </h1>
                <h1 className="text-white text-xs md:text-lg font-black uppercase italic tracking-tighter drop-shadow-md pr-8">
                  {seriesTitle ? `${seriesTitle} • ${title.replace(seriesTitle + ' - ', '')}` : title}
                </h1>
              </div>
              {roomId && (
                <div className="flex items-center gap-2 mt-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-600 animate-pulse" />
                  <span className="text-[8px] md:text-[10px] font-black uppercase tracking-[0.2em] text-red-600 italic">Sala de Estreia Ativa</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 md:gap-6">
            {roomId && (
               <div className="hidden md:flex items-center gap-3 bg-white/5 border border-white/5 px-4 py-2 rounded-full">
                  <Users size={16} className="text-red-600" />
                  <div className="flex -space-x-2">
                    {roomUsers.map((u, i) => (
                      <div key={i} className="w-6 h-6 rounded-full border border-black bg-gray-800 overflow-hidden" title={u.profileName}>
                        {u.avatar ? <img src={u.avatar} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[8px]">{u.profileName[0]}</div>}
                      </div>
                    ))}
                  </div>
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{roomUsers.length} Online</span>
               </div>
            )}
            <button 
              onClick={toggleCast}
              className={`transition-colors ${isCasting ? 'text-red-600 animate-pulse' : 'text-white hover:text-gray-300'}`}
              title="Transmitir para TV"
            >
              <Cast size={28} />
            </button>
            <button 
              onClick={() => setShowSettingsMenu(!showSettingsMenu)}
              className={`transition-colors ${showSettingsMenu ? 'text-red-600' : 'text-white hover:text-gray-300'}`}
              title="Configurações"
            >
              <Settings size={28} />
            </button>
          </div>
        </div>

        {/* Menu de Configurações - Full Sidebar */}
        <AnimatePresence>
          {showSettingsMenu && (
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="absolute top-0 right-0 bottom-0 w-full md:w-[360px] bg-black/95 border-l border-white/10 z-[320] flex flex-col shadow-2xl backdrop-blur-xl"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between shrink-0">
                <h3 className="text-xl font-black italic uppercase tracking-tighter text-white">Configurações</h3>
                <button onClick={() => setShowSettingsMenu(false)} className="text-white/60 hover:text-white p-2 rounded-full hover:bg-white/10 transition-colors">
                  <X size={24} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-hide">
                {/* Ações Rápidas */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-black mb-4">Ações do Player</p>
                  <div className="grid grid-cols-2 gap-3">
                    {(!roomId || isHost) && (
                      <button 
                        onClick={() => skip(-10)} 
                        className="py-3 px-4 bg-white/5 hover:bg-white/10 rounded-xl flex flex-col items-center justify-center gap-2 transition-all border border-white/5"
                      >
                        <RotateCcw size={20} className="text-white" />
                        <span className="text-[10px] font-bold text-white uppercase tracking-widest">Retornar 10s</span>
                      </button>
                    )}
                    <button 
                      onClick={togglePiP} 
                      className="py-3 px-4 bg-white/5 hover:bg-white/10 rounded-xl flex flex-col items-center justify-center gap-2 transition-all border border-white/5"
                    >
                      <PictureInPicture size={20} className="text-white" />
                      <span className="text-[10px] font-bold text-white uppercase tracking-widest">Mini Player</span>
                    </button>
                    <button 
                      onClick={toggleReparar} 
                      className="py-3 px-4 bg-white/5 hover:bg-white/10 rounded-xl flex flex-col items-center justify-center gap-2 transition-all border border-white/5"
                    >
                      <RotateCw size={20} className="text-white" />
                      <span className="text-[10px] font-bold text-white uppercase tracking-widest">Reparar Vídeo</span>
                    </button>
                    {onSwitchPlayer && (
                      <button 
                        onClick={onSwitchPlayer}
                        className="py-3 px-4 bg-white/5 hover:bg-white/10 rounded-xl flex flex-col items-center justify-center gap-2 transition-all border border-white/5"
                      >
                        <Settings size={20} className="text-white" />
                        <span className="text-[10px] font-bold text-white uppercase tracking-widest text-center">Nativo</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Alternâncias */}
                <div className="space-y-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-black mb-4">Preferências</p>
                  <button 
                    onClick={toggleSubtitles}
                    className="w-full py-4 px-5 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-xs font-bold transition-all border border-white/5 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <Subtitles size={18} className={showSubtitles ? 'text-red-500' : 'text-gray-400'} />
                      <span>Legendas</span>
                    </div>
                    <div className={`w-10 h-5 rounded-full transition-colors relative ${showSubtitles ? 'bg-red-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${showSubtitles ? 'right-1' : 'left-1'}`} />
                    </div>
                  </button>
                  <button 
                    onClick={toggleRotation}
                    className="w-full py-4 px-5 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-xs font-bold transition-all border border-white/5 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <RotateCw size={18} className={autoRotate ? 'text-red-500' : 'text-gray-400'} />
                      <span>Rotação Automática</span>
                    </div>
                    <div className={`w-10 h-5 rounded-full transition-colors relative ${autoRotate ? 'bg-red-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${autoRotate ? 'right-1' : 'left-1'}`} />
                    </div>
                  </button>
                </div>

                {/* Qualidade */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-black mb-3">Qualidade</p>
                  <button 
                    onClick={() => setShowQualityMenu(!showQualityMenu)}
                    className="w-full py-4 px-5 bg-white/5 hover:bg-white/10 text-white rounded-2xl text-xs font-bold transition-all border border-white/5 flex items-center justify-between"
                  >
                    <span>{isAutoQuality ? 'Automático' : currentQuality}</span>
                    <Settings size={16} className={`transition-transform duration-300 ${showQualityMenu ? 'rotate-90 text-red-500' : 'text-gray-400'}`} />
                  </button>
                  
                  <AnimatePresence>
                    {showQualityMenu && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-2 space-y-2 overflow-hidden px-1"
                      >
                        <button
                          onClick={() => handleQualityChange('auto')}
                          className={`w-full py-3 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-between ${isAutoQuality ? 'bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.3)]' : 'bg-white/5 text-gray-400 hover:bg-white/10'}`}
                        >
                          <div className="flex items-center gap-3">
                             <div className={`w-2 h-2 rounded-full ${isAutoQuality ? 'bg-white animate-pulse' : 'bg-gray-600'}`} />
                             <span>Automático</span>
                          </div>
                          {isAutoQuality && <span className="text-[10px] font-black italic">{currentQuality}</span>}
                        </button>
                        {videoUrlOptions.map(option => (
                          <button
                            key={option.id}
                            onClick={() => handleQualityChange(option.id)}
                            className={`w-full py-3 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-between ${activeSrc === option.url ? 'bg-white/10 text-white shadow-lg border border-white/10' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}
                          >
                             <div className="flex items-center gap-3">
                               <div className="w-8 h-5 flex items-center justify-center rounded-[3px] text-[8px] font-black bg-gradient-to-br from-gray-500 to-gray-600 text-white shadow-sm uppercase">
                                 {option.id}
                               </div>
                               <span>{option.label}</span>
                             </div>
                          </button>
                        ))}
                        {qualityLevels.map(level => (
                          <button
                            key={level.id}
                            onClick={() => handleQualityChange(level.id)}
                            className={`w-full py-3 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-between ${!isAutoQuality && hlsRef.current?.currentLevel === level.id ? 'bg-white/10 text-white shadow-lg border border-white/10' : 'bg-white/5 text-gray-400 hover:bg-white/10 border border-transparent'}`}
                          >
                             <div className="flex items-center gap-3">
                               <div className={`w-8 h-5 flex items-center justify-center rounded-[3px] text-[8px] font-black bg-gradient-to-br ${getQualityColor(level.height)} text-white shadow-sm`}>
                                 {getQualityLabel(level.height)}
                               </div>
                               <span>{getFullQualityName(level.height)}</span>
                             </div>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Velocidade */}
                <div className="pb-8">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest font-black mb-3">Velocidade de Reprodução</p>
                  <div className="flex gap-2 p-2 bg-white/5 rounded-2xl border border-white/5">
                    {[0.5, 1, 1.5, 2].map(speed => (
                      <button
                        key={speed}
                        onClick={() => {
                          setPlaybackSpeed(speed);
                          if (videoRef.current) videoRef.current.playbackRate = speed;
                        }}
                        className={`flex-1 py-3 rounded-xl text-xs font-bold transition-all ${playbackSpeed === speed ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                      >
                        {speed}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      {/* Centro (Play/Skip/Emotes) */}
      <div className="flex items-center justify-center gap-6 md:gap-20">
        
        {/* Emote Picker Trigger (For Everyone) */}
        <div className="relative group">
          <button
            onClick={() => {
              setShowEmotePicker(!showEmotePicker);
              resetControlsTimer();
            }}
            className={`p-3 md:p-5 rounded-full backdrop-blur-xl border border-white/20 transition-all active:scale-90 shadow-2xl ${showEmotePicker ? 'bg-red-600 text-white border-red-500' : 'bg-white/10 text-white hover:bg-white/20'}`}
          >
            <Smile size={28} className="md:w-8 md:h-8" />
          </button>
          
          <AnimatePresence>
            {showEmotePicker && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-6 bg-black/90 backdrop-blur-3xl p-5 rounded-[2.5rem] border border-white/10 flex gap-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-[400]"
              >
                 {EMOTES.map(emoji => (
                   <button
                     key={emoji}
                     onClick={() => sendEmote(emoji)}
                     className="text-3xl md:text-4xl hover:scale-150 transition-transform active:scale-90 p-2"
                   >
                     {emoji}
                   </button>
                 ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {(!roomId || isHost) ? (
          <button 
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }} 
            className="text-white hover:scale-110 transition-transform p-4 bg-white/5 rounded-full backdrop-blur-md border border-white/10"
          >
            {isPlaying ? <Pause size={48} className="md:w-20 md:h-20" fill="white" /> : <Play size={48} className="md:w-20 md:h-20" fill="white" />}
          </button>
        ) : roomId && (
          <div className="flex flex-col items-center gap-2">
            <div className="p-4 bg-white/5 rounded-full backdrop-blur-md border border-white/10 opacity-50">
              {isPlaying ? <Pause size={48} className="md:w-20 md:h-20" fill="white" /> : <Play size={48} className="md:w-20 md:h-20" fill="white" />}
            </div>
            <span className="text-[8px] md:text-[10px] font-black uppercase text-red-500 tracking-widest animate-pulse">Sincronizado</span>
          </div>
        )}

        {(!roomId || isHost) && (
          <button onClick={() => skip(10)} className="text-white hover:scale-110 transition-transform flex flex-col items-center">
            <RotateCw size={32} className="md:w-12 md:h-12" />
            <span className="text-[10px] md:text-xs font-bold mt-1">10</span>
          </button>
        )}
      </div>

        {/* Base (Barra de Progresso e Controles) */}
        <div className="space-y-4">
          {/* Barra de Progresso */}
          <div className={`flex items-center gap-4 group/progress ${(roomId && !isHost) ? 'pointer-events-none opacity-50' : ''}`}>
            <span className="text-white text-sm font-medium min-w-[50px]">{formatTime(currentTime)}</span>
            <div 
              className="relative flex-1 h-2 md:h-1.5 bg-gray-600/50 rounded-full cursor-pointer group/bar hover:h-3 transition-all"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                setHoverPosition(Math.max(0, Math.min(1, pos)));
                if (duration) setHoverTime(pos * duration);
              }}
              onMouseLeave={() => setHoverTime(null)}
              onTouchMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const touch = e.touches[0];
                const pos = (touch.clientX - rect.left) / rect.width;
                setHoverPosition(Math.max(0, Math.min(1, pos)));
                if (duration) setHoverTime(pos * duration);
              }}
              onTouchEnd={() => setHoverTime(null)}
            >
              {/* Barra de Carregamento (Buffer) - Parte em banco */}
              <div 
                className="absolute top-0 left-0 h-full bg-red-600/40 rounded-full transition-all duration-300"
                style={{ width: `${bufferedPercentage}%` }}
              />
              
              {/* Barra Assistida */}
              <div 
                className="absolute top-0 left-0 h-full bg-red-600 transition-all duration-100 rounded-full"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
              
              <input
                type="range"
                min="0"
                max={duration || 0}
                value={currentTime}
                onChange={handleSeek}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              />
              
              {/* Botão de Progresso */}
              <div 
                className="absolute top-1/2 w-4 h-4 bg-red-600 rounded-full shadow-[0_0_10px_rgba(220,38,38,0.8)] opacity-0 group-hover/progress:opacity-100 transition-opacity pointer-events-none z-20"
                style={{ left: `${(currentTime / duration) * 100}%`, transform: 'translate(-50%, -50%)' }}
              />
              
              {/* Miniatura de Tempo/Cena Hover */}
              {hoverTime !== null && (
                <div 
                  className="absolute bottom-full mb-4 bg-white text-black px-3 py-1.5 rounded-lg font-black text-sm shadow-2xl pointer-events-none z-30 flex flex-col items-center"
                  style={{ left: `${hoverPosition * 100}%`, transform: 'translateX(-50%)' }}
                >
                  {/* Seta */}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-x-[6px] border-x-transparent border-t-[6px] border-t-white" />
                  <span>{formatTime(hoverTime)}</span>
                </div>
              )}
            </div>
            <span className="text-white text-sm font-medium min-w-[50px]">{formatTime(duration - currentTime)}</span>
          </div>

          {/* Controles Inferiores */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-8">
              {(!roomId || isHost) && (
                <button onClick={togglePlay} className="text-white hover:text-red-500 transition-colors">
                  {isPlaying ? <Pause size={32} fill="white" /> : <Play size={32} fill="white" />}
                </button>
              )}
              
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setIsLocked(true);
                  setShowControls(false);
                }} 
                className="text-white hover:text-red-500 transition-colors flex flex-col items-center gap-1 group"
              >
                <Lock size={24} className="group-hover:scale-110 transition-transform" />
                <span className="text-[8px] font-black uppercase tracking-widest hidden md:block">Bloquear</span>
              </button>

              <div className="flex items-center gap-4 group/volume">
                <button onClick={toggleMute} className="text-white">
                  {isMuted || volume === 0 ? <VolumeX size={32} /> : <Volume2 size={32} />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-0 group-hover/volume:w-24 transition-all duration-300 accent-red-600"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 md:gap-8">
              <div className="flex items-center gap-3 bg-black/40 px-3 py-1.5 rounded-lg border border-white/10 backdrop-blur-md shadow-xl">
                {isAutoQuality && <div className="text-[8px] font-black text-red-600 animate-pulse italic">AUTO</div>}
                <div className={`px-2 py-0.5 rounded-[3px] text-[10px] md:text-[12px] font-black text-white italic tracking-tighter uppercase whitespace-nowrap bg-gradient-to-br shadow-lg ${
                  currentQuality === '4K' ? 'from-amber-400 to-amber-600' :
                  currentQuality === '2K' ? 'from-orange-400 to-orange-600' :
                  currentQuality === 'FULL HD' ? 'from-red-500 to-red-650' :
                  currentQuality === 'HD' ? 'from-blue-500 to-blue-650' :
                  'from-gray-500 to-gray-600'
                }`}>
                  {currentQuality}
                </div>
              </div>

              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setObjectFit(f => f === 'contain' ? 'cover' : 'contain');
                }}
                className="text-white hover:text-gray-300 transition-all hidden md:block"
                title={objectFit === 'contain' ? "Preencher Tela" : "Ajustar à Tela"}
              >
                {objectFit === 'contain' ? <ZoomIn size={24} className="md:w-6 md:h-6 lg:w-8 lg:h-8" /> : <ZoomOut size={24} className="md:w-6 md:h-6 lg:w-8 lg:h-8" />}
              </button>

              {episodes && episodes.length > 0 && (
                <button 
                  onClick={() => {
                    setShowEpisodesSidebar(true);
                    setShowControls(false); // hide controls when sidebar opens
                  }}
                  className="hidden md:flex items-center gap-2 text-white hover:text-gray-300 font-bold bg-white/10 px-4 py-2 rounded-md border border-white/20 transition-all"
                >
                  <Tv size={20} /> Episódios
                </button>
              )}

              {hasNextEpisode && onNextEpisode && (
                <button 
                  onClick={onNextEpisode}
                  className="hidden md:flex items-center gap-2 text-white hover:text-gray-300 font-bold bg-white/10 px-4 py-2 rounded-md border border-white/20 transition-all"
                >
                  <FastForward size={20} /> Próximo
                </button>
              )}

              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setObjectFit(f => f === 'contain' ? 'cover' : 'contain');
                }}
                className="text-white hover:text-gray-300 md:hidden"
                title={objectFit === 'contain' ? "Preencher Tela" : "Ajustar à Tela"}
              >
                {objectFit === 'contain' ? <ZoomIn size={28} /> : <ZoomOut size={28} />}
              </button>

              {episodes && episodes.length > 0 && (
                <button 
                  onClick={() => {
                    setShowEpisodesSidebar(true);
                    setShowControls(false);
                  }}
                  className="text-white hover:text-gray-300 md:hidden"
                  title="Episódios"
                >
                  <Tv size={28} />
                </button>
              )}

              {hasNextEpisode && onNextEpisode && (
                <button 
                  onClick={onNextEpisode}
                  className="text-white hover:text-gray-300 md:hidden"
                  title="Próximo Episódio"
                >
                  <FastForward size={28} />
                </button>
              )}

              <button onClick={toggleFullscreen} className="text-white hover:scale-110 transition-transform">
                {isFullscreen ? <Minimize size={28} className="md:w-8 md:h-8" /> : <Maximize size={28} className="md:w-8 md:h-8" />}
              </button>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* TV Sharing Overlay Fallback */}
      <AnimatePresence>
        {showTvShare && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[500] bg-black/90 backdrop-blur-3xl flex items-center justify-center p-6"
            onClick={() => setShowTvShare(false)}
          >
            <motion.div 
              initial={{ scale: 0.8, y: 50 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#141414] border border-white/10 rounded-[3rem] p-10 max-w-sm w-full text-center space-y-8 shadow-[0_0_100px_rgba(220,38,38,0.3)]"
              onClick={e => e.stopPropagation()}
            >
                <div className="flex flex-col items-center">
                   <div className="w-16 h-16 bg-red-600/20 rounded-2xl flex items-center justify-center mb-6">
                      <Tv className="text-red-600" size={32} />
                   </div>
                   <h3 className="text-2xl font-black text-white uppercase italic tracking-tighter text-center">Transmitir para TV</h3>
                   <p className="text-gray-500 text-sm mt-2 leading-relaxed text-center">Assista em tela grande usando o navegador da sua TV:</p>
                </div>
                
                <div className="space-y-4 text-left">
                   <div className="bg-white/5 p-6 rounded-[2rem] border border-white/10 space-y-4">
                      <div className="flex gap-4 items-start">
                         <div className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 mt-0.5 shadow-lg shadow-red-600/20">1</div>
                         <p className="text-white text-[11px] font-bold uppercase tracking-wider italic">Abra o Navegador (Browser) da sua Smart TV.</p>
                      </div>
                      <div className="flex gap-4 items-start">
                         <div className="w-6 h-6 bg-red-600 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 mt-0.5 shadow-lg shadow-red-600/20">2</div>
                         <p className="text-white text-[11px] font-bold uppercase tracking-wider italic">Acesse este endereço:</p>
                      </div>
                      <div className="bg-black/60 p-4 rounded-xl border border-white/10 text-center">
                         <span className="text-red-600 font-mono font-black text-xl tracking-tighter">{window.location.hostname}</span>
                      </div>
                   </div>
                </div>

                <div className="space-y-4">
                   <div className="flex flex-col items-center gap-2">
                      <p className="text-gray-500 text-[10px] font-black uppercase tracking-widest italic animate-pulse">Ou use o QR Code:</p>
                      <div className="bg-white p-4 rounded-2xl shadow-2xl">
                         <QRCodeSVG 
                          value={window.location.href} 
                          size={120}
                          level="H"
                          includeMargin={false}
                         />
                      </div>
                   </div>
                   <button 
                     onClick={() => setShowTvShare(false)}
                     className="w-full bg-white text-black py-4 rounded-2xl font-black uppercase tracking-widest text-xs italic shadow-xl"
                   >
                     Continuar no Celular
                   </button>
                </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Marca d'água quando os controles somem */}
      <AnimatePresence>
        {!showControls && !isLoading && !error && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 0.5, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute bottom-6 left-0 right-0 z-[300] flex items-center justify-center pointer-events-none"
          >
            <div className="flex items-center gap-3 bg-black/20 backdrop-blur-sm px-4 py-1.5 rounded-full border border-white/5">
               {logoUrl ? (
                 <img 
                   src={logoUrl.startsWith('http') ? logoUrl : `https://image.tmdb.org/t/p/w200/${logoUrl}`}
                   alt=""
                   className="h-4 md:h-6 object-contain"
                   referrerPolicy="no-referrer"
                 />
               ) : (
                 <span className="text-white font-black italic uppercase text-[8px] md:text-[10px] tracking-tight opacity-70">{title}</span>
               )}
               
               <div className="w-px h-3 bg-white/20" />
               
               <div className="flex items-center gap-1.5">
                 <div className="w-4 h-4 md:w-5 md:h-5 bg-red-600 rounded-md flex items-center justify-center">
                    <Play size={8} fill="white" className="text-white ml-0.5" />
                 </div>
                 <span className="text-white font-black text-[10px] md:text-xs italic uppercase tracking-tighter">Net<span className="text-red-600">play</span></span>
               </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Botão de Fechar Dedicado para Iframe Mode */}
      {isIframeMode && (
         <button 
           onClick={onClose} 
           className="absolute top-6 left-6 z-[400] bg-black/60 backdrop-blur-md p-3 rounded-full text-white hover:bg-red-600 transition-colors pointer-events-auto shadow-2xl border border-white/10"
         >
            <ChevronLeft size={32} strokeWidth={3} />
         </button>
      )}

      </div>
  );
};

export default NetflixPlayer;
