import { useEffect, useMemo, useRef, useState } from "react";
import { connectChat, type ChatConnection } from "./lib/chat";
import { findChannel } from "./lib/channel";
import { drawViewer, selectEligibleViewers } from "./lib/draw";
import { getSystemVoices, speakMessage, stopSpeaking } from "./lib/speech";
import type { Channel, DrawOptions, DrawResult, Viewer } from "./types";

const CHANNEL_STORAGE_KEY = "fair-chzzk-draw-channel";
const TTS_STORAGE_KEY = "fair-chzzk-draw-tts";

interface TtsSettings {
  enabled: boolean;
  voiceName: string;
}

type Screen = "ready" | "collecting" | "completed";
type ChatStatus = "idle" | "connecting" | "connected" | "error";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function readStoredChannel(): Channel | null {
  try {
    const stored = localStorage.getItem(CHANNEL_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Channel) : null;
  } catch {
    return null;
  }
}

function readStoredTtsSettings(): TtsSettings {
  try {
    const stored = localStorage.getItem(TTS_STORAGE_KEY);
    return stored
      ? (JSON.parse(stored) as TtsSettings)
      : { enabled: true, voiceName: "" };
  } catch {
    return { enabled: true, voiceName: "" };
  }
}

function App() {
  const [channel, setChannel] = useState<Channel | null>(readStoredChannel);

  if (!channel) {
    return (
      <ChannelRegistration
        onRegistered={(nextChannel) => {
          localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(nextChannel));
          setChannel(nextChannel);
        }}
      />
    );
  }

  return (
    <DrawApp
      channel={channel}
      onChangeChannel={() => {
        localStorage.removeItem(CHANNEL_STORAGE_KEY);
        setChannel(null);
      }}
    />
  );
}

