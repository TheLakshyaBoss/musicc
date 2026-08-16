import React, { useState, useEffect, useRef, useCallback } from 'react';
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

// NOTE: this file depends on three extra Expo packages that aren't in the
// original project. Install them before running:
//   npx expo install expo-linear-gradient
//   npx expo install react-native-webview
//   npx expo install expo-image-manipulator
// Color extraction has two steps, both deliberately avoiding anything that
// depends on the cover's server sending CORS headers (Hugging Face's CDN
// doesn't reliably do this, which is what silently broke it before):
//   1. expo-image-manipulator does a *native* download + resize of the
//      cover (not a browser fetch, so CORS is irrelevant) and hands back a
//      small base64 image.
//   2. That base64 is embedded directly as a `data:` URI inside a tiny
//      invisible WebView running an HTML5 canvas. Canvases can always read
//      pixels from a `data:` URI regardless of origin, so there's nothing
//      left to taint.

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
const SEEK_BAR_WIDTH = SCREEN_W - 48;
const LYRIC_BOX_HEIGHT = 220;
const LINE_HEIGHT_SLOT = 70;

// A track can't be replayed until at least this many other songs have
// played since it was last heard ("too rare to repeat within 5 songs").
const NO_REPEAT_WINDOW = 5;
// How many recently-heard ids we actually remember (a little more than the
// no-repeat window so the pool stays healthy even with small libraries).
const RECENT_HISTORY_LIMIT = 12;

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  const [tracks, setTracks] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
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

  // Ids of recently-played tracks, most-recent last — used to keep smart
  // "next" picks from repeating a song heard within the last few tracks.
  const recentIdsRef = useRef([]);
  // Actual navigation history (track indices) so the "previous" button
  // goes back to what really played, not just index-1.
  const backStackRef = useRef([]);

  const currentTrack = tracks[currentIndex] || null;
  const audioSource = currentTrack ? `${HF_BASE_URL}/${currentTrack.file}` : '';
  const player = useAudioPlayer(audioSource);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    // interruptionMode must be 'doNotMix' for lock screen / earphone
    // remote controls to correctly attach to this player (per expo-audio docs).
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
        setTracks(shuffleArray(data));
        setLoading(false);
      })
      .catch((err) => {
        console.error('Error fetching playlist:', err);
        setLoading(false);
      });
  }, []);

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

  // Spotify-style theming, in two steps:
  // 1. Natively download + shrink the cover to a small base64 image (no
  //    browser fetch involved, so CORS can't break it).
  // 2. Hand that base64 to a hidden WebView canvas (below) to read out a
  //    dominant color, via handleColorProbeMessage.
  const [colorProbeDataUri, setColorProbeDataUri] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setDominantColor(DEFAULT_ACCENT);
    setColorProbeDataUri(null);

    if (!currentTrack?.cover) return;
    const coverUrl = `${HF_BASE_URL}/${currentTrack.cover}`;

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

  // Smooth, jitter-free centering strictly for the preview box
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

  // Smart "next": picks the closest-genre track that hasn't played within
  // the last NO_REPEAT_WINDOW songs, instead of just walking the list order.
  const playNext = useCallback(() => {
    if (!tracks.length) return;
    const current = tracks[currentIndex];
    if (current) {
      recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
      backStackRef.current = [...backStackRef.current, currentIndex].slice(-50);
    }
    const nextIdx = pickSmartNextIndex(tracks, current, recentIdsRef.current);
    setCurrentIndex(nextIdx >= 0 ? nextIdx : (currentIndex + 1) % tracks.length);
  }, [tracks, currentIndex]);

  // Real "previous": rewinds to whatever actually played before this,
  // rather than just index-1 in the list.
  const playPrev = useCallback(() => {
    if (!tracks.length) return;
    const prevIdx = backStackRef.current.length ? backStackRef.current.pop() : undefined;
    if (prevIdx !== undefined && prevIdx !== currentIndex) {
      setCurrentIndex(prevIdx);
    } else {
      setCurrentIndex((currentIndex - 1 + tracks.length) % tracks.length);
    }
  }, [tracks, currentIndex]);

  const selectTrack = (index) => {
    if (tracks.length && index !== currentIndex) {
      const current = tracks[currentIndex];
      if (current) {
        recentIdsRef.current = [...recentIdsRef.current, current.id].slice(-RECENT_HISTORY_LIMIT);
        backStackRef.current = [...backStackRef.current, currentIndex].slice(-50);
      }
    }
    setCurrentIndex(index);
    setPlayerOpen(true);
  };

  const duration = status?.duration || 0;
  const displayTime = seeking ? seekValue : smoothTime;
  const progressPct = duration > 0 ? Math.min(displayTime / duration, 1) : 0;
  const isPlaying = status?.isPlaying ?? player?.playing ?? false;

  // Derived Now Playing theme from the cover's dominant color: a darker
  // shade for the background wash, and a lighter shade so the active
  // lyric line still pops against it.
  const nowPlayingTheme = React.useMemo(() => {
    const top = darkenColor(dominantColor, 0.45);
    const bottom = darkenColor(dominantColor, 0.88);
    const cardBg = darkenColor(dominantColor, 0.72);
    const highlight = lightenColor(dominantColor, 0.55);
    return { top, bottom, cardBg, highlight };
  }, [dominantColor]);

  // Register this player as the active lock screen / earphone remote
  // control session, and push metadata for the current track. This is
  // what makes a single earphone click play/pause, and (where the
  // installed expo-audio version supports it) a double/triple click
  // skip forward/back.
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

  // Wire up remote next/previous events (earphone double/triple click,
  // lock screen, notification, Control Center) to the same handlers as
  // the in-app buttons. Play/pause is handled by expo-audio itself once
  // this player is set active, so no listener is needed for that.
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

      {/* Hidden color-probe WebView: reads the resized cover (already
          embedded as a data: URI, so there's no network fetch and no CORS
          to worry about) and reports its dominant color via onMessage.
          Remounted (via `key`) whenever the image changes for a fresh read. */}
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

      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Your Library</Text>
      </View>

      <FlatList
        data={tracks}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: (currentTrack ? 96 : 20) + insets.bottom }}
        renderItem={({ item, index }) => {
          const isSelected = currentTrack?.id === item.id;
          return (
            <TouchableOpacity
              activeOpacity={0.6}
              style={styles.trackRow}
              onPress={() => selectTrack(index)}
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
                  {item.artist || 'Unknown artist'}
                </Text>
              </View>
              {isSelected && isPlaying && <View style={styles.nowPlayingDot} />}
            </TouchableOpacity>
          );
        }}
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
              <Text numberOfLines={1} style={styles.miniSubtitle}>{currentTrack.artist || 'Unknown artist'}</Text>
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
              <Text style={styles.fullTrackTitle} numberOfLines={1}>{currentTrack?.title}</Text>
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

            {/* Spotify-style Lyrics Box */}
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

        {/* Expanded Lyrics Modal (Free Manual Scrolling) */}
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

