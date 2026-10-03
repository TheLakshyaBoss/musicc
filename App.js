import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  ScrollView,
  Dimensions,
  useWindowDimensions,
  Image,
  Modal,
  Animated,
  Easing,
  TextInput,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';
import * as ImageManipulator from 'expo-image-manipulator';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';

const HF_BASE_URL = 'https://huggingface.co/datasets/lakshya1234/my-audio-app/resolve/main';

const COLORS = {
  bg: '#0A0A0C',
  surface: '#121215',
  card: '#18181D',
  cardActive: '#222228',
  green: '#1DB954',
  greenPress: '#1ED760',
  white: '#FFFFFF',
  gray: '#B8B8C0',
  grayDim: '#6D6D78',
  border: '#23232A',
  borderSubtle: '#1C1C22',
};

const { width: SCREEN_W } = Dimensions.get('window');
const ITEM_HEIGHT = 72;
const LYRIC_BOX_HEIGHT = 220;
const LINE_HEIGHT_SLOT = 70;
const NO_REPEAT_WINDOW = 6;
const RECENT_HISTORY_LIMIT = 15;
const INITIAL_VISIBLE_COUNT = 12;
const FILTER_GENRES = ['all', 'aura', 'love', 'sad', 'happy'];
const DEFAULT_ACCENT = '#3A3A42';

const TILE_GAP = 12;
const PADDING_H = 18;
const TILE_WIDTH = (SCREEN_W - PADDING_H * 2 - TILE_GAP * 2) / 3;

// --- High-Performance Smart Fuzzy Matching ---
function smartFuzzyMatch(targetStr, searchStr) {
  if (!searchStr) return true;
  if (!targetStr) return false;

  const target = targetStr.toLowerCase();
  const search = searchStr.toLowerCase().trim();

  if (target.includes(search)) return true;

  const searchWords = search.split(/\s+/).filter(Boolean);
  if (searchWords.length > 1 && searchWords.every((w) => target.includes(w))) return true;

  const cleanTarget = target.replace(/[^a-z0-9]/g, '');
  const cleanSearch = search.replace(/[^a-z0-9]/g, '');
  if (cleanTarget.includes(cleanSearch)) return true;

  let tIdx = 0;
  let sIdx = 0;
  while (tIdx < cleanTarget.length && sIdx < cleanSearch.length) {
    if (cleanTarget[tIdx] === cleanSearch[sIdx]) sIdx++;
    tIdx++;
  }
  return sIdx === cleanSearch.length;
}

// --- Spotify-Style Acoustic Feature Distance Engine ---
function computeAcousticDistance(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length < 4 || vecB.length < 4) {
    return 0.5;
  }

  const bpmA = vecA[0];
  const bpmB = vecB[0];
  
  const diffStandard = Math.abs(bpmA - bpmB);
  const diffHalf = Math.abs(bpmA - bpmB * 0.5);
  const diffDouble = Math.abs(bpmA * 0.5 - bpmB);
  const minBpmDiff = Math.min(diffStandard, diffHalf, diffDouble);

  const rmsDiff = Math.abs(vecA[1] - vecB[1]);
  const centroidDiff = Math.abs(vecA[2] - vecB[2]);
  const pulseDiff = Math.abs(vecA[3] - vecB[3]);

  return Math.sqrt(
    Math.pow(minBpmDiff, 2) * 0.35 +
    Math.pow(rmsDiff, 2) * 0.35 +
    Math.pow(centroidDiff, 2) * 0.12 +
    Math.pow(pulseDiff, 2) * 0.18
  );
}

