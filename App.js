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
  bg: '#000000',
  surface: '#121212',
  card: '#181818',
  cardActive: '#282828',
  green: '#1DB954',
  greenPress: '#1ED760',
  white: '#FFFFFF',
  gray: '#B3B3B3',
  grayDim: '#727272',
  border: '#2A2A2A',
};

const { width: SCREEN_W } = Dimensions.get('window');
const ITEM_HEIGHT = 68;
const LYRIC_BOX_HEIGHT = 220;
const LINE_HEIGHT_SLOT = 70;
const NO_REPEAT_WINDOW = 5;
const RECENT_HISTORY_LIMIT = 12;
const INITIAL_VISIBLE_COUNT = 10;
const FILTER_GENRES = ['all', 'aura', 'love', 'sad', 'happy'];
const DEFAULT_ACCENT = '#535353';

// Polished spacing for 3x3 Speed Dial layout
const TILE_GAP = 14;
const PADDING_H = 18;
const TILE_WIDTH = (SCREEN_W - PADDING_H * 2 - TILE_GAP * 2) / 3;

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const TrackRowItem = memo(({ item, isSelected, isPlaying, onSelect }) => {
  return (
    <TouchableOpacity
      activeOpacity={0.6}
      style={styles.trackRow}
      onPress={() => onSelect(item.id)}
    >
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
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text numberOfLines={1} style={[styles.trackTitle, isSelected && styles.trackTitleActive]}>
          {item.title}
        </Text>
        <Text numberOfLines={1} style={styles.trackSubtitle}>
          {(item.artist || 'Unknown artist') + (item.genre ? ` • ${item.genre}` : '')}
        </Text>
      </View>
      {isSelected && isPlaying && <View style={styles.nowPlayingDot} />}
    </TouchableOpacity>
  );
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
  const [currentIndex, setCurrentIndex] = useState(0);
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

  const currentTrack = rawTracks[currentIndex] || null;
  const audioSource = useMemo(() => {
    if (!currentTrack?.file) return '';
    return `${HF_BASE_URL}/${currentTrack.file}`;
  }, [currentTrack?.file]);

  const player = useAudioPlayer(audioSource);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      staysActiveInBackground: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch((err) => console.warn('Audio mode config failed:', err));
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

  useEffect(() => {
    if (!rawTracks.length) return;
    const nextIdx = (currentIndex + 1) % rawTracks.length;
    const nextTrack = rawTracks[nextIdx];
    if (nextTrack?.cover) {
      Image.prefetch(`${HF_BASE_URL}/${nextTrack.cover}`).catch(() => {});
    }
  }, [currentIndex, rawTracks]);

  useEffect(() => {
    setCurrentLineIndex(-1);
    setSmoothTime(0);
    scrollY.setValue(0);

    if (!currentTrack || !currentTrack.lrc) {
      setLyrics([]);
      return;
    }

    fetch(`${HF_BASE_URL}/${currentTrack.lrc}`)
      .then((res) => res.text())
      .then((lrcText) => setLyrics(parseLRC(lrcText)))
      .catch((err) => {
        console.error('Failed to load LRC lyrics:', err);
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
      .catch((err) => {
        console.warn('Cover download/resize failed, using fallback theme:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.cover]);

  const handleColorProbeMessage = useCallback((event) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (payload.ok && payload.color) {
        setDominantColor(payload.color);
      } else if (payload.error) {
        console.warn('Cover color probe failed, using fallback theme:', payload.error);
      }
    } catch (err) {
      console.warn('Cover color probe message parse failed:', err);
    }
  }, []);

  const colorProbeHtml = colorProbeDataUri ? buildColorProbeHtml(colorProbeDataUri) : null;

  useEffect(() => {
    if (fastTimer.current) clearInterval(fastTimer.current);

    fastTimer.current = setInterval(() => {
      if (!player || seeking) return;
      try {
        const t = player.currentTime ?? status?.currentTime ?? 0;
        setSmoothTime(t);
      } catch (err) {}
    }, 100);

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
          duration: 300,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      }
    }
  }, [smoothTime, lyrics]);

  const advancedRef = useRef(false);
  const shouldAutoplayRef = useRef(false);

  useEffect(() => {
    advancedRef.current = false;
    shouldAutoplayRef.current = true;
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!player || !status || !shouldAutoplayRef.current) return;
    if (status.isLoaded && !status.isPlaying) {
      try {
        player.play();
        shouldAutoplayRef.current = false;
      } catch (err) {}
    }
  }, [player, status?.isLoaded, status?.isPlaying]);

  useEffect(() => {
    if (!status || advancedRef.current || !duration) return;
    const finished =
      status.didJustFinish === true ||
      (smoothTime >= duration - 0.3 && status.isPlaying === false && smoothTime > 1);
    if (finished) {
      advancedRef.current = true;
      playNext();
    }
  }, [status?.didJustFinish, status?.isPlaying, smoothTime, duration]);

  const togglePlayPause = useCallback(() => {
    if (!player) return;
    try {
      if (player.playing || status?.isPlaying) {
        player.pause();
      } else {
        player.play();
      }
    } catch (err) {
      console.warn('Play/pause action failed:', err);
    }
  }, [player, status?.isPlaying]);

  const playNext = useCallback(() => {
    if (!rawTracks.length) return;
    const current = rawTracks[currentIndex];
    if (current) {
      recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
      backStackRef.current = [...backStackRef.current, currentIndex].slice(-50);
    }
    const nextIdx = pickSmartNextIndex(rawTracks, current, recentIdsRef.current);
    setCurrentIndex(nextIdx >= 0 ? nextIdx : (currentIndex + 1) % rawTracks.length);
  }, [rawTracks, currentIndex]);

  const playPrev = useCallback(() => {
    if (!rawTracks.length) return;
    const prevIdx = backStackRef.current.length ? backStackRef.current.pop() : undefined;
    if (prevIdx !== undefined && prevIdx !== currentIndex) {
      setCurrentIndex(prevIdx);
    } else {
      setCurrentIndex((currentIndex - 1 + rawTracks.length) % rawTracks.length);
    }
  }, [rawTracks, currentIndex]);

  const selectTrackById = useCallback((trackId) => {
    setRawTracks((currentRaw) => {
      const targetIdx = currentRaw.findIndex((t) => t.id === trackId);
      if (targetIdx !== -1) {
        const current = currentRaw[currentIndex];
        if (current) {
          recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
          backStackRef.current = [...backStackRef.current, currentIndex].slice(-50);
        }
        setCurrentIndex(targetIdx);
        setPlayerOpen(true);
      }
      return currentRaw;
    });
  }, [currentIndex]);

  const duration = status?.duration || 0;
  const displayTime = seeking ? seekValue : smoothTime;
  const progressPct = duration > 0 ? Math.min(displayTime / duration, 1) : 0;
  const isPlaying = status?.isPlaying ?? player?.playing ?? false;

  const nowPlayingTheme = useMemo(() => {
    const top = darkenColor(dominantColor, 0.45);
    const bottom = darkenColor(dominantColor, 0.88);
    const cardBg = darkenColor(dominantColor, 0.72);
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
    if (selectedGenre === 'all') return randomizedTracks;
    return randomizedTracks.filter(
      (t) => (t.genre || '').toLowerCase().trim() === selectedGenre.toLowerCase().trim()
    );
  }, [randomizedTracks, selectedGenre]);

  const displayedTracks = useMemo(() => {
    if (isExpanded) return filteredTracks;
    return filteredTracks.slice(0, INITIAL_VISIBLE_COUNT);
  }, [filteredTracks, isExpanded]);

  const handleFilterPress = useCallback((genre) => {
    if (genre === 'all') {
      setRandomizedTracks(shuffleArray(rawTracks));
      setSelectedGenre('all');
    } else {
      setSelectedGenre(genre);
    }
  }, [rawTracks]);

  useEffect(() => {
    if (!player || !status?.isLoaded || !currentTrack) return;
    try {
      player.setActiveForLockScreen(
        true,
        {
          title: currentTrack.title,
          artist: currentTrack.artist || 'Unknown artist',
          artworkUrl: currentTrack.cover ? `${HF_BASE_URL}/${currentTrack.cover}` : undefined,
        },
        {
          showNextTrack: true,
          showPreviousTrack: true,
        }
      );
    } catch (err) {
      console.warn('setActiveForLockScreen failed:', err);
    }
  }, [player, status?.isLoaded, currentTrack?.id]);

  useEffect(() => {
    if (!player || typeof player.addListener !== 'function') return;
    const nextSub = player.addListener('onRemoteNextTrack', () => playNext());
    const prevSub = player.addListener('onRemotePreviousTrack', () => playPrev());
    return () => {
      nextSub?.remove?.();
      prevSub?.remove?.();
    };
  }, [player, playNext, playPrev]);

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
    setTimeout(() => setSeeking(false), 150);
  };

  const getItemLayout = useCallback((_, index) => ({
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  }), []);

  const renderItem = useCallback(({ item }) => (
    <TrackRowItem
      item={item}
      isSelected={currentTrack?.id === item.id}
      isPlaying={isPlaying}
      onSelect={selectTrackById}
    />
  ), [currentTrack?.id, isPlaying, selectTrackById]);

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
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Songs</Text>
        <Text style={styles.songCountText}>{filteredTracks.length} Total</Text>
      </View>
    </View>
  ), [speedDialPages, currentTrack?.id, selectTrackById, selectedGenre, handleFilterPress, filteredTracks.length]);

  const listFooter = useMemo(() => {
    if (filteredTracks.length <= INITIAL_VISIBLE_COUNT) return null;
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
  }, [filteredTracks.length, isExpanded]);

  if (!fontsLoaded || loading) {
    return (
      <View style={[styles.center, { backgroundColor: COLORS.bg }]}>
        <ActivityIndicator size="large" color={COLORS.green} />
        <Text style={styles.loadingText}>Loading your music…</Text>
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
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        contentContainerStyle={{ paddingBottom: (currentTrack ? 96 : 20) + insets.bottom }}
      />

      {/* Mini Player */}
      {currentTrack && (
        <TouchableOpacity
          activeOpacity={0.9}
          style={[styles.miniPlayer, { bottom: 8 + insets.bottom }]}
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
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text numberOfLines={1} style={styles.miniTitle}>{currentTrack.title}</Text>
              <Text numberOfLines={1} style={styles.miniSubtitle}>
                {(currentTrack.artist || 'Unknown artist') + (currentTrack.genre ? ` • ${currentTrack.genre}` : '')}
              </Text>
            </View>
            <TouchableOpacity onPress={togglePlayPause} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name={isPlaying ? 'pause' : 'play'} size={24} color={COLORS.white} />
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
                <Ionicons name="chevron-down" size={26} color={COLORS.white} />
              </TouchableOpacity>
              <Text style={styles.fullPlayerHeaderLabel} numberOfLines={1}>NOW PLAYING</Text>
              <View style={{ width: 24 }} />
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 + insets.bottom }} showsVerticalScrollIndicator={false}>
              <View style={styles.albumArtWrap}>
                {currentTrack?.cover ? (
                  <Image
                    source={{ uri: `${HF_BASE_URL}/${currentTrack.cover}` }}
                    style={[
                      styles.albumArtImage,
                      { width: windowWidth - 96, height: windowWidth - 96 },
                    ]}
                  />
                ) : (
                  <View
                    style={[
                      styles.albumArt,
                      { width: windowWidth - 96, height: windowWidth - 96 },
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
                  <Ionicons name="play-skip-back" size={32} color={COLORS.white} />
                </TouchableOpacity>
                <TouchableOpacity onPress={togglePlayPause} style={styles.playPauseCircle}>
                  <Ionicons
                    name={isPlaying ? 'pause' : 'play'}
                    size={32}
                    color={COLORS.bg}
                    style={{ marginLeft: isPlaying ? 0 : 3 }}
                  />
                </TouchableOpacity>
                <TouchableOpacity onPress={playNext} hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}>
                  <Ionicons name="play-skip-forward" size={32} color={COLORS.white} />
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
                      {currentTrack?.lrc ? 'Loading lyrics…' : 'No lyrics available'}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </LinearGradient>

        {/* Expanded Lyrics Modal */}
        <Modal
          visible={lyricsModalOpen}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setLyricsModalOpen(false)}
        >
          <LinearGradient colors={[nowPlayingTheme.top, nowPlayingTheme.bottom]} style={{ flex: 1 }}>
            <SafeAreaView style={[styles.expandedLyricsContainer, { backgroundColor: 'transparent' }]}>
              <View style={styles.expandedHeader}>
                <Text style={styles.expandedTitle}>{currentTrack?.title}</Text>
                <TouchableOpacity onPress={() => setLyricsModalOpen(false)}>
                  <Ionicons name="close-circle" size={28} color={COLORS.white} />
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

// Helper: Euclidean distance between two 4D feature vectors [bpm, rms, centroid, pulse]
function getVectorDistance(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0.5; // neutral fallback distance if one track lacks vectors
  }
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += Math.pow(vecA[i] - vecB[i], 2);
  }
  return Math.sqrt(sum);
}

function pickSmartNextIndex(tracks, currentTrack, recentIds = []) {
  if (!tracks || !tracks.length) return -1;
  if (tracks.length === 1) return 0;

  const windowSize = typeof NO_REPEAT_WINDOW !== 'undefined' ? NO_REPEAT_WINDOW : 10;
  const blocked = new Set(recentIds.slice(-windowSize));
  if (currentTrack?.id) blocked.add(currentTrack.id);

  let pool = tracks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !blocked.has(t.id));

  // If repeat window blocked everything, just exclude the current song
  if (pool.length === 0) {
    pool = tracks
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.id !== currentTrack?.id);
  }
  if (pool.length === 0) return 0;

  const curGenre = (currentTrack?.genre || '').toLowerCase().trim();
  const curArtist = (currentTrack?.artist || '').toLowerCase().trim();
  const curVector = currentTrack?.audio_vector;

  // 10% chance to venture into a fresh genre while keeping similar acoustic energy
  const jumpGenre = Math.random() < 0.10;

  const scored = pool.map(({ t, idx }) => {
    const tGenre = (t.genre || '').toLowerCase().trim();
    const tArtist = (t.artist || '').toLowerCase().trim();
    const isSameGenre = curGenre && tGenre && curGenre === tGenre;
    const isSameArtist = curArtist && tArtist && curArtist === tArtist;

    let score = 0;

    // 1. Acoustic similarity score (0.0 - 10.0 pts)
    // Distance ranges roughly ~0.0 (identical) to ~1.4 (opposite).
    // Closer tracks get higher affinity points.
    if (curVector && t.audio_vector) {
      const dist = getVectorDistance(curVector, t.audio_vector);
      score += Math.max(0, (1.2 - dist) * 8.0);
    } else {
      score += 4.0; // neutral baseline if audio vector is missing
    }

    // 2. Genre coherence
    if (!jumpGenre && isSameGenre) {
      score += 8.0;
    } else if (jumpGenre && !isSameGenre) {
      score += 6.0;
    }

    // 3. Artist familiarity bonus
    if (isSameArtist) {
      score += 3.5;
    }

    // 4. Subtle jitter (0.0 - 1.5) to avoid robotic loops
    score += Math.random() * 1.5;

    return { idx, score };
  });

  // Sort descending by highest score
  scored.sort((a, b) => b.score - a.score);

  // Pick randomly among top cluster within 1.8 points of best match
  const bestScore = scored[0].score;
  const topCluster = scored.filter((s) => bestScore - s.score < 1.8);
  const chosen = topCluster[Math.floor(Math.random() * topCluster.length)];

  return chosen.idx;
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

            var w = canvas.width, h = canvas.height;
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
  loadingText: { color: COLORS.gray, marginTop: 12, fontFamily: 'Poppins_500Medium', fontSize: 13 },

  headerRow: { paddingHorizontal: PADDING_H, paddingTop: 14, paddingBottom: 10 },
  headerTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 24, letterSpacing: -0.3 },

  // YT Music 3x3 Speed Dial
  speedDialContainer: { marginBottom: 12 },
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
    marginBottom: 8,
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

  // Genre Filters Bar
  filterBar: { paddingHorizontal: PADDING_H, paddingVertical: 8, gap: 10 },
  filterPill: {
    backgroundColor: COLORS.card,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterPillActive: {
    backgroundColor: COLORS.green,
  },
  filterPillText: {
    color: COLORS.white,
    fontFamily: 'Poppins_500Medium',
    fontSize: 12,
  },
  filterPillTextActive: {
    color: COLORS.bg,
    fontFamily: 'Poppins_700Bold',
  },

  // Section Header
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: PADDING_H,
    paddingTop: 12,
    paddingBottom: 8,
  },
  sectionTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 18 },
  songCountText: { color: COLORS.grayDim, fontFamily: 'Poppins_500Medium', fontSize: 12 },

  // Track List
  trackRow: {
    height: ITEM_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: PADDING_H,
  },
  trackCoverImage: {
    width: 50,
    height: 50,
    borderRadius: 6,
  },
  trackArt: {
    width: 50,
    height: 50,
    borderRadius: 6,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trackArtGlyph: { color: COLORS.grayDim, fontSize: 18 },
  trackTitle: { color: COLORS.white, fontFamily: 'Poppins_500Medium', fontSize: 14 },
  trackTitleActive: { color: COLORS.green },
  trackSubtitle: { color: COLORS.grayDim, fontFamily: 'Poppins_400Regular', fontSize: 11, marginTop: 2 },
  nowPlayingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.green },

  // See More Button
  seeMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    marginHorizontal: PADDING_H,
    marginTop: 8,
    backgroundColor: COLORS.card,
    borderRadius: 24,
  },
  seeMoreText: {
    color: COLORS.white,
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
  },

  // Mini Player
  miniPlayer: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    backgroundColor: COLORS.cardActive,
    borderRadius: 8,
    overflow: 'hidden',
  },
  miniProgressTrack: { height: 2, backgroundColor: '#3E3E3E', width: '100%' },
  miniProgressFill: { height: 2, backgroundColor: COLORS.green },
  miniPlayerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  miniCoverImage: {
    width: 40,
    height: 40,
    borderRadius: 4,
  },
  trackArtSmall: {
    width: 40,
    height: 40,
    borderRadius: 4,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniTitle: { color: COLORS.white, fontFamily: 'Poppins_500Medium', fontSize: 14 },
  miniSubtitle: { color: COLORS.gray, fontFamily: 'Poppins_400Regular', fontSize: 11, marginTop: 1 },

  // Full Player
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
  fullPlayerHeaderLabel: { color: COLORS.gray, fontFamily: 'Poppins_600SemiBold', fontSize: 12, letterSpacing: 1 },

  albumArtWrap: { alignItems: 'center', marginTop: 16 },
  albumArtImage: {
    width: SCREEN_W - 96,
    height: SCREEN_W - 96,
    borderRadius: 12,
  },
  albumArt: {
    width: SCREEN_W - 96,
    height: SCREEN_W - 96,
    borderRadius: 12,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  albumArtGlyph: { color: COLORS.grayDim, fontSize: 64 },

  fullTrackInfo: { marginTop: 24 },
  titleGenreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fullTrackTitle: { color: COLORS.white, fontFamily: 'Poppins_700Bold', fontSize: 22, flex: 1 },
  genreBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    marginLeft: 10,
    alignSelf: 'center',
  },
  genreBadgeText: {
    color: COLORS.white,
    fontFamily: 'Poppins_500Medium',
    fontSize: 11,
    textTransform: 'capitalize',
  },
  fullTrackArtist: { color: COLORS.gray, fontFamily: 'Poppins_400Regular', fontSize: 14, marginTop: 4 },

  seekBarTouchable: { marginTop: 20, paddingVertical: 8 },
  seekTrack: {
    height: 4,
    backgroundColor: '#3E3E3E',
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
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  timeText: { color: COLORS.grayDim, fontFamily: 'Poppins_400Regular', fontSize: 11 },

  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    gap: 40,
  },
  playPauseCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Compact Lyrics Box
  lyricsBoxCard: {
    marginTop: 28,
    backgroundColor: COLORS.card,
    borderRadius: 12,
    padding: 16,
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

  // Expanded Full Lyrics View
  expandedLyricsContainer: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  expandedHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  expandedTitle: {
    color: COLORS.white,
    fontFamily: 'Poppins_700Bold',
    fontSize: 18,
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