// ---------------------------------------------------------------------
// Smart "up next" matching
// ---------------------------------------------------------------------

// Cheap Levenshtein distance, used as a fuzzy fallback when two genre
// strings share no whole words (e.g. "Synthwave" vs "Synth Pop").
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Scores how close two genre labels are, from 0 (unrelated) to 1 (identical).
// Works generically off whatever genre strings happen to be in playlist.json
// — exact match scores highest, shared words ("Dream Pop" vs "Synth Pop")
// score well, and otherwise it falls back to string-similarity so things
// like "Alternative" and "Alt Rock" still land closer than total strangers.
function genreSimilarity(genreA, genreB) {
  if (!genreA || !genreB) return 0;
  const a = genreA.toLowerCase().trim();
  const b = genreB.toLowerCase().trim();
  if (a === b) return 1;

  const wordsA = new Set(a.split(/[\s/,&-]+/).filter(Boolean));
  const wordsB = new Set(b.split(/[\s/,&-]+/).filter(Boolean));
  const shared = [...wordsA].filter((w) => wordsB.has(w)).length;
  const unionSize = new Set([...wordsA, ...wordsB]).size || 1;
  const wordScore = shared / unionSize;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  const stringScore = 1 - dist / maxLen;

  return wordScore * 0.7 + stringScore * 0.3;
}

// Picks the index of the best "up next" track: closest genre match to the
// currently playing track, while excluding anything heard within the last
// NO_REPEAT_WINDOW songs (recentIds, most-recently-played last).
function pickSmartNextIndex(tracks, currentTrack, recentIds) {
  if (!tracks.length) return -1;
  if (tracks.length === 1) return 0;

  const blocked = new Set(recentIds.slice(-NO_REPEAT_WINDOW));
  if (currentTrack) blocked.add(currentTrack.id);

  let pool = tracks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !blocked.has(t.id));

  // Small library / lots of recent plays: relax the no-repeat rule rather
  // than getting stuck, but still never allow an immediate back-to-back
  // repeat of the current song.
  if (pool.length === 0) {
    pool = tracks
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => t.id !== currentTrack?.id);
  }
  if (pool.length === 0) return 0;

  const scored = pool.map(({ t, idx }) => ({
    idx,
    // tiny jitter so ties (or a totally genre-less library) don't always
    // resolve to the same track/order
    score: genreSimilarity(currentTrack?.genre, t.genre) + Math.random() * 0.05,
  }));
  scored.sort((a, b) => b.score - a.score);

  // Pick randomly among the closest-matching cluster so it doesn't feel
  // robotic while still strongly favoring genre closeness.
  const best = scored[0].score;
  const topCluster = scored.filter((s) => best - s.score < 0.08);
  const chosen = topCluster[Math.floor(Math.random() * topCluster.length)];
  return chosen.idx;
}