function ChannelRegistration({
  onRegistered,
}: {
  onRegistered: (channel: Channel) => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const channel = await findChannel(input);
      if (!channel) {
        setError("유효한 치지직 채널 주소 또는 32자리 채널 ID를 입력해주세요.");
        return;
      }
      onRegistered(channel);
    } catch {
      setError("채널을 조회하지 못했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="registration page">
      <section className="registration-card">
        <div className="brand-mark">F</div>
        <p className="eyebrow">FAIR CHZZK DRAW</p>
        <h1>안녕하세요!<br />처음 오셨나요?</h1>
        <p className="muted">
          추첨을 진행할 치지직 채널의 주소(URL)를 알려주세요.
        </p>
        <form className="channel-form" onSubmit={handleSubmit}>
          <input
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="https://chzzk.naver.com/채널ID"
          />
          <button className="primary" disabled={loading}>
            {loading ? "확인 중" : "등록"}
          </button>
        </form>
        {error ? <p className="error">{error}</p> : null}
        <p className="small muted">
          채널 ID를 직접 입력해도 괜찮습니다.<br />
          설정 데이터는 현재 브라우저에만 저장됩니다.
        </p>
        <div className="fairness-note">
          <strong>공정 추첨 엔진</strong>
          <span>CSPRNG + Fisher-Yates + rejection sampling</span>
        </div>
      </section>
    </main>
  );
}

function DrawApp({
  channel,
  onChangeChannel,
}: {
  channel: Channel;
  onChangeChannel: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("ready");
  const [options, setOptions] = useState<DrawOptions>({
    subscriberOnly: false,
    excludePreviousWinners: false,
  });
  const [participants, setParticipants] = useState<Viewer[]>([]);
  const [winners, setWinners] = useState<Viewer[]>([]);
  const [result, setResult] = useState<DrawResult | null>(null);
  const [slotOpen, setSlotOpen] = useState(false);
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(60);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [notice, setNotice] = useState("");
  const [ttsSettings, setTtsSettings] =
    useState<TtsSettings>(readStoredTtsSettings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const participantMapRef = useRef(new Map<string, Viewer>());
  const flushTimeoutRef = useRef<number | null>(null);
  const connectionRef = useRef<ChatConnection | null>(null);

  function flushParticipants() {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    setParticipants([...participantMapRef.current.values()]);
  }

  function scheduleParticipantFlush() {
    if (flushTimeoutRef.current !== null) return;
    flushTimeoutRef.current = window.setTimeout(flushParticipants, 120);
  }

  function addParticipant(viewer: Viewer) {
    if (participantMapRef.current.has(viewer.userIdHash)) return;
    participantMapRef.current.set(viewer.userIdHash, viewer);
    scheduleParticipantFlush();
  }

  function disconnect() {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setChatStatus("idle");
  }

  async function startCollecting() {
    setNotice("");
    setResult(null);
    participantMapRef.current = new Map();
    setParticipants([]);
    setChatStatus("connecting");
    setScreen("collecting");
    setRemainingSeconds(timerEnabled ? timerSeconds : null);

    try {
      connectionRef.current = await connectChat(
        channel.channelId,
        (viewer) => addParticipant(viewer),
        (status) => setChatStatus(status)
      );
    } catch {
      setChatStatus("error");
      setNotice("채팅 연결에 실패했습니다. 방송 상태를 확인한 뒤 다시 시작해주세요.");
    }
  }

  function stopCollecting() {
    disconnect();
    flushParticipants();
    setRemainingSeconds(null);
    setScreen("completed");
  }

  function runDraw() {
    flushParticipants();

    try {
      const nextResult = drawViewer(
        [...participantMapRef.current.values()],
        winners,
        options
      );
      setResult(nextResult);
      setWinners((current) => [...current, nextResult.winner]);
      setSlotOpen(true);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "추첨에 실패했습니다.");
    }
  }

  function resetParticipants() {
    disconnect();
    participantMapRef.current = new Map();
    setParticipants([]);
    setResult(null);
    setRemainingSeconds(null);
    setScreen("ready");
  }

  useEffect(() => {
    if (remainingSeconds === null || screen !== "collecting") return;
    if (remainingSeconds <= 0) {
      stopCollecting();
      return;
    }

    const timer = window.setTimeout(
      () => setRemainingSeconds((current) => (current ?? 1) - 1),
      1_000
    );
    return () => window.clearTimeout(timer);
  }, [remainingSeconds, screen]);

  useEffect(() => {
    void getSystemVoices().then(setVoices);
  }, []);

  useEffect(() => {
    localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(ttsSettings));
  }, [ttsSettings]);

  useEffect(() => {
    return () => {
      connectionRef.current?.disconnect();
      if (flushTimeoutRef.current !== null) {
        window.clearTimeout(flushTimeoutRef.current);
      }
    };
  }, []);

  const eligibleCount = useMemo(
    () => selectEligibleViewers(participants, winners, options).length,
    [participants, winners, options]
  );

  return (
    <div className="app-shell">
      <header>
        <div className="header-inner">
          <div>
            <p className="eyebrow">FAIR CHZZK DRAW</p>
            <h1>시청자 추첨</h1>
          </div>
          <div className="channel">
            {channel.channelImageUrl ? (
              <img src={channel.channelImageUrl} alt="" />
            ) : (
              <div className="channel-placeholder" />
            )}
            <div>
              <strong>{channel.channelName}</strong>
              <span>팔로워 {formatNumber(channel.followerCount)}명</span>
            </div>
            <button className="text-button" onClick={onChangeChannel}>
              채널 변경
            </button>
          </div>
        </div>
      </header>

      <main className="content">
        <section className="toolbar card">
          <div className="toolbar-buttons">
            {screen === "ready" ? (
              <button className="primary large" onClick={startCollecting}>
                참여자 모집 시작
              </button>
            ) : null}
            {screen === "collecting" ? (
              <>
                <button className="secondary large" onClick={runDraw}>
                  추첨하기
                </button>
                <button className="primary large" onClick={stopCollecting}>
                  참여자 모집 종료
                </button>
              </>
            ) : null}
            {screen === "completed" ? (
              <>
                <button className="secondary large" onClick={resetParticipants}>
                  참여자 다시 모집하기
                </button>
                <button className="primary large" onClick={runDraw}>
                  추첨하기
                </button>
              </>
            ) : null}
          </div>

          <div className="option-grid">
            <Toggle
              label="구독자만 추첨하기"
              checked={options.subscriberOnly}
              onChange={() =>
                setOptions((current) => ({
                  ...current,
                  subscriberOnly: !current.subscriberOnly,
                }))
              }
            />
            <Toggle
              label="이미 당첨된 시청자 제외하기"
              checked={options.excludePreviousWinners}
              onChange={() =>
                setOptions((current) => ({
                  ...current,
                  excludePreviousWinners: !current.excludePreviousWinners,
                }))
              }
            />
            {screen === "ready" ? (
              <div className="timer-option">
                <Toggle
                  label="타이머 사용하기"
                  checked={timerEnabled}
                  onChange={() => setTimerEnabled((enabled) => !enabled)}
                />
                {timerEnabled ? (
                  <label>
                    <input
                      type="number"
                      min="1"
                      value={timerSeconds}
                      onChange={(event) =>
                        setTimerSeconds(
                          Math.max(1, Number.parseInt(event.target.value) || 1)
                        )
                      }
                    />
                    <span>초</span>
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
          <TtsControls
            settings={ttsSettings}
            voices={voices}
            onChange={setTtsSettings}
          />
        </section>

        {remainingSeconds !== null ? (
          <div className="timer">{remainingSeconds}초</div>
        ) : null}

        {notice ? <p className="notice">{notice}</p> : null}

        <section className="participant-layout">
          <div className="card participants-card">
            <div className="section-title">
              <div>
                <h2>참여자 목록</h2>
                <p className="muted">
                  {screen === "collecting"
                    ? "채팅창에 아무 말이나 입력하면 참여됩니다."
                    : "모집을 시작하면 채팅 참여자가 여기에 표시됩니다."}
                </p>
              </div>
              <Status status={chatStatus} />
            </div>
            <div className="participants">
              {participants.length === 0 ? (
                <div className="empty">아직 참여자가 없습니다.</div>
              ) : (
                participants.map((viewer) => (
                  <ViewerChip
                    key={viewer.userIdHash}
                    viewer={viewer}
                    inactive={
                      (options.subscriberOnly && !viewer.subscribe) ||
                      (options.excludePreviousWinners &&
                        winners.some(
                          (winner) => winner.userIdHash === viewer.userIdHash
                        ))
                    }
                  />
                ))
              )}
            </div>
            <div className="participant-footer">
              <span>총 {participants.length}명</span>
              <span>현재 추첨 가능 {eligibleCount}명</span>
            </div>
          </div>

          <aside className="card fairness-card">
            <p className="eyebrow">FAIRNESS ENGINE</p>
            <h2>공정 추첨 방식</h2>
            <ol>
              <li>Web Crypto API CSPRNG 사용</li>
              <li>rejection sampling으로 모듈로 편향 제거</li>
              <li>Fisher-Yates 방식으로 전체 후보 셔플</li>
              <li>셔플 결과의 첫 번째 시청자를 당첨자로 선정</li>
            </ol>
            <p className="small muted">
              슬롯 애니메이션은 연출이며, 당첨자는 먼저 계산됩니다.
            </p>
          </aside>
        </section>

        {winners.length > 0 ? (
          <section className="card history">
            <h2>당첨 이력</h2>
            <div className="winner-list">
              {winners.map((winner, index) => (
                <ViewerChip
                  key={`${winner.userIdHash}-${index}`}
                  viewer={winner}
                  prefix={`${index + 1}.`}
                />
              ))}
            </div>
          </section>
        ) : null}
      </main>

      {slotOpen && result ? (
        <SlotModal
          channelId={channel.channelId}
          result={result}
          ttsSettings={ttsSettings}
          onClose={() => setSlotOpen(false)}
        />
      ) : null}
    </div>
  );
}

function TtsControls({
  settings,
  voices,
  onChange,
}: {
  settings: TtsSettings;
  voices: SpeechSynthesisVoice[];
  onChange: (settings: TtsSettings) => void;
}) {
  const koreanVoices = voices.filter((voice) => voice.lang === "ko-KR");
  const selectableVoices = koreanVoices.length > 0 ? koreanVoices : voices;

  return (
    <div className="tts-controls">
      <div>
        <strong>당첨자 채팅 TTS</strong>
        <p className="small muted">
          당첨자가 입력한 채팅을 결과 창에서 읽어줍니다.
        </p>
      </div>
      <Toggle
        label="TTS 사용"
        checked={settings.enabled}
        onChange={() => onChange({ ...settings, enabled: !settings.enabled })}
      />
      <select
        aria-label="TTS 음성"
        disabled={!settings.enabled || selectableVoices.length === 0}
        value={settings.voiceName}
        onChange={(event) =>
          onChange({ ...settings, voiceName: event.target.value })
        }
      >
        <option value="">한국어 기본 음성</option>
        {selectableVoices.map((voice) => (
          <option key={voice.voiceURI} value={voice.name}>
            {voice.name} ({voice.lang})
          </option>
        ))}
      </select>
      <button
        className="text-button tts-test"
        disabled={!settings.enabled}
        onClick={() =>
          void speakMessage(settings.voiceName, "TTS 음성 테스트입니다.")
        }
      >
        음성 테스트
      </button>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="toggle-control" />
      <span>{label}</span>
    </label>
  );
}

function Status({ status }: { status: ChatStatus }) {
  const labels: Record<ChatStatus, string> = {
    idle: "연결 대기",
    connecting: "연결 중",
    connected: "채팅 연결됨",
    error: "연결 오류",
  };

  return <span className={`status ${status}`}>{labels[status]}</span>;
}

function ViewerChip({
  viewer,
  inactive = false,
  prefix,
}: {
  viewer: Viewer;
  inactive?: boolean;
  prefix?: string;
}) {
  return (
    <div className={`viewer-chip ${inactive ? "inactive" : ""}`}>
      {prefix ? <strong>{prefix}</strong> : null}
      {viewer.badges.map((badge, index) => (
        <img key={`${badge}-${index}`} src={badge} alt="" />
      ))}
      <span>{viewer.nickname}</span>
      {viewer.subscribe ? <b>구독</b> : null}
    </div>
  );
}

function SlotModal({
  channelId,
  result,
  ttsSettings,
  onClose,
}: {
  channelId: string;
  result: DrawResult;
  ttsSettings: TtsSettings;
  onClose: () => void;
}) {
  const animationList = useMemo(() => {
    const loops = Math.max(3, Math.ceil(24 / result.shuffledCandidates.length));
    return [
      ...Array.from({ length: loops }, () => result.shuffledCandidates).flat(),
      result.winner,
    ];
  }, [result]);
  const [complete, setComplete] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [winnerChatStatus, setWinnerChatStatus] =
    useState<ChatStatus>("connecting");

  useEffect(() => {
    const timer = window.setTimeout(() => setComplete(true), 2_800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!complete) return;

    let active = true;
    let connection: ChatConnection | null = null;

    void connectChat(
      channelId,
      (viewer, message) => {
        if (!active || viewer.userIdHash !== result.winner.userIdHash) return;
        setMessages((current) => [...current, message]);
        if (ttsSettings.enabled) {
          void speakMessage(ttsSettings.voiceName, message);
        }
      },
      (status) => {
        if (active) setWinnerChatStatus(status);
      }
    )
      .then((nextConnection) => {
        if (!active) {
          nextConnection.disconnect();
          return;
        }
        connection = nextConnection;
      })
      .catch(() => {
        if (active) setWinnerChatStatus("error");
      });

    return () => {
      active = false;
      connection?.disconnect();
      stopSpeaking();
    };
  }, [channelId, complete, result.winner.userIdHash, ttsSettings]);

  return (
    <div className="modal-backdrop">
      <section className={`slot-modal ${complete ? "complete" : ""}`}>
        {!complete ? (
          <>
            <p className="eyebrow">CSPRNG SHUFFLING</p>
            <div className="slot-window">
              <div className="slot-track">
                {animationList.map((viewer, index) => (
                  <div className="slot-row" key={`${viewer.userIdHash}-${index}`}>
                    {viewer.nickname}
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="winner">
            <p className="eyebrow">WINNER</p>
            <h2>{result.winner.nickname}</h2>
            <p>후보 {result.candidates.length}명 중 추첨되었습니다.</p>
            <div className="winner-chat">
              <div className="winner-chat-title">
                <strong>당첨자 채팅</strong>
                <Status status={winnerChatStatus} />
              </div>
              <div className="winner-chat-messages">
                {messages.length === 0 ? (
                  <p className="small muted">
                    당첨자가 채팅을 입력하면 이곳에 표시되고 TTS로 재생됩니다.
                  </p>
                ) : (
                  messages.map((message, index) => (
                    <p className="chat-balloon" key={`${index}-${message}`}>
                      {message}
                    </p>
                  ))
                )}
              </div>
            </div>
            <button className="primary large" onClick={onClose}>
              닫기
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
