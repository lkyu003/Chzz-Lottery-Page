import { ChzzkChat, type Profile } from "chzzk";
import type { Viewer } from "../types";

const BASE_URLS = {
  chzzkBaseUrl: "/api/proxy/chzzkBase",
  gameBaseUrl: "/api/proxy/gameBase",
};

function profileToViewer(profile: Profile): Viewer {
  const badges: string[] = [];

  if (profile.badge?.imageUrl) badges.push(profile.badge.imageUrl);
  if (profile.streamingProperty.subscription?.badge.imageUrl) {
    badges.push(profile.streamingProperty.subscription.badge.imageUrl);
  }
  for (const badge of profile.activityBadges ?? []) {
    if (badge.imageUrl) badges.push(badge.imageUrl);
  }

  return {
    userIdHash: profile.userIdHash,
    nickname: profile.nickname,
    badges,
    subscribe: Boolean(profile.streamingProperty.subscription),
  };
}

export interface ChatConnection {
  disconnect: () => void;
}

export async function connectChat(
  channelId: string,
  onChat: (viewer: Viewer, message: string) => void,
  onStatus: (status: "connected" | "error") => void
): Promise<ChatConnection> {
  const client = new ChzzkChat({
    channelId,
    pollInterval: 30_000,
    baseUrls: BASE_URLS,
  });

  client.on("connect", () => onStatus("connected"));
  client.on("chat", (chat) =>
    onChat(profileToViewer(chat.profile), chat.message)
  );

  try {
    await client.connect();
  } catch {
    onStatus("error");
    throw new Error("치지직 채팅 연결에 실패했습니다.");
  }

  return {
    disconnect: () => client.disconnect(),
  };
}