// ---------------------------------------------------------------------
// Cover-art color theming (Spotify-style "now playing" background)
// ---------------------------------------------------------------------

const DEFAULT_ACCENT = '#535353';

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

// Mixes a color toward black. factor: 0 = unchanged, 1 = pure black.
function darkenColor(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
}

// Mixes a color toward white. factor: 0 = unchanged, 1 = pure white.
function lightenColor(hex, factor) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor);
}

// Pulls a representative color out of a cover image using a hidden WebView
// running an HTML5 <canvas>. Takes a `data:` URI (already downloaded and
// resized natively by expo-image-manipulator) rather than a remote URL —
// canvases can always read pixels from a data URI with no CORS concerns,
// which is what made the earlier remote-URL version unreliable.
//
// How it works: loads the image into an <img>, draws it onto a small
// canvas, computes lightness/saturation per pixel, and buckets colors
// together by proximity. It tries progressively looser "tiers" — vibrant
// colors first, then moderately saturated, then anything not pure
// black/white — stopping at the first tier that finds a match, so black,
// near-black, and gray/muddy tones only get used if the cover genuinely
// has no color in it at all. Within a tier, buckets are ranked by total
// saturation (not just pixel count), so a smaller but more colorful
// cluster beats a larger but duller one.
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

            // Tiers run from "strict, colorful only" to "lenient" — the
            // first tier that finds ANY qualifying pixels wins, so black,
            // near-black, and gray/muddy tones only get used as an
            // absolute last resort instead of by default.
            var BUCKET = 24;
            var tiers = [
              { minL: 0.16, maxL: 0.90, minS: 0.28 }, // vibrant colors only
              { minL: 0.12, maxL: 0.93, minS: 0.16 }, // relax saturation a bit
              { minL: 0.08, maxL: 0.96, minS: 0.06 }, // relax further, still not pure black/white
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
                // weight by saturation so a smaller-but-more-colorful
                // cluster can beat a larger-but-duller one
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
              // truly monochrome cover (grayscale/black-and-white art) —
              // fall back to the plain average rather than crashing
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

const FONT_REGULAR = 'Poppins_400Regular';
const FONT_MEDIUM = 'Poppins_500Medium';
const FONT_SEMIBOLD = 'Poppins_600SemiBold';
const FONT_BOLD = 'Poppins_700Bold';

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
  loadingText: { color: COLORS.gray, marginTop: 12, fontFamily: FONT_MEDIUM, fontSize: 13 },

  headerRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  headerTitle: { color: COLORS.white, fontFamily: FONT_BOLD, fontSize: 26 },

  // Track List
  trackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  trackCoverImage: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  trackArt: {
    width: 56,
    height: 56,
    borderRadius: 8,
    backgroundColor: COLORS.card,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trackArtGlyph: { color: COLORS.grayDim, fontSize: 18 },
  trackTitle: { color: COLORS.white, fontFamily: FONT_MEDIUM, fontSize: 15 },
  trackTitleActive: { color: COLORS.green },
  trackSubtitle: { color: COLORS.grayDim, fontFamily: FONT_REGULAR, fontSize: 12, marginTop: 2 },
  nowPlayingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.green },

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
  miniTitle: { color: COLORS.white, fontFamily: FONT_MEDIUM, fontSize: 14 },
  miniSubtitle: { color: COLORS.gray, fontFamily: FONT_REGULAR, fontSize: 11, marginTop: 1 },

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
  fullPlayerHeaderLabel: { color: COLORS.gray, fontFamily: FONT_SEMIBOLD, fontSize: 12, letterSpacing: 1 },

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
  fullTrackTitle: { color: COLORS.white, fontFamily: FONT_BOLD, fontSize: 22 },
  fullTrackArtist: { color: COLORS.gray, fontFamily: FONT_REGULAR, fontSize: 14, marginTop: 4 },

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
  timeText: { color: COLORS.grayDim, fontFamily: FONT_REGULAR, fontSize: 11 },

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
    fontFamily: FONT_BOLD,
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
    fontFamily: FONT_BOLD,
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
    fontFamily: FONT_REGULAR,
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
    fontFamily: FONT_BOLD,
    fontSize: 18,
  },
  expandedLyricLine: {
    fontFamily: FONT_BOLD,
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