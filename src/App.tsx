import { useEffect, useMemo, useRef, useState } from "react";
import { connectChat, type ChatConnection } from "./lib/chat";
import { findChannel } from "./lib/channel";
import { drawViewer, selectEligibleViewers } from "./lib/draw";
import { speakMessage, stopSpeaking } from "./lib/speech";
import {
  drawVoteOption,
  findMergeTargetOption,
  normalizeVoteLabel,
  parseVoteMessage,
} from "./lib/voteRoulette";
import type {
  Channel,
  DrawOptions,
  DrawResult,
  Viewer,
  VoteOption,
  VoteRouletteResult,
} from "./types";

const CHANNEL_STORAGE_KEY = "fair-chzzk-draw-channel";
const TTS_STORAGE_KEY = "fair-chzzk-draw-tts";
const SHOW_TEST_PLAIN_CHAT_TOGGLE = true;

interface TtsSettings {
  enabled: boolean;
}

type Screen = "ready" | "collecting" | "completed";
type ChatStatus = "idle" | "connecting" | "connected" | "error";
type AppTabId = "viewer-draw" | "free-vote-roulette";
type ViewerVote = {
  optionId: string;
  viewer: Viewer;
};

const APP_TABS: Array<{
  id: AppTabId;
  label: string;
}> = [
  {
    id: "viewer-draw",
    label: "시청자 추첨",
  },
];