function pickSmartNextIndex(tracks, currentTrack, recentIds = []) {
  if (!tracks || !tracks.length) return -1;
  if (tracks.length === 1) return 0;

  const windowSize = typeof NO_REPEAT_WINDOW !== 'undefined' ? NO_REPEAT_WINDOW : 6;
  const blocked = new Set(recentIds.slice(-windowSize));
  if (currentTrack?.id) blocked.add(currentTrack.id);

  let pool = tracks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !blocked.has(t.id));

  if (pool.length === 0) {
    pool = tracks
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.id !== currentTrack?.id);
  }
  if (pool.length === 0) return 0;

  const curGenre = (currentTrack?.genre || '').toLowerCase().trim();
  const curArtist = (currentTrack?.artist || '').toLowerCase().trim();
  const curVector = currentTrack?.audio_vector;

  const recentArtistCount = recentIds.slice(-4).reduce((cnt, id) => {
    const item = tracks.find((x) => x.id === id);
    return item && item.artist?.toLowerCase().trim() === curArtist ? cnt + 1 : cnt;
  }, 0);

  const jumpGenre = Math.random() < 0.12;

  const scored = pool.map(({ t, idx }) => {
    const tGenre = (t.genre || '').toLowerCase().trim();
    const tArtist = (t.artist || '').toLowerCase().trim();
    const isSameGenre = curGenre && tGenre && curGenre === tGenre;
    const isSameArtist = curArtist && tArtist && curArtist === tArtist;

    let score = 0;

    if (curVector && t.audio_vector) {
      const dist = computeAcousticDistance(curVector, t.audio_vector);
      score += Math.max(0, (0.75 - dist) * 16.0);

      // --- STRICT MOOD GATES (Fixes the Sad Song -> Phonk Bug) ---
      const energyDiff = Math.abs(curVector[1] - t.audio_vector[1]);
      const centroidDiff = Math.abs(curVector[2] - t.audio_vector[2]);
      
      if (energyDiff > 0.35) {
        score -= 15.0; // Severe penalty for massive energy shift
      }
      if (centroidDiff > 0.40) {
        score -= 10.0; // Severe penalty for massive tone/brightness shift
      }
    } else {
      score += 5.0;
    }

    if (!jumpGenre && isSameGenre) {
      score += 7.0;
    } else if (jumpGenre && !isSameGenre) {
      score += 5.5;
    }

    if (isSameArtist) {
      if (recentArtistCount >= 1) {
        score -= 2.0;
      } else {
        score += 2.8;
      }
    }

    score += Math.random() * 1.2;
    return { idx, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topCluster = scored.slice(0, Math.min(3, scored.length));
  const chosen = topCluster[Math.floor(Math.random() * topCluster.length)];
  return chosen.idx;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

// Wrapped in memo with strict dependency tracking to eliminate FlatList UI lag
const TrackRowItem = memo(({ item, isSelected, isPlaying, onSelect }) => {
  return (
    <TouchableOpacity
      activeOpacity={0.65}
      style={[styles.trackRow, isSelected && styles.trackRowSelected]}
      onPress={() => onSelect(item.id)}
    >
      <View style={styles.trackCoverContainer}>
        {item.cover ? (
          <Image
            source={{ uri: `${HF_BASE_URL}/${item.cover}` }}
            style={styles.trackCoverImage}
          />
        ) : (
          <View style={styles.trackArt}>
            <Text style={styles.trackArtGlyph}>♪</Text>
          </View>
        )}
      </View>

      <View style={styles.trackDetails}>
        <Text numberOfLines={1} style={[styles.trackTitle, isSelected && styles.trackTitleActive]}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={styles.trackSubtitle}>
          {(item.artist || 'Unknown artist') + (item.genre ? ` • ${item.genre}` : '')}
        </Text>
      </View>

      {isSelected && (
        <View style={styles.indicatorWrap}>
          {isPlaying ? (
            <View style={styles.nowPlayingDotPulse} />
          ) : (
            <View style={[styles.nowPlayingDotPulse, { backgroundColor: COLORS.grayDim }]} />
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}, (prev, next) => {
  return prev.item.id === next.item.id && 
         prev.isSelected === next.isSelected && 
         prev.isPlaying === next.isPlaying;
});

const SpeedDialSection = memo(({ pages, currentTrackId, onSelect }) => {
  if (!pages.length) return null;

  return (
    <View style={styles.speedDialContainer}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Speed dial</Text>
      </View>
      <ScrollView
        horizontal
        pagingEnabled
        nestedScrollEnabled
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        style={styles.speedDialScroll}
      >
        {pages.map((pageTracks, pIdx) => (
          <View key={pIdx} style={[styles.speedDialPage, { width: SCREEN_W }]}>
            {pageTracks.map((item) => {
              const isSelected = currentTrackId === item.id;
              return (
                <TouchableOpacity
                  key={item.id}
                  activeOpacity={0.7}
                  style={styles.speedDialTile}
                  onPress={() => onSelect(item.id)}
                >
                  <View style={[styles.speedDialCoverWrapper, isSelected && styles.speedDialCoverActive]}>
                    {item.cover ? (
                      <Image
                        source={{ uri: `${HF_BASE_URL}/${item.cover}` }}
                        style={styles.speedDialCover}
                      />
                    ) : (
                      <View style={styles.speedDialCoverFallback}>
                        <Text style={styles.trackArtGlyph}>♪</Text>
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={1} style={[styles.speedDialTitle, isSelected && styles.trackTitleActive]}>
                    {item.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.speedDialSubtitle}>
                    {item.artist || 'Unknown artist'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
});

function AppContent() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  const [rawTracks, setRawTracks] = useState([]);
  const [randomizedTracks, setRandomizedTracks] = useState([]);
  const [speedDialTracks, setSpeedDialTracks] = useState([]);
  const [selectedGenre, setSelectedGenre] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  
  const [currentIndex, setCurrentIndex] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lyrics, setLyrics] = useState([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [lyricsModalOpen, setLyricsModalOpen] = useState(false);
  const [smoothTime, setSmoothTime] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [dominantColor, setDominantColor] = useState(DEFAULT_ACCENT);

  const scrollY = useRef(new Animated.Value(0)).current;
  const fastTimer = useRef(null);
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const recentIdsRef = useRef([]);
  const backStackRef = useRef([]);

  // Transition & Loop Guards
  const isTransitioningRef = useRef(false);
  const activeTrackLoadedRef = useRef(false);
  
  const currentIndexRef = useRef(currentIndex);
  const rawTracksRef = useRef(rawTracks);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    rawTracksRef.current = rawTracks;
  }, [rawTracks]);

  const currentTrack = currentIndex !== null && rawTracks[currentIndex] ? rawTracks[currentIndex] : null;

  // We explicitly bypass hook-based auto-reloading to prevent background freezing
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 120);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      staysActiveInBackground: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${HF_BASE_URL}/playlist.json`)
      .then((res) => res.json())
      .then((data) => {
        setRawTracks(data);

        const sortedByNewest = [...data].sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
        const latestTrack = sortedByNewest[0];
        const remainingTracks = data.filter((t) => t.id !== latestTrack?.id);

        const speedDialPicks = latestTrack
          ? [latestTrack, ...shuffleArray(remainingTracks).slice(0, 26)]
          : shuffleArray(data).slice(0, 27);

        setSpeedDialTracks(speedDialPicks);
        setRandomizedTracks(shuffleArray(data));
        setLoading(false);
      })
      .catch((err) => {
        console.error('Error fetching playlist:', err);
        setLoading(false);
      });
  }, []);

  // Sync lyrics when current track changes
  useEffect(() => {
    setCurrentLineIndex(-1);
    setSmoothTime(0);
    scrollY.setValue(0);
    activeTrackLoadedRef.current = false;

    if (!currentTrack || !currentTrack.lrc) {
      setLyrics([]);
      return;
    }

    fetch(`${HF_BASE_URL}/${currentTrack.lrc}`)
      .then((res) => res.text())
      .then((lrcText) => setLyrics(parseLRC(lrcText)))
      .catch(() => {
        setLyrics([]);
      });
  }, [currentTrack?.id]);

  const [colorProbeDataUri, setColorProbeDataUri] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDominantColor(DEFAULT_ACCENT);
    setColorProbeDataUri(null);

    if (!currentTrack?.cover) return;
    const coverUrl = encodeURI(`${HF_BASE_URL}/${currentTrack.cover}`);
    
    ImageManipulator.manipulateAsync(coverUrl, [{ resize: { width: 64 } }], {
      base64: true,
      compress: 0.6,
      format: ImageManipulator.SaveFormat.JPEG,
    })
      .then((result) => {
        if (cancelled || !result?.base64) return;
        setColorProbeDataUri(`data:image/jpeg;base64,${result.base64}`);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.cover]);

  const handleColorProbeMessage = useCallback((event) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (payload.ok && payload.color) {
        setDominantColor(payload.color);
      }
    } catch (err) {}
  }, []);

  const colorProbeHtml = colorProbeDataUri ? buildColorProbeHtml(colorProbeDataUri) : null;

  useEffect(() => {
    if (fastTimer.current) clearInterval(fastTimer.current);

    fastTimer.current = setInterval(() => {
      if (!player || seeking) return;
      try {
        const t = player.currentTime ?? status?.currentTime ?? 0;
        setSmoothTime(t);
        // Mark active only once the track has reliably started playing
        if (t > 0.5) {
          activeTrackLoadedRef.current = true;
          isTransitioningRef.current = false;
        }
      } catch (err) {}
    }, 250);

    return () => clearInterval(fastTimer.current);
  }, [player, seeking, status?.currentTime]);

  useEffect(() => {
    if (!lyrics.length) return;

    let activeIndex = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (smoothTime >= lyrics[i].time) {
        activeIndex = i;
      } else {
        break;
      }
    }

    if (activeIndex !== currentLineIndex) {
      setCurrentLineIndex(activeIndex);

      if (activeIndex >= 0) {
        const targetTranslateY = -(activeIndex * LINE_HEIGHT_SLOT - (LYRIC_BOX_HEIGHT / 2 - LINE_HEIGHT_SLOT / 2));

        Animated.timing(scrollY, {
          toValue: targetTranslateY,
          duration: 250,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      }
    }
  }, [smoothTime, lyrics]);

  // =========================================================================
  // CORE BACKGROUND PLAYBACK ENGINE - Synchronous Imperative Execution
  // =========================================================================
  const playTrackIndex = useCallback((idx) => {
    const list = rawTracksRef.current;
    const track = list[idx];
    if (!track || !player) return;

    // Lock transition to prevent loops
    isTransitioningRef.current = true;
    activeTrackLoadedRef.current = false;
    setCurrentIndex(idx);

    const targetUrl = `${HF_BASE_URL}/${track.file}`;

    // SYNCHRONOUS COMMANDS: This ensures Android/iOS background services 
    // never sleep the JS thread because we instruct the native module instantly.
    try {
      player.replace(targetUrl);
      player.play();
    } catch (e) {}

    try {
      player.setActiveForLockScreen(
        true,
        {
          title: track.title,
          artist: track.artist || 'Unknown artist',
          artworkUrl: track.cover ? `${HF_BASE_URL}/${track.cover}` : undefined,
        },
        {
          showSeekForward: true,
          showSeekBackward: true,
        }
      );
    } catch (e) {}

    // Failsafe unlock in case buffering takes longer than 1.5s
    setTimeout(() => {
      isTransitioningRef.current = false;
    }, 1500);
  }, [player]);

  const playNext = useCallback(() => {
    const list = rawTracksRef.current;
    const curIdx = currentIndexRef.current;
    if (!list.length || curIdx === null || isTransitioningRef.current) return;

    const current = list[curIdx];
    if (current) {
      recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
      backStackRef.current = [...backStackRef.current, curIdx].slice(-50);
    }

    const nextIdx = pickSmartNextIndex(list, current, recentIdsRef.current);
    playTrackIndex(nextIdx >= 0 ? nextIdx : (curIdx + 1) % list.length);
  }, [playTrackIndex]);

  const playPrev = useCallback(() => {
    const list = rawTracksRef.current;
    const curIdx = currentIndexRef.current;
    if (!list.length || curIdx === null || isTransitioningRef.current) return;

    const prevIdx = backStackRef.current.length ? backStackRef.current.pop() : undefined;
    if (prevIdx !== undefined && prevIdx !== curIdx) {
      playTrackIndex(prevIdx);
    } else {
      playTrackIndex((curIdx - 1 + list.length) % list.length);
    }
  }, [playTrackIndex]);

  const togglePlayPause = useCallback(() => {
    if (!player || currentIndexRef.current === null) return;
    try {
      if (player.playing || status?.isPlaying) {
        player.pause();
      } else {
        player.play();
      }
    } catch (err) {}
  }, [player, status?.isPlaying]);

  // Keep fresh references for native listeners
  const playNextRef = useRef(playNext);
  const playPrevRef = useRef(playPrev);
  const togglePlayPauseRef = useRef(togglePlayPause);

  useEffect(() => {
    playNextRef.current = playNext;
    playPrevRef.current = playPrev;
    togglePlayPauseRef.current = togglePlayPause;
  });

  // Native Background Event Listener for Track End
  useEffect(() => {
    if (!player || typeof player.addListener !== 'function') return;
    const subs = [];

    const handlePlaybackState = (s) => {
      if (!s || isTransitioningRef.current || !activeTrackLoadedRef.current) return;

      const dur = s.duration || 0;
      const cur = s.currentTime || 0;

      const isEnded =
        s.didJustFinish === true ||
        s.isFinished === true ||
        (dur > 0 && cur >= dur - 0.35 && cur > 2 && s.isPlaying === false);

      if (isEnded) {
        playNextRef.current();
      }
    };

    try {
      const statusSub = player.addListener('playbackStatusUpdate', handlePlaybackState);
      if (statusSub) subs.push(statusSub);
    } catch (e) {}

    try {
      const endSub = player.addListener('playbackEnded', () => {
        if (!isTransitioningRef.current && activeTrackLoadedRef.current) {
          playNextRef.current();
        }
      });
      if (endSub) subs.push(endSub);
    } catch (e) {}

    return () => {
      subs.forEach((s) => {
        try { s?.remove?.(); } catch (e) {}
      });
    };
  }, [player]);

  const selectTrackById = useCallback((trackId) => {
    setRawTracks((currentRaw) => {
      const targetIdx = currentRaw.findIndex((t) => t.id === trackId);
      if (targetIdx !== -1) {
        if (currentIndexRef.current !== null && currentRaw[currentIndexRef.current]) {
          const current = currentRaw[currentIndexRef.current];
          recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
          backStackRef.current = [...backStackRef.current, currentIndexRef.current].slice(-50);
        }
        playTrackIndex(targetIdx);
        setPlayerOpen(true);
      }
      return currentRaw;
    });
  }, [playTrackIndex]);

  // Bluetooth earphone controls
  useEffect(() => {
    if (!player || typeof player.addListener !== 'function') return;

    const subscriptions = [];
    const addSafe = (eventName, callback) => {
      try {
        const sub = player.addListener(eventName, callback);
        if (sub) subscriptions.push(sub);
      } catch (e) {}
    };

    addSafe('onRemoteNextTrack', () => playNextRef.current());
    addSafe('onRemoteSkipToNext', () => playNextRef.current());
    addSafe('seekForward', () => playNextRef.current());

    addSafe('onRemotePreviousTrack', () => playPrevRef.current());
    addSafe('onRemoteSkipToPrevious', () => playPrevRef.current());
    addSafe('seekBackward', () => playPrevRef.current());

    addSafe('onRemotePlay', () => {
      try { player.play(); } catch (e) {}
    });
    addSafe('onRemotePause', () => {
      try { player.pause(); } catch (e) {}
    });
    addSafe('onRemoteTogglePlayPause', () => togglePlayPauseRef.current());

    return () => {
      subscriptions.forEach((sub) => {
        try { sub?.remove?.(); } catch (e) {}
      });
    };
  }, [player]);

  const duration = status?.duration || 0;
  const displayTime = seeking ? seekValue : smoothTime;
  const progressPct = duration > 0 ? Math.min(displayTime / duration, 1) : 0;
  const isPlaying = status?.isPlaying ?? player?.playing ?? false;
  
  // Buffering state to show UI spinner instead of freezing
  const isBuffering = currentIndex !== null && (!status?.isLoaded || status?.isBuffering);

  const nowPlayingTheme = useMemo(() => {
    const top = darkenColor(dominantColor, 0.45);
    const bottom = darkenColor(dominantColor, 0.90);
    const cardBg = darkenColor(dominantColor, 0.74);
    const highlight = lightenColor(dominantColor, 0.55);
    return { top, bottom, cardBg, highlight };
  }, [dominantColor]);

  const speedDialPages = useMemo(() => {
    if (!speedDialTracks.length) return [];
    const pages = [];
    for (let i = 0; i < speedDialTracks.length; i += 9) {
      pages.push(speedDialTracks.slice(i, i + 9));
    }
    return pages;
  }, [speedDialTracks]);

  const filteredTracks = useMemo(() => {
    let pool = randomizedTracks;
    
    if (selectedGenre !== 'all') {
      pool = pool.filter(
        (t) => (t.genre || '').toLowerCase().trim() === selectedGenre.toLowerCase().trim()
      );
    }

    const query = debouncedSearch.trim();
    if (query) {
      pool = pool.filter((t) => {
        const titleMatch = smartFuzzyMatch(t.title, query);
        const artistMatch = smartFuzzyMatch(t.artist, query);
        return titleMatch || artistMatch;
      });
    }

    return pool;
  }, [randomizedTracks, selectedGenre, debouncedSearch]);

  const displayedTracks = useMemo(() => {
    if (debouncedSearch.trim().length > 0 || isExpanded) return filteredTracks;
    return filteredTracks.slice(0, INITIAL_VISIBLE_COUNT);
  }, [filteredTracks, isExpanded, debouncedSearch]);

  const handleFilterPress = useCallback((genre) => {
    if (genre === 'all') {
      setRandomizedTracks(shuffleArray(rawTracks));
      setSelectedGenre('all');
    } else {
      setSelectedGenre(genre);
    }
  }, [rawTracks]);

  const handleSeekBarPress = (evt) => {
    if (!duration || !player) return;
    const x = evt.nativeEvent.locationX;
    const liveSeekBarWidth = windowWidth - 48;
    const pct = Math.max(0, Math.min(x / liveSeekBarWidth, 1));
    const newTime = pct * duration;
    setSeeking(true);
    setSeekValue(newTime);
    try {
      player.seekTo(newTime);
      setSmoothTime(newTime);
    } catch (err) {}
    setTimeout(() => setSeeking(false), 120);
  };

  const getItemLayout = useCallback((_, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  }), []);

  const renderItem = useCallback(({ item }) => {
    const isSel = currentTrack?.id === item.id;
    return (
      <TrackRowItem
        item={item}
        isSelected={isSel}
        isPlaying={isSel ? isPlaying : false} 
        onSelect={selectTrackById}
      />
    );
  }, [currentTrack?.id, isPlaying, selectTrackById]);

  const listHeader = useMemo(() => (
    <View>
      <SpeedDialSection
        pages={speedDialPages}
        currentTrackId={currentTrack?.id}
        onSelect={selectTrackById}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterBar}
      >
        {FILTER_GENRES.map((genre) => {
          const active = selectedGenre === genre;
          return (
            <TouchableOpacity
              key={genre}
              activeOpacity={0.8}
              style={[styles.filterPill, active && styles.filterPillActive]}
              onPress={() => handleFilterPress(genre)}
            >
              <Text style={[styles.filterPillText, active && styles.filterPillTextActive]}>
                {genre.charAt(0).toUpperCase() + genre.slice(1)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Real-time Fuzzy Search Box */}
      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={17} color={COLORS.grayDim} style={styles.searchIcon} />
        <TextInput
          placeholder="Search songs, artists..."
          placeholderTextColor={COLORS.grayDim}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close-circle" size={18} color={COLORS.grayDim} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Songs</Text>
        <Text style={styles.songCountText}>
          {filteredTracks.length} {debouncedSearch.trim().length > 0 ? 'Found' : 'Tracks'}
        </Text>
      </View>
    </View>
  ), [speedDialPages, currentTrack?.id, selectTrackById, selectedGenre, handleFilterPress, filteredTracks.length, searchQuery, debouncedSearch]);

  const listFooter = useMemo(() => {
    if (debouncedSearch.trim().length > 0 || filteredTracks.length <= INITIAL_VISIBLE_COUNT) return null;
    return (
      <TouchableOpacity
        activeOpacity={0.7}
        style={styles.seeMoreButton}
        onPress={() => setIsExpanded((prev) => !prev)}
      >
        <Text style={styles.seeMoreText}>
          {isExpanded ? 'Show Less' : `See More (${filteredTracks.length - INITIAL_VISIBLE_COUNT} More)`}
        </Text>
        <Ionicons
          name={isExpanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={COLORS.white}
          style={{ marginLeft: 6 }}
        />
      </TouchableOpacity>
    );
  }, [filteredTracks.length, isExpanded, debouncedSearch]);

  if (!fontsLoaded || loading) {
    return (
      <View style={[styles.center, { backgroundColor: COLORS.bg }]}>
        <ActivityIndicator size="large" color={COLORS.green} />
        <Text style={styles.loadingText}>Loading library…</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      {colorProbeHtml && (
        <WebView
          key={colorProbeDataUri}
          originWhitelist={['*']}
          source={{ html: colorProbeHtml }}
          onMessage={handleColorProbeMessage}
          style={styles.hiddenColorProbe}
          pointerEvents="none"
          javaScriptEnabled
          domStorageEnabled={false}
          mediaPlaybackRequiresUserAction={false}
        />
      )}

      <FlatList
        data={displayedTracks}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        initialNumToRender={10}
        maxToRenderPerBatch={8}
        windowSize={5}
        updateCellsBatchingPeriod={50}
        removeClippedSubviews={true}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: (currentTrack ? 104 : 24) + insets.bottom }}
      />

      {/* Floating Modern Mini Player */}
      {currentTrack && (
        <TouchableOpacity
          activeOpacity={0.94}
          style={[styles.miniPlayer, { bottom: 12 + insets.bottom }]}
          onPress={() => setPlayerOpen(true)}
        >
          <View style={styles.miniProgressTrack}>
            <View style={[styles.miniProgressFill, { width: `${progressPct * 100}%` }]} />
          </View>
          <View style={styles.miniPlayerContent}>
            {currentTrack.cover ? (
              <Image
                source={{ uri: `${HF_BASE_URL}/${currentTrack.cover}` }}
                style={styles.miniCoverImage}
              />
            ) : (
              <View style={styles.trackArtSmall}>
                <Text style={styles.trackArtGlyph}>♪</Text>
              </View>
            )}
            <View style={{ flex: 1, marginLeft: 12, justifyContent: 'center' }}>
              <Text numberOfLines={1} style={styles.miniTitle}>{currentTrack.title}</Text>
              <Text numberOfLines={1} style={styles.miniSubtitle}>
                {(currentTrack.artist || 'Unknown artist') + (currentTrack.genre ? ` • ${currentTrack.genre}` : '')}
              </Text>
            </View>
            <TouchableOpacity 
              onPress={togglePlayPause} 
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              style={styles.miniPlayBtn}
            >
              {isBuffering ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color={COLORS.white} />
              )}
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      )}

      {/* Full Player Modal */}
      <Modal visible={playerOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setPlayerOpen(false)}>
        <LinearGradient
          colors={[nowPlayingTheme.top, nowPlayingTheme.bottom]}
          style={{ flex: 1 }}
        >
          <SafeAreaView style={[styles.fullPlayer, { backgroundColor: 'transparent' }]}>
            <View style={styles.fullPlayerHeader}>
              <TouchableOpacity
                onPress={() => setPlayerOpen(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                style={styles.chevronButton}
              >
                <Ionicons name="chevron-down" size={24} color={COLORS.white} />
              </TouchableOpacity>
              <Text style={styles.fullPlayerHeaderLabel} numberOfLines={1}>PLAYING FROM LIBRARY</Text>
              <View style={{ width: 32 }} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 + insets.bottom }} showsVerticalScrollIndicator={false}>
              <View style={styles.albumArtWrap}>
                {currentTrack?.cover ? (
                  <Image
                    source={{ uri: `${HF_BASE_URL}/${currentTrack.cover}` }}
                    style={[
                      styles.albumArtImage,
                      { width: windowWidth - 84, height: windowWidth - 84 },
                    ]}
                  />
                ) : (
                  <View
                    style={[
                      styles.albumArt,
                      { width: windowWidth - 84, height: windowWidth - 84 },
                    ]}
                  >
                    <Text style={styles.albumArtGlyph}>♪</Text>
                  </View>
                )}
              </View>

              <View style={styles.fullTrackInfo}>
                <View style={styles.titleGenreRow}>
                  <Text style={styles.fullTrackTitle} numberOfLines={1}>{currentTrack?.title}</Text>
                  {currentTrack?.genre ? (
                    <View style={styles.genreBadge}>
                      <Text style={styles.genreBadgeText}>{currentTrack.genre}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.fullTrackArtist} numberOfLines={1}>{currentTrack?.artist || 'Unknown artist'}</Text>
              </View>

              <TouchableOpacity activeOpacity={1} style={styles.seekBarTouchable} onPress={handleSeekBarPress}>
                <View style={styles.seekTrack}>
                  <View style={[styles.seekFill, { width: `${progressPct * 100}%` }]} />
                  <View style={[styles.seekThumb, { left: `${progressPct * 100}%` }]} />
                </View>
              </TouchableOpacity>
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(displayTime)}</Text>
                <Text style={styles.timeText}>{formatTime(duration)}</Text>
              </View>

              <View style={styles.controlsRow}>
                <TouchableOpacity onPress={playPrev} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}>
                  <Ionicons name="play-skip-back" size={30} color={COLORS.white} />
                </TouchableOpacity>
                <TouchableOpacity onPress={togglePlayPause} style={styles.playPauseCircle} activeOpacity={0.85}>
                  {isBuffering ? (
                    <ActivityIndicator size="small" color={COLORS.bg} />
                  ) : (
                    <Ionicons
                      name={isPlaying ? 'pause' : 'play'}
                      size={30}
                      color={COLORS.bg}
                      style={{ marginLeft: isPlaying ? 0 : 3 }}
                    />
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={playNext} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}>
                  <Ionicons name="play-skip-forward" size={30} color={COLORS.white} />
                </TouchableOpacity>
              </View>

              {/* Lyrics Box */}
              <TouchableOpacity
                activeOpacity={0.9}
                style={[styles.lyricsBoxCard, { backgroundColor: nowPlayingTheme.cardBg }]}
                onPress={() => setLyricsModalOpen(true)}
              >
                <View style={styles.lyricsBoxHeader}>
                  <Text style={styles.lyricsBoxTitle}>Lyrics</Text>
                  <Ionicons name="expand-outline" size={18} color={COLORS.white} />
                </View>

                {lyrics.length > 0 ? (
                  <View style={styles.lyricsViewport}>
                    <Animated.View style={{ transform: [{ translateY: scrollY }] }}>
                      {lyrics.map((line, idx) => {
                        const isCurrent = idx === currentLineIndex;
                        return (
                          <View key={idx} style={styles.lyricLineSlot}>
                            <Text
                              style={[
                                styles.lyricLineText,
                                isCurrent
                                  ? [styles.lyricLineActive, { color: nowPlayingTheme.highlight }]
                                  : styles.lyricLineInactive,
                              ]}
                            >
                              {line.text || '♪'}
                            </Text>
                          </View>
                        );
                      })}
                    </Animated.View>
                  </View>
                ) : (
                  <View style={styles.noLyricsContainer}>
                    <Text style={styles.noLyricsText}>
                      {currentTrack?.lrc ? 'Loading synchronized lyrics…' : 'No lyrics available'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </LinearGradient>

        {/* Full Expanded Lyrics Modal */}
        <Modal
          visible={lyricsModalOpen}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setLyricsModalOpen(false)}
        >
          <LinearGradient colors={[nowPlayingTheme.top, nowPlayingTheme.bottom]} style={{ flex: 1 }}>
            <SafeAreaView style={[styles.expandedLyricsContainer, { backgroundColor: 'transparent' }]}>
              <View style={styles.expandedHeader}>
                <Text style={styles.expandedTitle} numberOfLines={1}>{currentTrack?.title}</Text>
                <TouchableOpacity onPress={() => setLyricsModalOpen(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={26} color={COLORS.white} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingVertical: 40, paddingHorizontal: 24 }}
                showsVerticalScrollIndicator={true}
              >
                {lyrics.map((line, idx) => {
                  const isCurrent = idx === currentLineIndex;
                  return (
                    <Text
                      key={idx}
                      style={[
                        styles.expandedLyricLine,
                        isCurrent
                          ? [styles.expandedLyricActive, { color: nowPlayingTheme.highlight }]
                          : styles.expandedLyricInactive,
                      ]}
                    >
                      {line.text || '♪'}
                    </Text>
                  );
                })}
              </ScrollView>
            </SafeAreaView>
          </LinearGradient>
        </Modal>
      </Modal>
    </SafeAreaView>
  );
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseLRC(lrcText) {
  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
      const totalTime = minutes * 60 + seconds + milliseconds / 1000;
      const text = line.replace(timeRegex, '').trim();
      result.push({ time: totalTime, text });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function hexToRgb(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) h = '535353';
  const num = parseInt(h, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex(r, g, b) {
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
  );
}

function darkenColor(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
}

function lightenColor(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor);
}

function buildColorProbeHtml(dataUri) {
  const safeDataUri = JSON.stringify(dataUri);
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html, body { margin: 0; padding: 0; background: transparent; }</style>
  </head>
  <body>
    <canvas id="c" style="display:none"></canvas>
    <script>
      function send(payload) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(payload));
        }
      }
      function toHex(n) {
        var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return h.length === 1 ? '0' + h : h;
      }
      function run(uri) {
        var img = new Image();
        img.onload = function () {
          try {
            var size = 48;
            var canvas = document.getElementById('c');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, size, size);
            var data = ctx.getImageData(0, 0, size, size).data;

            var pixels = [];
            var rSumAll = 0, gSumAll = 0, bSumAll = 0, countAll = 0;

            for (var i = 0; i < data.length; i += 4) {
              var r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
              if (a < 100) continue;
              rSumAll += r; gSumAll += g; bSumAll += b; countAll++;

              var max = Math.max(r, g, b) / 255;
              var min = Math.min(r, g, b) / 255;
              var l = (max + min) / 2;
              var s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
              pixels.push({ r: r, g: g, b: b, l: l, s: s });
            }

            var BUCKET = 24;
            var tiers = [
              { minL: 0.16, maxL: 0.90, minS: 0.28 },
              { minL: 0.12, maxL: 0.93, minS: 0.16 },
              { minL: 0.08, maxL: 0.96, minS: 0.06 },
            ];

            var hex = null;

            for (var t = 0; t < tiers.length && !hex; t++) {
              var tier = tiers[t];
              var buckets = {};
              for (var p = 0; p < pixels.length; p++) {
                var px = pixels[p];
                if (px.l < tier.minL || px.l > tier.maxL || px.s < tier.minS) continue;
                var key = Math.round(px.r / BUCKET) + ',' + Math.round(px.g / BUCKET) + ',' + Math.round(px.b / BUCKET);
                if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, n: 0, weight: 0 };
                var bkt = buckets[key];
                bkt.r += px.r; bkt.g += px.g; bkt.b += px.b; bkt.n += 1;
                bkt.weight += 0.4 + px.s;
              }

              var best = null;
              Object.keys(buckets).forEach(function (k) {
                var bkt = buckets[k];
                if (!best || bkt.weight > best.weight) best = bkt;
              });

              if (best && best.n > 0) {
                hex = '#' + toHex(best.r / best.n) + toHex(best.g / best.n) + toHex(best.b / best.n);
              }
            }

            if (!hex) {
              hex = countAll > 0
                ? '#' + toHex(rSumAll / countAll) + toHex(gSumAll / countAll) + toHex(bSumAll / countAll)
                : '${DEFAULT_ACCENT}';
            }
            send({ ok: true, color: hex });
          } catch (e) {
            send({ ok: false, error: String(e && e.message ? e.message : e) });
          }
        };
        img.onerror = function () {
          send({ ok: false, error: 'image failed to load' });
        };
        img.src = uri;
      }
      run(${safeDataUri});
    </script>
  </body>
</html>`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  hiddenColorProbe: {
    position: 'absolute',
    width: 2,
    height: 2,
    top: -1000,
    left: -1000,
    opacity: 0,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: COLORS.gray, marginTop: 12, fontFamily: 'Poppins_500Medium', fontSize: 13, letterSpacing: 0.2 },

  headerRow: { paddingHorizontal: PADDING_H, paddingTop: 16, paddingBottom: 12 },
  headerTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 24, letterSpacing: -0.4 },

  speedDialContainer: { marginBottom: 14 },
  speedDialScroll: { marginBottom: 4 },
  speedDialPage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: PADDING_H,
    justifyContent: 'space-between',
  },
  speedDialTile: {
    width: TILE_WIDTH,
    marginBottom: 16,
  },
  speedDialCoverWrapper: {
    width: TILE_WIDTH,
    height: TILE_WIDTH,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: COLORS.card,
    marginBottom: 7,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  speedDialCoverActive: {
    borderWidth: 2,
    borderColor: COLORS.green,
  },
  speedDialCover: {
    width: '100%',
    height: '100%',
  },
  speedDialCoverFallback: {
    width: '100%',
    height: '100%',
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedDialTitle: {
    color: COLORS.white,
    fontFamily: 'Poppins_500Medium',
    fontSize: 12,
    lineHeight: 16,
  },
  speedDialSubtitle: {
    color: COLORS.grayDim,
    fontFamily: 'Poppins_400Regular',
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
  },

  filterBar: { paddingHorizontal: PADDING_H, paddingVertical: 8, gap: 10 },
  filterPill: {
    backgroundColor: COLORS.surface,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  filterPillActive: {
    backgroundColor: COLORS.green,
    borderColor: COLORS.green,
  },
  filterPillText: {
    color: COLORS.gray,
    fontFamily: 'Poppins_500Medium',
    fontSize: 12,
  },
  filterPillTextActive: {
    color: COLORS.bg,
    fontFamily: 'Poppins_700Bold',
  },

  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    marginHorizontal: PADDING_H,
    marginTop: 8,
    marginBottom: 10,
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 44,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchIcon: {
    marginRight: 9,
  },
  searchInput: {
    flex: 1,
    color: COLORS.white,
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    paddingVertical: 0,
  },

  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: PADDING_H,
    paddingTop: 10,
    paddingBottom: 8,
  },
  sectionTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 19, letterSpacing: -0.3 },
  songCountText: { color: COLORS.grayDim, fontFamily: 'Poppins_500Medium', fontSize: 12 },

  trackRow: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: PADDING_H,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.02)',
  },
  trackRowSelected: {
    backgroundColor: 'rgba(29, 185, 84, 0.04)',
  },
  trackCoverContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  trackCoverImage: {
    width: 50,
    height: 50,
    borderRadius: 8,
  },
  trackArt: {
    width: 50,
    height: 50,
    borderRadius: 8,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  trackArtGlyph: { color: COLORS.grayDim, fontSize: 18 },
  trackDetails: { flex: 1, marginLeft: 14 },
  trackTitle: { color: COLORS.white, fontFamily: 'Poppins_500Medium', fontSize: 14.5 },
  trackTitleActive: { color: COLORS.green },
  trackSubtitle: { color: COLORS.grayDim, fontFamily: 'Poppins_400Regular', fontSize: 11.5, marginTop: 2 },
  indicatorWrap: { marginLeft: 10 },
  nowPlayingDotPulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.green },

  seeMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    marginHorizontal: PADDING_H,
    marginTop: 12,
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  seeMoreText: {
    color: COLORS.white,
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
  },

  miniPlayer: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#1E1E24',
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  miniProgressTrack: { height: 2, backgroundColor: 'rgba(255, 255, 255, 0.1)', width: '100%' },
  miniProgressFill: { height: 2, backgroundColor: COLORS.green },
  miniPlayerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  miniCoverImage: {
    width: 42,
    height: 42,
    borderRadius: 7,
  },
  trackArtSmall: {
    width: 42,
    height: 42,
    borderRadius: 7,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniTitle: { color: COLORS.white, fontFamily: 'Poppins_500Medium', fontSize: 13.5 },
  miniSubtitle: { color: COLORS.gray, fontFamily: 'Poppins_400Regular', fontSize: 11, marginTop: 1 },
  miniPlayBtn: {
    padding: 6,
    borderRadius: 20,
  },

  fullPlayer: { flex: 1, backgroundColor: COLORS.bg, paddingHorizontal: 24 },
  fullPlayerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  chevronButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullPlayerHeaderLabel: { 
    color: COLORS.gray, 
    fontFamily: 'Poppins_600SemiBold', 
    fontSize: 11, 
    letterSpacing: 1.2 
  },

  albumArtWrap: { 
    alignItems: 'center', 
    marginTop: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 12,
  },
  albumArtImage: {
    borderRadius: 16,
  },
  albumArt: {
    borderRadius: 16,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  albumArtGlyph: { color: COLORS.grayDim, fontSize: 68 },

  fullTrackInfo: { marginTop: 28 },
  titleGenreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fullTrackTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 23, flex: 1, letterSpacing: -0.3 },
  genreBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    marginLeft: 10,
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  genreBadgeText: {
    color: COLORS.white,
    fontFamily: 'Poppins_500Medium',
    fontSize: 11,
    textTransform: 'capitalize',
  },
  fullTrackArtist: { color: COLORS.gray, fontFamily: 'Poppins_400Regular', fontSize: 14.5, marginTop: 4 },

  seekBarTouchable: { marginTop: 22, paddingVertical: 8 },
  seekTrack: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    borderRadius: 2,
    width: '100%',
    position: 'relative',
  },
  seekFill: { height: 4, backgroundColor: COLORS.white, borderRadius: 2 },
  seekThumb: {
    position: 'absolute',
    top: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: COLORS.white,
    marginLeft: -7,
  },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  timeText: { color: COLORS.grayDim, fontFamily: 'Poppins_400Regular', fontSize: 11.5 },

  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
    gap: 40,
  },
  playPauseCircle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 6,
  },

  lyricsBoxCard: {
    marginTop: 30,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  lyricsBoxHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lyricsBoxTitle: {
    color: COLORS.white,
    fontFamily: 'Poppins_700Bold',
    fontSize: 14,
  },
  lyricsViewport: {
    height: LYRIC_BOX_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
  },
  lyricLineSlot: {
    height: LINE_HEIGHT_SLOT,
    justifyContent: 'center',
  },
  lyricLineText: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 24,
    lineHeight: 32,
  },
  lyricLineActive: {
    color: COLORS.white,
  },
  lyricLineInactive: {
    color: COLORS.grayDim,
    opacity: 0.35,
  },
  noLyricsContainer: {
    height: LYRIC_BOX_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  noLyricsText: {
    color: COLORS.grayDim,
    fontFamily: 'Poppins_400Regular',
    fontStyle: 'italic',
    fontSize: 13,
  },

  expandedLyricsContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  expandedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  expandedTitle: {
    color: COLORS.white,
    fontFamily: 'Poppins_700Bold',
    fontSize: 18,
    flex: 1,
    marginRight: 16,
  },
  expandedLyricLine: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 26,
    lineHeight: 38,
    marginVertical: 10,
  },
  expandedLyricActive: {
    color: COLORS.white,
  },
  expandedLyricInactive: {
    color: COLORS.grayDim,
  },
});