APP_TABS.push({
  id: "free-vote-roulette",
  label: "자유투표 룰렛",
});

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
      : { enabled: true };
  } catch {
    return { enabled: true };
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
  const [activeTab, setActiveTab] = useState<AppTabId>("viewer-draw");
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
  const [timerMinutes, setTimerMinutes] = useState(1);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [notice, setNotice] = useState("");
  const [ttsSettings, setTtsSettings] =
    useState<TtsSettings>(readStoredTtsSettings);
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
    setRemainingSeconds(timerEnabled ? timerMinutes * 60 : null);

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

  async function restartCollecting() {
    disconnect();
    await startCollecting();
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
  const remainingTimeText = useMemo(() => {
    if (remainingSeconds === null) return "";

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [remainingSeconds]);
  const activeTabLabel =
    APP_TABS.find((tab) => tab.id === activeTab)?.label ?? APP_TABS[0].label;

  return (
    <div className="app-shell">
      <header>
        <div className="header-inner">
          <div>
            <p className="eyebrow">FAIR CHZZK DRAW</p>
            <h1>{activeTabLabel}</h1>
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
        <nav className="tab-list" aria-label="기능 선택">
          {APP_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === "viewer-draw" ? (
          <ViewerDrawTab
            chatStatus={chatStatus}
            eligibleCount={eligibleCount}
            notice={notice}
            options={options}
            participants={participants}
            remainingSeconds={remainingSeconds}
            remainingTimeText={remainingTimeText}
            screen={screen}
            timerEnabled={timerEnabled}
            timerMinutes={timerMinutes}
            ttsEnabled={ttsSettings.enabled}
            winners={winners}
            onRestartCollecting={restartCollecting}
            onRunDraw={runDraw}
            onSetOptions={setOptions}
            onSetTimerEnabled={setTimerEnabled}
            onSetTimerMinutes={setTimerMinutes}
            onSetTtsEnabled={(enabled) => setTtsSettings({ enabled })}
            onStartCollecting={startCollecting}
            onStopCollecting={stopCollecting}
          />
        ) : null}
        {activeTab === "free-vote-roulette" ? (
          <FreeVoteRouletteTab channelId={channel.channelId} />
        ) : null}
      </main>

      <footer className="footer">
        <a
          href="https://app.notion.com/p/3863cf2579488068af61c6a651658b6c?source=copy_link"
          target="_blank"
          rel="noreferrer"
        >
          개인정보 처리방침
        </a>
        <a
          href="https://github.com/OriNyam/Chzz-Lottery-Page"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </footer>

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

function ViewerDrawTab({
  chatStatus,
  eligibleCount,
  notice,
  options,
  participants,
  remainingSeconds,
  remainingTimeText,
  screen,
  timerEnabled,
  timerMinutes,
  ttsEnabled,
  winners,
  onRestartCollecting,
  onRunDraw,
  onSetOptions,
  onSetTimerEnabled,
  onSetTimerMinutes,
  onSetTtsEnabled,
  onStartCollecting,
  onStopCollecting,
}: {
  chatStatus: ChatStatus;
  eligibleCount: number;
  notice: string;
  options: DrawOptions;
  participants: Viewer[];
  remainingSeconds: number | null;
  remainingTimeText: string;
  screen: Screen;
  timerEnabled: boolean;
  timerMinutes: number;
  ttsEnabled: boolean;
  winners: Viewer[];
  onRestartCollecting: () => void;
  onRunDraw: () => void;
  onSetOptions: React.Dispatch<React.SetStateAction<DrawOptions>>;
  onSetTimerEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  onSetTimerMinutes: React.Dispatch<React.SetStateAction<number>>;
  onSetTtsEnabled: (enabled: boolean) => void;
  onStartCollecting: () => void;
  onStopCollecting: () => void;
}) {
  return (
    <>
      <section className="toolbar card">
        <div className="toolbar-buttons">
          {screen === "ready" ? (
            <button className="primary large" onClick={onStartCollecting}>
              참여자 모집 시작
            </button>
          ) : null}
          {screen === "collecting" ? (
            <>
              <button className="primary large" onClick={onRunDraw}>
                추첨하기
              </button>
              <button className="secondary large" onClick={onStopCollecting}>
                참여자 모집 종료
              </button>
            </>
          ) : null}
          {screen === "completed" ? (
            <>
              <button className="primary large" onClick={onRunDraw}>
                추첨하기
              </button>
              <button className="secondary large" onClick={onRestartCollecting}>
                참여자 다시 모집하기
              </button>
            </>
          ) : null}
        </div>

        <div className="option-grid">
          <Toggle
            label="구독자만 추첨하기"
            checked={options.subscriberOnly}
            onChange={() =>
              onSetOptions((current) => ({
                ...current,
                subscriberOnly: !current.subscriberOnly,
              }))
            }
          />
          <Toggle
            label="이미 당첨된 시청자 제외하기"
            checked={options.excludePreviousWinners}
            onChange={() =>
              onSetOptions((current) => ({
                ...current,
                excludePreviousWinners: !current.excludePreviousWinners,
              }))
            }
          />
          <div className="timer-option">
            <Toggle
              label="타이머 사용하기"
              checked={timerEnabled}
              onChange={() => onSetTimerEnabled((enabled) => !enabled)}
            />
            {timerEnabled ? (
              <label>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={timerMinutes}
                  onChange={(event) => {
                    const value = Math.floor(Number(event.target.value));
                    onSetTimerMinutes(
                      Number.isFinite(value) && value > 0 ? value : 1
                    );
                  }}
                  onKeyDown={(event) => {
                    if ([".", ",", "e", "E", "+", "-"].includes(event.key)) {
                      event.preventDefault();
                    }
                  }}
                />
                <span>분</span>
              </label>
            ) : null}
          </div>
          <Toggle
            label="TTS 사용"
            checked={ttsEnabled}
            onChange={() => onSetTtsEnabled(!ttsEnabled)}
          />
        </div>
      </section>

      {remainingSeconds !== null ? (
        <div className="timer">{remainingTimeText}</div>
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
    </>
  );
}

function FreeVoteRouletteTab({ channelId }: { channelId: string }) {
  const [screen, setScreen] = useState<Screen>("ready");
  const [subscriberOnly, setSubscriberOnly] = useState(false);
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState(1);
  const [acceptPlainChatForTest, setAcceptPlainChatForTest] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [chatStatus, setChatStatus] = useState<ChatStatus>("idle");
  const [notice, setNotice] = useState("");
  const [options, setOptions] = useState<VoteOption[]>([]);
  const [result, setResult] = useState<VoteRouletteResult | null>(null);
  const [rouletteOpen, setRouletteOpen] = useState(false);
  const optionMapRef = useRef(new Map<string, VoteOption>());
  const viewerVoteMapRef = useRef(new Map<string, ViewerVote>());
  const flushTimeoutRef = useRef<number | null>(null);
  const connectionRef = useRef<ChatConnection | null>(null);
  const subscriberOnlyRef = useRef(subscriberOnly);
  const acceptPlainChatForTestRef = useRef(acceptPlainChatForTest);

  useEffect(() => {
    subscriberOnlyRef.current = subscriberOnly;
  }, [subscriberOnly]);

  useEffect(() => {
    acceptPlainChatForTestRef.current =
      SHOW_TEST_PLAIN_CHAT_TOGGLE && acceptPlainChatForTest;
  }, [acceptPlainChatForTest]);

  function flushOptions() {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    setOptions([...optionMapRef.current.values()]);
  }

  function scheduleOptionFlush() {
    if (flushTimeoutRef.current !== null) return;
    flushTimeoutRef.current = window.setTimeout(flushOptions, 120);
  }

  function syncOptionFromVotes(optionId: string) {
    const option = optionMapRef.current.get(optionId);
    if (!option) return;

    const voters = [...viewerVoteMapRef.current.values()]
      .filter((vote) => vote.optionId === optionId)
      .map((vote) => vote.viewer);

    if (voters.length === 0) {
      optionMapRef.current.delete(optionId);
      return;
    }

    optionMapRef.current.set(optionId, {
      ...option,
      author: voters[0],
      count: voters.length,
      voters,
    });
  }

  function addVoteOption(viewer: Viewer, message: string) {
    if (subscriberOnlyRef.current && !viewer.subscribe) return;

    const label = parseVoteMessage(message, acceptPlainChatForTestRef.current);
    if (!label) return;

    const previousVote = viewerVoteMapRef.current.get(viewer.userIdHash);
    if (previousVote) {
      viewerVoteMapRef.current.delete(viewer.userIdHash);
      syncOptionFromVotes(previousVote.optionId);
    }

    const exactId = normalizeVoteLabel(label);
    const exactOption = optionMapRef.current.get(exactId);
    const mergeTarget =
      exactOption ??
      findMergeTargetOption(label, [...optionMapRef.current.values()]);
    const optionId = mergeTarget?.id ?? exactId;

    if (!mergeTarget) {
      optionMapRef.current.set(optionId, {
        id: optionId,
        label,
        author: viewer,
        count: 0,
        voters: [],
      });
    }

    viewerVoteMapRef.current.set(viewer.userIdHash, {
      optionId,
      viewer,
    });
    syncOptionFromVotes(optionId);

    setNotice("");

    scheduleOptionFlush();
  }

  function disconnect() {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setChatStatus("idle");
  }

  async function startCollecting() {
    setNotice("");
    setResult(null);
    optionMapRef.current = new Map();
    viewerVoteMapRef.current = new Map();
    setOptions([]);
    setChatStatus("connecting");
    setScreen("collecting");
    setRemainingSeconds(timerEnabled ? timerMinutes * 60 : null);

    try {
      connectionRef.current = await connectChat(
        channelId,
        addVoteOption,
        (status) => setChatStatus(status)
      );
    } catch {
      setChatStatus("error");
      setNotice("채팅 연결에 실패했습니다. 방송 상태를 확인한 뒤 다시 시작해주세요.");
    }
  }

  function stopCollecting() {
    disconnect();
    flushOptions();
    setRemainingSeconds(null);
    setScreen("completed");
  }

  function runRoulette() {
    flushOptions();

    try {
      const nextResult = drawVoteOption([...optionMapRef.current.values()]);
      setResult(nextResult);
      setRouletteOpen(true);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "룰렛 추첨에 실패했습니다.");
    }
  }

  async function restartCollecting() {
    disconnect();
    await startCollecting();
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
    return () => {
      connectionRef.current?.disconnect();
      if (flushTimeoutRef.current !== null) {
        window.clearTimeout(flushTimeoutRef.current);
      }
    };
  }, []);

  const remainingTimeText = useMemo(() => {
    if (remainingSeconds === null) return "";

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }, [remainingSeconds]);

  return (
    <>
      <section className="toolbar card">
        <div className="toolbar-buttons">
          {screen === "ready" ? (
            <button className="primary large" onClick={startCollecting}>
              투표 모집 시작
            </button>
          ) : null}
          {screen === "collecting" ? (
            <button className="secondary large" onClick={stopCollecting}>
              투표 모집 종료
            </button>
          ) : null}
          {screen === "completed" ? (
            <>
              <button className="primary large" onClick={runRoulette}>
                룰렛 돌리기
              </button>
              <button className="secondary large" onClick={restartCollecting}>
                투표 다시 모집하기
              </button>
            </>
          ) : null}
        </div>

        <div className="option-grid">
          <Toggle
            label="구독자만 받기"
            checked={subscriberOnly}
            onChange={() => setSubscriberOnly((enabled) => !enabled)}
          />
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
                  inputMode="numeric"
                  min="1"
                  step="1"
                  value={timerMinutes}
                  onChange={(event) => {
                    const value = Math.floor(Number(event.target.value));
                    setTimerMinutes(
                      Number.isFinite(value) && value > 0 ? value : 1
                    );
                  }}
                  onKeyDown={(event) => {
                    if ([".", ",", "e", "E", "+", "-"].includes(event.key)) {
                      event.preventDefault();
                    }
                  }}
                />
                <span>분</span>
              </label>
            ) : null}
          </div>
          {SHOW_TEST_PLAIN_CHAT_TOGGLE ? (
            <Toggle
              label="테스트용 일반채팅 참가"
              checked={acceptPlainChatForTest}
              onChange={() => setAcceptPlainChatForTest((enabled) => !enabled)}
            />
          ) : null}
        </div>
      </section>

      {remainingSeconds !== null ? (
        <div className="timer">{remainingTimeText}</div>
      ) : null}

      {notice ? <p className="notice">{notice}</p> : null}

      <section className="card roulette-preview-card">
        <div className="section-title">
          <div>
            <h2>실시간 룰렛</h2>
            <p className="muted">
              채팅에 !오리처럼 느낌표를 붙여 말하면 후보로 들어갑니다.
            </p>
          </div>
        </div>
        <VoteRouletteWheel options={options} />
      </section>

      {result ? (
        <section className="card history">
          <h2>최근 룰렛 결과</h2>
          <div className="vote-winner-summary">
            <strong>{result.winner.label}</strong>
            <span>후보 {result.candidates.length}개 중 당첨</span>
          </div>
        </section>
      ) : null}

      {rouletteOpen && result ? (
        <VoteRouletteModal
          result={result}
          onClose={() => setRouletteOpen(false)}
        />
      ) : null}
    </>
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
  className = "",
}: {
  viewer: Viewer;
  inactive?: boolean;
  prefix?: string;
  className?: string;
}) {
  return (
    <div className={`viewer-chip ${inactive ? "inactive" : ""} ${className}`}>
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
          void speakMessage(message);
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
                    <ViewerChip viewer={viewer} className="slot-viewer-chip" />
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="winner">
            <p className="eyebrow">WINNER</p>
            <ViewerChip viewer={result.winner} className="winner-viewer-chip" />
            <p>후보 {result.candidates.length}명 중 추첨되었습니다.</p>
            <div className="winner-chat">
              <div className="winner-chat-title">
                <strong>당첨자 채팅</strong>
                <Status status={winnerChatStatus} />
              </div>
              <div className="winner-chat-messages">
                {messages.length === 0 ? (
                  <p className="small muted">당첨자 채팅 대기 중입니다.</p>
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

function VoteRouletteWheel({
  options,
  spinning = false,
  winnerId,
}: {
  options: readonly VoteOption[];
  spinning?: boolean;
  winnerId?: string;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const wheelItems = options;
  const selectedOption =
    wheelItems.find((option) => option.id === selectedOptionId) ?? null;
  const radius = 170;
  const center = 180;
  const winnerIndex = Math.max(
    0,
    wheelItems.findIndex((option) => option.id === winnerId)
  );
  const sliceAngle = wheelItems.length > 0 ? 360 / wheelItems.length : 0;
  const winnerCenterAngle = winnerIndex * sliceAngle + sliceAngle / 2;
  const spinDegrees = 360 * 6 - winnerCenterAngle;
  const labelFontSize = Math.max(7, Math.min(15, 280 / Math.max(1, wheelItems.length)));
  const labelRadius = wheelItems.length > 24 ? radius * 0.72 : radius * 0.62;

  useEffect(() => {
    if (
      selectedOptionId &&
      !wheelItems.some((option) => option.id === selectedOptionId)
    ) {
      setSelectedOptionId(null);
    }
  }, [selectedOptionId, wheelItems]);

  function describeSlice(startAngle: number, endAngle: number) {
    const start = polarToCartesian(center, center, radius, endAngle);
    const end = polarToCartesian(center, center, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

    return [
      `M ${center} ${center}`,
      `L ${start.x} ${start.y}`,
      `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
      "Z",
    ].join(" ");
  }

  return (
    <div className="roulette-wheel-area">
      <div className="roulette-pointer-label">
        <span>당첨</span>
        <i className="roulette-pointer" />
      </div>
      <div className="roulette-wheel-wrap">
        <div
          className={`roulette-wheel ${spinning ? "spinning" : ""}`}
          style={
            spinning
              ? ({ "--spin-degrees": `${spinDegrees}deg` } as React.CSSProperties)
              : undefined
          }
        >
          <svg viewBox="0 0 360 360" role="img" aria-label="자유투표 룰렛">
            {wheelItems.length === 0 ? (
              <circle className="roulette-empty-slice" cx={center} cy={center} r={radius} />
            ) : (
              wheelItems.map((option, index) => {
                const startAngle = index * sliceAngle;
                const endAngle = startAngle + sliceAngle;
                const labelAngle = startAngle + sliceAngle / 2;
                const labelPosition = polarToCartesian(
                  center,
                  center,
                  labelRadius,
                  labelAngle
                );
                const isSingleOption = wheelItems.length === 1;

                function toggleOption() {
                  if (spinning) return;
                  setSelectedOptionId((current) =>
                    current === option.id ? null : option.id
                  );
                }

                return (
                  <g
                    key={`${option.id}-${index}`}
                    className="roulette-slice-button"
                    role="button"
                    tabIndex={spinning ? -1 : 0}
                    aria-label={`${option.label} 투표자 보기`}
                    onClick={toggleOption}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        toggleOption();
                      }
                    }}
                  >
                      <path
                        className={`roulette-slice ${
                          selectedOptionId === option.id ? "selected" : ""
                        }`}
                        d={
                          isSingleOption
                            ? `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center - 0.1} ${center - radius} Z`
                            : describeSlice(startAngle, endAngle)
                        }
                        style={{
                          fill: `hsl(${(index * 47) % 360} 76% 42%)`,
                        }}
                      />
                    <text
                      className="roulette-label"
                      x={labelPosition.x}
                      y={labelPosition.y}
                      transform={`rotate(${labelAngle} ${labelPosition.x} ${labelPosition.y})`}
                      style={{ fontSize: labelFontSize }}
                    >
                      {option.label}
                    </text>
                  </g>
                );
              })
            )}
          </svg>
        </div>
        {wheelItems.length === 0 ? (
          <div className="roulette-empty-label">후보 대기</div>
        ) : null}
        <div className="roulette-center">{options.length || "?"}</div>
      </div>
      {selectedOption ? (
        <div className="roulette-tooltip">
          <strong>{selectedOption.label}</strong>
          <div className="roulette-voter-list">
            {selectedOption.voters.map((viewer) => (
              <ViewerChip key={viewer.userIdHash} viewer={viewer} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;

  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function VoteRouletteModal({
  result,
  onClose,
}: {
  result: VoteRouletteResult;
  onClose: () => void;
}) {
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setComplete(true), 3_600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="modal-backdrop">
      <section className={`roulette-modal ${complete ? "complete" : ""}`}>
        {!complete ? (
          <>
            <VoteRouletteWheel
              options={result.shuffledCandidates}
              spinning
              winnerId={result.winner.id}
            />
          </>
        ) : (
          <div className="roulette-winner">
            <div className="fanfare" aria-hidden="true">
              {Array.from({ length: 24 }, (_, index) => (
                <i key={index} style={{ "--i": index } as React.CSSProperties} />
              ))}
            </div>
            <p className="eyebrow">ROULETTE WINNER</p>
            <strong>{result.winner.label}</strong>
            <p>후보 {result.candidates.length}개 중 당첨되었습니다.</p>
            <div className="roulette-author">
              <span>처음 등록한 시청자</span>
              <ViewerChip viewer={result.winner.author} />
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
